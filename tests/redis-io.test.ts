import { it, expect } from 'vitest';
import { createServer, createConnection, type Socket } from 'node:net';
import { createServer as tlsServer, getCACertificates, setDefaultCACertificates } from 'node:tls';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Transform } from 'node:stream';
import { createClient } from 'redis';
import { captureClientSocket } from '../src/main/database/adapters/network/capture-client-socket';
import { RedisAdapter } from '../src/main/database/adapters/redis/redis-adapter';
import { connectionSchema } from '../src/shared/schemas';

it('isolates simultaneous socket capture scopes and rejects missing socket notifications', async () => {
  const peers = new Set<Socket>();
  const server = createServer((peer) => {
    peers.add(peer);
    peer.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const connect = async () => {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    return socket;
  };
  const clients: Socket[] = [];
  try {
    const [a, b, unrelated] = await Promise.all([
      captureClientSocket(connect),
      captureClientSocket(connect),
      connect(),
    ]);
    clients.push(a.socket, b.socket, unrelated);
    expect(a.socket).toBe(a.result);
    expect(b.socket).toBe(b.result);
    expect(a.socket).not.toBe(b.socket);
    expect(a.socket).not.toBe(unrelated);
    await expect(captureClientSocket(async () => undefined)).rejects.toThrow('Could not identify');
  } finally {
    for (const socket of [...clients, ...peers]) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([0, 200])(
  'bounds Redis authentication and cancels connecting clients with I/O timeout %i',
  async (readTimeout) => {
    const peers = new Set<Socket>();
    const server = createServer((peer) => {
      peers.add(peer);
      peer.on('error', () => {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const connection = {
      ...connectionSchema.parse({
        engine: 'redis',
        name: 'Silent login',
        host: '127.0.0.1',
        port: (server.address() as { port: number }).port,
        database: '0',
        connectionTimeout: 150,
        readTimeout,
      }),
      id: randomUUID(),
    };
    const adapter = new RedisAdapter(connection);
    try {
      await expect(adapter.connect()).rejects.toThrow('connection timed out');
      const accepted = once(server, 'connection');
      const pending = expect(adapter.connect()).rejects.toThrow();
      await accepted;
      await adapter.disconnect();
      await pending;
    } finally {
      await adapter.disconnect();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.skipIf(process.env.DB_INTEGRATION !== '1').each([false, true])(
  'Redis TCP/TLS network deadlines preserve progress, isolate connections and never replay writes (TLS=%s)',
  async (encrypted) => {
    const certificate = readFileSync(
      new URL('./fixtures/localhost-test-cert.pem', import.meta.url),
    );
    const privateKey = readFileSync(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
    const originalCAs = getCACertificates('default');
    if (encrypted) setDefaultCACertificates([...originalCAs, certificate.toString()]);
    let dropReplies = false,
      fragmentReplies = false,
      connections = 0;
    const sockets = new Set<Socket>();
    const forward = (peer: Socket) => {
      connections++;
      const upstream = createConnection({ host: '127.0.0.1', port: 16379 });
      sockets.add(peer);
      sockets.add(upstream);
      peer.setNoDelay(true);
      peer.on('error', () => {});
      upstream.on('error', () => peer.destroy());
      peer.once('close', () => upstream.destroy());
      upstream.once('close', () => peer.destroy());
      peer.pipe(upstream);
      const filter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (dropReplies) return callback();
          if (!fragmentReplies) return callback(null, chunk);
          void (async () => {
            for (let offset = 0; offset < chunk.length; offset += 32) {
              this.push(chunk.subarray(offset, offset + 32));
              await delay(45);
            }
          })().then(() => callback(), callback);
        },
      });
      upstream.pipe(filter).pipe(peer);
    };
    const server = encrypted
      ? tlsServer({ cert: certificate, key: privateKey }, forward)
      : createServer(forward);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const connection = {
      ...connectionSchema.parse({
        engine: 'redis',
        name: 'Redis I/O',
        host: '127.0.0.1',
        port: (server.address() as { port: number }).port,
        database: '3',
        tls: encrypted,
        readTimeout: 200,
        writeTimeout: 250,
      }),
      id: randomUUID(),
    };
    const adapter = new RedisAdapter(connection, process.env.DB_TEST_PASSWORD);
    const admin = createClient({
      socket: { host: '127.0.0.1', port: 16379, reconnectStrategy: false },
      password: process.env.DB_TEST_PASSWORD,
      database: 3,
    });
    admin.on('error', () => {});
    const key = 'dw:io:' + randomUUID(),
      list = key + ':list';
    try {
      await admin.connect();
      await Promise.all([adapter.connect(), adapter.connect(), adapter.connect()]);
      expect(connections).toBe(1);
      const activeSocket = () =>
        (
          adapter as unknown as {
            ioTimeouts: { socket: Socket & { encrypted?: boolean; authorized?: boolean } };
          }
        ).ioTimeouts.socket;
      if (encrypted) expect(activeSocket().authorized).toBe(true);
      await delay(260);
      expect(await adapter.command('PING', [])).toBe('PONG');
      expect(
        (await adapter.databaseSummary()).databases.some((item) => item.database === '3'),
      ).toBe(true);
      await adapter.command('SET', [key, 'x'.repeat(256)]);
      fragmentReplies = true;
      expect(await adapter.command('GET', [key])).toBe('x'.repeat(256));
      fragmentReplies = false;
      dropReplies = true;
      await expect(adapter.command('RPUSH', [list, 'once'], 5000)).rejects.toThrow(
        'Network read timed out',
      );
      dropReplies = false;
      expect(await adapter.command('PING', [])).toBe('PONG');
      expect(connections).toBe(2);
      expect(await admin.lRange(list, 0, -1)).toEqual(['once']);
      activeSocket().cork();
      await expect(adapter.command('PING', [], 5000)).rejects.toThrow('Network write timed out');
      await adapter.connect();
      dropReplies = true;
      await expect(adapter.heartbeat(5000)).rejects.toThrow('Network read timed out');
      dropReplies = false;
      expect(await adapter.command('GET', [key])).toBe('x'.repeat(256));
      // Redis emits ready before its connect promise settles. A command from
      // that event must still await installation of the socket deadline.
      await adapter.disconnect();
      let readyCommand: Promise<unknown> | undefined;
      const connecting = adapter.connect();
      const pendingClient = (
        adapter as unknown as { client: { once(event: string, callback: () => void): void } }
      ).client;
      pendingClient.once('ready', () => {
        dropReplies = true;
        readyCommand = adapter.command('PING', [], 1200);
        void readyCommand.catch(() => {});
      });
      await connecting;
      expect(readyCommand).toBeDefined();
      await expect(readyCommand).rejects.toThrow('Network read timed out');
    } finally {
      dropReplies = false;
      await adapter.disconnect();
      if (admin.isReady) await admin.del([key, list]);
      if (admin.isOpen) admin.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (encrypted) setDefaultCACertificates(originalCAs);
    }
  },
  15000,
);
