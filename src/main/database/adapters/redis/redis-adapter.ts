import { createClient, RESP_TYPES } from 'redis';
import type { Connection } from '../../../../shared/types';
import type { SqlAdapter } from '../../adapter';
import { SocketTimeouts } from '../network/socket-timeouts';
import { captureClientSocket } from '../network/capture-client-socket';
import type { Socket } from 'node:net';
import { RedisTextCodec } from './text-codec';
export class RedisAdapter implements SqlAdapter {
  private client?: ReturnType<typeof createClient<{}, {}, {}, 2>>;
  private connecting?: Promise<void>;
  private ioTimeouts?: SocketTimeouts;
  private codec: RedisTextCodec;
  constructor(
    private connection: Connection,
    private password?: string,
  ) {
    this.codec = new RedisTextCodec(connection.charset);
  }
  async connect() {
    if (this.client?.isReady && !this.connecting) return;
    this.connecting ??= this.open();
    const pending = this.connecting;
    try {
      await pending;
    } finally {
      if (this.connecting === pending) this.connecting = undefined;
    }
  }
  private async open() {
    const database = Number(this.connection.database);
    if (!Number.isSafeInteger(database) || database < 0)
      throw new Error('Redis DB index must be a non-negative integer.');
    const socket = this.connection.tls
      ? {
          host: this.connection.host ?? 'localhost',
          port: this.connection.port ?? 6379,
          tls: true as const,
          rejectUnauthorized: true,
          connectTimeout: this.connection.connectionTimeout ?? 10000,
          reconnectStrategy: false as const,
        }
      : {
          host: this.connection.host ?? 'localhost',
          port: this.connection.port ?? 6379,
          connectTimeout: this.connection.connectionTimeout ?? 10000,
          reconnectStrategy: false as const,
        };
    const client = createClient({
      RESP: 2,
      socket,
      username: this.connection.username || undefined,
      password: this.password,
      database,
      disableOfflineQueue: true,
    });
    client.on('error', () => undefined);
    this.client = client;
    this.ioTimeouts = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Redis connection timed out.'));
            if (client.isOpen) client.destroy();
          }, this.connection.connectionTimeout ?? 10000);
        }),
      ]);
    };
    try {
      let transport: Socket | undefined;
      if (this.connection.readTimeout || this.connection.writeTimeout) {
        transport = (await captureClientSocket(connect)).socket;
      } else await connect();
      if (this.client !== client || !client.isReady) throw new Error('Redis connection is closed.');
      if (transport) this.ioTimeouts = new SocketTimeouts(transport, this.connection);
    } catch (error) {
      if (client.isOpen) client.destroy();
      if (this.client === client) this.client = undefined;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async disconnect() {
    const client = this.client;
    this.client = undefined;
    this.ioTimeouts = undefined;
    if (client?.isOpen) client.destroy();
    await this.connecting?.catch(() => undefined);
  }
  async command(command: string, args: string[], timeout = 30000): Promise<any> {
    if (!ALLOWED.has(command)) throw new Error('Unsupported Redis command.');
    if (command === 'CONFIG' && (args.length !== 2 || args[0] !== 'GET' || args[1] !== 'databases'))
      throw new Error('Unsupported Redis configuration command.');
    // Validate every argument before any bytes of a mutation reach the server.
    const encoded = this.codec.arguments(command, args);
    await this.connect();
    const client = this.client!;
    if (!client?.isReady) throw new Error('Redis connection is closed.');
    const release = this.ioTimeouts?.begin();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        client.sendCommand(encoded, { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (client.isOpen) client.destroy();
            if (this.client === client) this.client = undefined;
            reject(new Error('Redis command timed out.'));
          }, timeout);
        }),
      ]);
      return this.codec.reply(command, reply);
    } catch (error) {
      if (command.startsWith('JSON.') && /unknown command/i.test(String(error)))
        throw new Error(
          'This server does not support Redis JSON commands. Enable RedisJSON or use a Redis server with JSON support.',
        );
      throw error;
    } finally {
      release?.();
      clearTimeout(timer);
    }
  }
  async query(): Promise<never> {
    throw new Error('Use the Redis workspace instead of SQL.');
  }
  async heartbeat(timeout: number) {
    if (!this.client?.isReady) throw new Error('Redis connection is closed.');
    await this.command('PING', [], timeout);
  }
  async databases() {
    return (await this.databaseSummary()).databases.map((item) => item.database);
  }
  async databaseSummary() {
    const optional = async (name: string, args: string[]) => {
      try {
        return await this.command(name, args);
      } catch (error) {
        if (/NOPERM|unknown command|not allowed|disabled/i.test(String(error))) return undefined;
        throw error;
      }
    };
    const [config, info, cluster] = await Promise.all([
      optional('CONFIG', ['GET', 'databases']),
      optional('INFO', ['keyspace']),
      optional('INFO', ['cluster']),
    ]);
    const counts = new Map<string, number>();
    for (const match of String(info ?? '').matchAll(/^db(\d+):keys=(\d+)/gm))
      counts.set(match[1], Number(match[2]));
    const configuredCount = Number(config?.[1]);
    const isCluster = /cluster_enabled:1/.test(String(cluster));
    const inferred = !isCluster && !(configuredCount > 0);
    const count = isCluster
      ? 1
      : configuredCount > 0
        ? configuredCount
        : Math.max(
            16,
            Number(this.connection.database || '0') + 1,
            ...[...counts.keys()].map((id) => Number(id) + 1),
          );
    if (!Number.isSafeInteger(count) || count > 65536)
      throw new Error('Redis database count exceeds the browser limit.');
    return {
      inferred,
      databases: Array.from({ length: count }, (_, index) => ({
        database: String(index),
        keys: info === undefined ? null : (counts.get(String(index)) ?? 0),
      })),
    };
  }
  async schemas() {
    return [];
  }
  async tables() {
    return [];
  }
  async describe(): Promise<never> {
    throw new Error('Use redis.get to inspect keys.');
  }
}
const ALLOWED = new Set([
  'CONFIG',
  'INFO',
  'XRANGE',
  'XADD',
  'XDEL',
  'JSON.GET',
  'JSON.SET',
  'PING',
  'SCAN',
  'TYPE',
  'TTL',
  'STRLEN',
  'GET',
  'GETRANGE',
  'HSCAN',
  'SSCAN',
  'LRANGE',
  'LLEN',
  'ZRANGE',
  'ZCARD',
  'SET',
  'HSET',
  'HDEL',
  'LSET',
  'RPUSH',
  'SADD',
  'SREM',
  'ZADD',
  'ZREM',
  'DEL',
  'EXPIRE',
  'PERSIST',
]);
