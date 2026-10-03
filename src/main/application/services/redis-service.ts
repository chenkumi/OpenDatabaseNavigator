import type { Actor, Settings } from '../../../shared/types';
import { RedisAdapter } from '../../database/adapters/redis/redis-adapter';
import { ConnectionService, connectionIdentity } from './connection-service';
import { CursorStore } from './cursor-store';
import { EventBus } from '../events/event-bus';
type ScanState = {
  native: string;
  streamStart?: string;
  pending: any[];
  key?: string;
  pattern?: string;
  type: string;
  offset: number;
  limit: number;
  connection: string;
};
export class RedisService {
  private cursors = new CursorStore<ScanState>();
  constructor(
    private connections: ConnectionService,
    private settings: () => Settings,
    private events: EventBus,
  ) {}
  private async adapter(connectionId: string, database?: string) {
    if (this.connections.get(connectionId).engine !== 'redis')
      throw new Error('This command requires a Redis connection.');
    const adapter = await this.connections.connect(connectionId, database);
    if (!(adapter instanceof RedisAdapter)) throw new Error('Redis adapter unavailable.');
    return adapter;
  }
  async databases(connectionId: string) {
    return (await this.adapter(connectionId)).databaseSummary();
  }
  async read(
    operation: string,
    input: {
      connectionId: string;
      database?: string;
      key?: string;
      pattern?: string;
      cursor?: string;
      limit?: number;
    },
    actor: Actor,
  ) {
    const adapter = await this.adapter(input.connectionId, input.database);
    const database = String(
      Number(input.database ?? this.connections.get(input.connectionId).database),
    );
    const scope = {
      actorId: actor.id,
      connectionId: input.connectionId,
      operation: `${operation}:${database}`,
    };
    const limit = Math.min(input.limit ?? this.settings().pageSize, this.settings().maxRows);
    let state: ScanState;
    if (input.cursor) {
      state = this.cursors.take(input.cursor, scope);
      if (state.connection !== connectionIdentity(this.connections.get(input.connectionId)))
        throw new Error('Connection configuration changed; start a new scan.');
      if (
        state.key !== input.key ||
        (operation === 'scan' && state.pattern !== (input.pattern ?? '*'))
      )
        throw new Error('Cursor parameters do not match the original scan.');
      state.limit = Math.min(state.limit, this.settings().maxRows);
      if (state.key && state.type !== (await adapter.command('TYPE', [state.key])))
        throw new Error('Redis key type changed; reload the key.');
    } else
      state = {
        native: '0',
        pending: [],
        key: input.key,
        pattern: input.pattern ?? '*',
        type: operation === 'scan' ? 'keys' : await adapter.command('TYPE', [input.key!]),
        offset: 0,
        limit,
        connection: connectionIdentity(this.connections.get(input.connectionId)),
      };
    const call = (command: string, args: string[]) =>
      adapter.command(command, args, this.settings().queryTimeout);
    if (state.type === 'none')
      return { key: state.key, type: 'none', ttl: -2, items: [], hasMore: false };
    if (operation === 'ttl')
      return { key: state.key, ttl: Number(await call('TTL', [state.key!])) };
    const expected: Record<string, string> = {
      hgetall: 'hash',
      lrange: 'list',
      smembers: 'set',
      zrange: 'zset',
      xrange: 'stream',
    };
    if (expected[operation] && state.type !== expected[operation])
      throw new Error(`Expected Redis ${expected[operation]}.`);
    let items: any[] = [];
    let more = false;
    if (state.type === 'string') {
      if (Number(await call('STRLEN', [state.key!])) > 1024 * 1024)
        throw new Error('String exceeds the 1 MiB editor limit.');
      const text = await call('GETRANGE', [state.key!, '0', String(1024 * 1024)]);
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024)
        throw new Error('String exceeds the 1 MiB editor limit.');
      items = [text];
    } else if (['ReJSON-RL', 'json'].includes(state.type)) {
      const text = await call('JSON.GET', [
        state.key!,
        'INDENT',
        '  ',
        'NEWLINE',
        '\n',
        'SPACE',
        ' ',
        '.',
      ]);
      if (text === null)
        return { key: state.key, type: 'none', ttl: -2, items: [], hasMore: false };
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024)
        throw new Error('JSON exceeds the 1 MiB editor limit.');
      items = [text];
    } else if (state.type === 'stream') {
      const raw: [string, string[]][] = await call('XRANGE', [
        state.key!,
        state.streamStart ?? '-',
        '+',
        'COUNT',
        String(state.limit + 1),
      ]);
      more = raw.length > state.limit;
      items = raw.slice(0, state.limit).map(([id, fields]) => ({ id, fields: pairs(fields) }));
      if (items.length) {
        const [milliseconds, sequence] = items.at(-1).id.split('-').map(BigInt);
        // Inclusive successor also works on Redis 5, before exclusive XRANGE bounds.
        state.streamStart =
          sequence < 18446744073709551615n
            ? `${milliseconds}-${sequence + 1n}`
            : `${milliseconds + 1n}-0`;
      }
    } else if (state.type === 'list' || state.type === 'zset') {
      const raw = await call(state.type === 'list' ? 'LRANGE' : 'ZRANGE', [
        state.key!,
        String(state.offset),
        String(state.offset + state.limit - 1),
        ...(state.type === 'zset' ? ['WITHSCORES'] : []),
      ]);
      items =
        state.type === 'list'
          ? raw.map((value: string, index: number) => ({ index: state.offset + index, value }))
          : pairs(raw).map(([member, score]) => ({ member, score: Number(score) }));
      state.offset += items.length;
      more =
        state.offset < Number(await call(state.type === 'list' ? 'LLEN' : 'ZCARD', [state.key!]));
    } else if (['keys', 'hash', 'set'].includes(state.type)) {
      if (!state.pending.length) {
        const name = state.type === 'keys' ? 'SCAN' : state.type === 'hash' ? 'HSCAN' : 'SSCAN';
        const raw = await call(name, [
          ...(state.type === 'keys' ? [] : [state.key!]),
          state.native,
          ...(state.type === 'keys' ? ['MATCH', state.pattern!] : []),
          'COUNT',
          String(state.limit),
        ]);
        state.native = String(raw[0]);
        state.pending =
          state.type === 'hash'
            ? pairs(raw[1]).map(([field, value]) => ({ field, value }))
            : raw[1];
      }
      if (Buffer.byteLength(JSON.stringify(state.pending)) > 8 * 1024 * 1024)
        throw new Error('Redis scan page exceeds the 8 MiB limit.');
      items = state.pending.splice(0, state.limit);
      more = state.pending.length > 0 || state.native !== '0';
    }
    if (Buffer.byteLength(JSON.stringify(items)) > 8 * 1024 * 1024)
      throw new Error('Redis response exceeds the 8 MiB limit.');
    return {
      key: state.key,
      type: ['ReJSON-RL', 'json'].includes(state.type) ? 'json' : state.type,
      readOnly: ![
        'string',
        'hash',
        'list',
        'set',
        'zset',
        'stream',
        'ReJSON-RL',
        'json',
        'keys',
      ].includes(state.type),
      items,
      ttl: state.key ? Number(await call('TTL', [state.key])) : undefined,
      hasMore: more,
      nextCursor: more ? this.cursors.put(scope, state) : undefined,
    };
  }
  async write(
    operation: string,
    input: {
      connectionId: string;
      database?: string;
      key: string;
      value?: string;
      field?: string;
      member?: string;
      index?: number;
      score?: number;
      ttl?: number;
      id?: string;
      fields?: [string, string][];
    },
    actor?: Actor,
  ) {
    const adapter = await this.adapter(input.connectionId, input.database);
    if (
      operation === 'xadd' &&
      Buffer.byteLength(JSON.stringify(input.fields), 'utf8') > 1024 * 1024
    )
      throw new Error('Stream entry exceeds the 1 MiB editor limit.');
    if (operation === 'json_set') {
      if (Buffer.byteLength(input.value ?? '', 'utf8') > 1024 * 1024)
        throw new Error('JSON exceeds the 1 MiB editor limit.');
      try {
        JSON.parse(input.value ?? '');
      } catch {
        throw new Error('Enter valid JSON.');
      }
    }
    const commands: Record<string, [string, string[]]> = {
      json_set: ['JSON.SET', [input.key, '.', input.value ?? '']],
      xadd: ['XADD', [input.key, input.id ?? '*', ...(input.fields ?? []).flat()]],
      xdelete: ['XDEL', [input.key, input.id!]],
      set: ['SET', [input.key, input.value ?? '', 'KEEPTTL']],
      hset: ['HSET', [input.key, input.field ?? '', input.value ?? '']],
      hdelete: ['HDEL', [input.key, input.field ?? '']],
      lset: ['LSET', [input.key, String(input.index), input.value ?? '']],
      rpush: ['RPUSH', [input.key, input.value ?? '']],
      sadd: ['SADD', [input.key, input.member ?? '']],
      srem: ['SREM', [input.key, input.member ?? '']],
      zadd: ['ZADD', [input.key, String(input.score), input.member ?? '']],
      zrem: ['ZREM', [input.key, input.member ?? '']],
      delete: ['DEL', [input.key]],
      expire:
        input.ttl === -1 ? ['PERSIST', [input.key]] : ['EXPIRE', [input.key, String(input.ttl)]],
    };
    const entry = commands[operation];
    if (!entry) throw new Error('Unsupported Redis write.');
    if (operation === 'set' && actor?.kind === 'agent') {
      // SET replaces a key of any type, which would be a delete in disguise for an
      // agent that only holds update rights. The desktop user may overwrite on purpose.
      const type = String(await adapter.command('TYPE', [input.key], this.settings().queryTimeout));
      if (type !== 'none' && type !== 'string')
        throw new Error(
          `Key holds a ${type} value; SET would replace it. Delete the key explicitly first.`,
        );
    }
    const result = await adapter.command(entry[0], entry[1], this.settings().queryTimeout);
    this.events.emit('RedisValueChanged', {
      connectionId: input.connectionId,
      database: String(Number(input.database ?? this.connections.get(input.connectionId).database)),
      key: input.key,
    });
    return { success: true, key: input.key, result };
  }
}
function pairs(values: string[]) {
  const output: [string, string][] = [];
  for (let index = 0; index < values.length; index += 2)
    output.push([values[index], values[index + 1]]);
  return output;
}
