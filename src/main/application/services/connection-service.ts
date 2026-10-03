import { randomUUID } from 'node:crypto';
import type { Connection } from '../../../shared/types';
import { connectionSchema } from '../../../shared/schemas';
import type { Store } from './store';
import type { Credentials } from '../../credentials/credential-service';
import type { SqlAdapter, SqlAdapterFactory } from '../../database/adapter';
import { EventBus } from '../events/event-bus';
import { recordExecutedSql } from '../executed-sql';
/** Everything that decides which server and database a connection reaches. */
export const transportKey = (value: Connection) =>
  JSON.stringify([
    value.engine,
    value.host,
    value.port,
    value.username,
    value.sqlServerAuth ?? 'sql',
    value.sqlServerSpn,
    value.database,
    value.tls,
    value.connectionTimeout ?? 10000,
    value.heartbeatInterval ?? 0,
    value.charset || undefined,
    value.pgDumpPath,
    value.sqlServerPowerShellPath,
    value.readTimeout ?? 0,
    value.writeTimeout ?? 0,
    value.aseDriver,
    value.aseTrustedFile,
    value.aseJavaPath,
    value.aseDdlgenPath,
    value.aseJconnectPath,
  ]);
/** Transport plus agent access: the part of a saved connection that running work depends on. */
export const connectionIdentity = (value: Connection) =>
  JSON.stringify([transportKey(value), value.agentAccess]);
export class ConnectionService {
  private adapters = new Map<string, SqlAdapter>();
  private usage = new WeakMap<SqlAdapter, { last: number; busy: () => number }>();
  private connecting = new Map<string, Promise<SqlAdapter>>();
  private closing = new Map<string, Promise<void>>();
  private blocked = new Set<string>();
  private generations = new Map<string, number>();
  private scopeGenerations = new Map<string, number>();
  private suspended = new Set<string>();
  private scopeReleases = new Map<string, Promise<void>>();
  private heartbeats = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private store: Store<Connection[]>,
    private credentials: Credentials,
    private factory: SqlAdapterFactory,
    private events: EventBus,
    private beforeDisconnect: (id: string, discard: boolean) => void = () => {},
  ) {}
  list() {
    return this.store.read();
  }
  get(id: string) {
    const connection = this.list().find((item) => item.id === id);
    if (!connection) throw new Error('Connection not found.');
    return connection;
  }
  async save(input: unknown, discard = false) {
    const { password, ...parsed } = connectionSchema.parse(input);
    this.validateAuthentication(parsed);
    const integrated = parsed.engine === 'sqlserver' && parsed.sqlServerAuth === 'windows';
    if (integrated) delete parsed.username;
    const connection = { ...parsed, id: parsed.id ?? randomUUID() };
    const previous = parsed.id ? this.get(parsed.id) : undefined;
    const reconnect =
      !!previous && (transportKey(previous) !== transportKey(connection) || password !== undefined);
    if (reconnect) this.beforeDisconnect(connection.id, discard);
    // Persist first: if the keychain or disk refuses, the connection stays as it was
    // instead of being dropped with nothing saved.
    if (integrated) this.credentials.delete(connection.id);
    else if (password !== undefined) this.credentials.set(connection.id, password);
    const existing = this.list();
    this.store.write(
      previous
        ? existing.map((item) => (item.id === connection.id ? connection : item))
        : [...existing, connection],
    );
    if (reconnect) await this.disconnect(connection.id, true);
    // Cosmetic edits (name, colour, group) must not revoke approvals or abort
    // approved agent work; only a changed target or access level does.
    const permissionChanged =
      !previous ||
      transportKey(previous) !== transportKey(connection) ||
      previous.agentAccess !== connection.agentAccess ||
      password !== undefined;
    this.events.emit('ConnectionChanged', { connectionId: connection.id, permissionChanged });
    return connection;
  }
  async delete(id: string, discard = false) {
    this.get(id);
    this.beforeDisconnect(id, discard);
    // Remove it first so a concurrent connect() cannot create an adapter for a
    // connection that is being deleted.
    this.store.write(this.list().filter((item) => item.id !== id));
    this.credentials.delete(id);
    await this.disconnect(id, true);
    this.events.emit('ConnectionChanged', { connectionId: id, permissionChanged: true });
  }
  status(id: string) {
    this.get(id);
    return {
      connected:
        !this.closing.has(id) &&
        !this.blocked.has(id) &&
        [...this.adapters.keys()].some((key) => JSON.parse(key)[0] === id),
      connecting:
        !this.closing.has(id) &&
        !this.blocked.has(id) &&
        [...this.connecting.keys()].some((key) => JSON.parse(key)[0] === id),
      disconnecting: this.closing.has(id),
    };
  }
  assertAvailable(id: string) {
    if (this.blocked.has(id) || this.closing.has(id))
      throw new Error('Connection is disconnected. Double-click the connection to connect.');
  }
  async connect(id: string, database?: string, explicit = false): Promise<SqlAdapter> {
    if (explicit) {
      const closing = this.closing.get(id);
      if (closing) await closing;
      this.blocked.delete(id);
    }
    this.assertAvailable(id);
    const connection = this.get(id);
    this.validateAuthentication(connection);
    let selectedDatabase = database ?? connection.database;
    if (connection.engine === 'sqlite') {
      if (![connection.database, 'main'].includes(selectedDatabase))
        throw new Error('SQLite database scope must refer to the configured file.');
      selectedDatabase = connection.database;
    }
    if (connection.engine === 'redis') {
      const index = Number(selectedDatabase || '0');
      if (!Number.isSafeInteger(index) || index < 0 || !/^\d*$/.test(selectedDatabase))
        throw new Error('Redis DB index must be a non-negative integer.');
      selectedDatabase = String(index);
    }
    const scopeLimit = connection.engine === 'redis' ? 128 : 8;
    const key = JSON.stringify([id, selectedDatabase]);
    if (this.suspended.has(key))
      throw new Error(
        'Database properties are being changed. Try again after the operation completes.',
      );
    if (this.adapters.has(key)) return this.adapters.get(key)!;
    if (this.connecting.has(key)) return this.connecting.get(key)!;
    const scopesOf = () =>
      new Set(
        [...this.adapters.keys(), ...this.connecting.keys()].filter(
          (item) => JSON.parse(item)[0] === id,
        ),
      );
    if (scopesOf().size >= scopeLimit) this.evictIdleScope(id, connection.database);
    if (scopesOf().size >= scopeLimit)
      throw new Error(
        `At most ${scopeLimit} database scopes can be connected at once. Disconnect to release unused scopes.`,
      );
    const pending = (async () => {
      const generation = this.generations.get(id) ?? 0;
      const scopeGeneration = this.scopeGenerations.get(key) ?? 0;
      let adapter: SqlAdapter | undefined;
      try {
        adapter = this.factory(
          { ...connection, database: selectedDatabase },
          connection.sqlServerAuth === 'windows' ? undefined : this.credentials.get(id),
        );
        await adapter.connect();
        if (
          generation !== (this.generations.get(id) ?? 0) ||
          scopeGeneration !== (this.scopeGenerations.get(key) ?? 0)
        )
          throw new Error('Connection attempt was cancelled.');
        // Reject stale handles and drain work already issued before closing the driver.
        const operations = new Set<Promise<unknown>>();
        const usage = { last: Date.now(), busy: () => operations.size };
        const guarded = new Proxy(adapter, {
          get: (target, property) => {
            const member = Reflect.get(target, property);
            if (typeof member !== 'function') return member;
            if (property === 'disconnect')
              return async () => {
                await Promise.allSettled([...operations]);
                await target.disconnect();
              };
            return (...args: unknown[]) => {
              usage.last = Date.now();
              if (property === 'executeDdl' || property === 'replaceObject')
                recordExecutedSql(args[0]);
              if (
                generation !== (this.generations.get(id) ?? 0) ||
                scopeGeneration !== (this.scopeGenerations.get(key) ?? 0)
              )
                return Promise.reject(
                  new Error('Connection is disconnected. Double-click the connection to connect.'),
                );
              const operation = Promise.resolve().then(() => member.apply(target, args));
              operations.add(operation);
              void operation.finally(() => operations.delete(operation)).catch(() => undefined);
              return operation;
            };
          },
        });
        this.usage.set(guarded, usage);
        this.adapters.set(key, guarded);
        this.scheduleHeartbeat(key, connection, guarded);
        return guarded;
      } catch (error) {
        await adapter?.disconnect().catch(() => undefined);
        throw error;
      } finally {
        // A synchronous failure reaches `finally` before `connecting.set` below;
        // defer so the entry is always removed after it is registered, otherwise
        // the rejected promise would stay registered forever.
        queueMicrotask(() => {
          this.connecting.delete(key);
          this.events.emit('ConnectionChanged', { connectionId: id, ...this.status(id) });
        });
      }
    })();
    this.connecting.set(key, pending);
    this.events.emit('ConnectionChanged', { connectionId: id, ...this.status(id) });
    return pending;
  }
  /**
   * Frees the least recently used scope that has no running work, so a burst of
   * one-off database scopes (for example from an agent) cannot lock out the
   * databases a user opens later. The connection's own database is never evicted.
   */
  private evictIdleScope(id: string, home: string) {
    const idleSince = Date.now() - 5000;
    let oldest: { key: string; adapter: SqlAdapter; last: number } | undefined;
    for (const [key, adapter] of this.adapters) {
      const [owner, database] = JSON.parse(key) as [string, string];
      const usage = this.usage.get(adapter);
      if (owner !== id || database === home || !usage || usage.busy() > 0) continue;
      if (usage.last > idleSince || this.suspended.has(key)) continue;
      if (!oldest || usage.last < oldest.last) oldest = { key, adapter, last: usage.last };
    }
    if (!oldest) return;
    this.scopeGenerations.set(oldest.key, (this.scopeGenerations.get(oldest.key) ?? 0) + 1);
    clearTimeout(this.heartbeats.get(oldest.key));
    this.heartbeats.delete(oldest.key);
    this.adapters.delete(oldest.key);
    void oldest.adapter.disconnect().catch(() => undefined);
    this.events.emit('ConnectionChanged', { connectionId: id, ...this.status(id) });
  }
  /** Release only this app's target pool; never force other clients off the database. */
  async withDatabaseSuspended<T>(
    id: string,
    database: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertAvailable(id);
    const key = JSON.stringify([id, database]);
    if (this.suspended.has(key)) throw new Error('Database properties are already being changed.');
    this.suspended.add(key);
    this.scopeGenerations.set(key, (this.scopeGenerations.get(key) ?? 0) + 1);
    clearTimeout(this.heartbeats.get(key));
    this.heartbeats.delete(key);
    const adapter = this.adapters.get(key);
    this.adapters.delete(key);
    const release = (async () => {
      await this.connecting.get(key)?.catch(() => undefined);
      if (adapter) await adapter.disconnect();
    })();
    this.scopeReleases.set(key, release);
    try {
      await release;
      this.assertAvailable(id);
      return await operation();
    } finally {
      this.scopeReleases.delete(key);
      this.suspended.delete(key);
      this.events.emit('ConnectionChanged', { connectionId: id, ...this.status(id) });
    }
  }
  async disconnect(id: string, block = false) {
    if (block) this.blocked.add(id);
    if (this.closing.has(id)) return this.closing.get(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const keys = [
      ...new Set([
        ...this.adapters.keys(),
        ...this.connecting.keys(),
        ...this.scopeReleases.keys(),
      ]),
    ].filter((key) => JSON.parse(key)[0] === id);
    for (const key of keys) {
      clearTimeout(this.heartbeats.get(key));
      this.heartbeats.delete(key);
    }
    const closing = Promise.all(
      keys.map(async (key) => {
        await this.scopeReleases.get(key);
        const pending = this.connecting.get(key);
        if (pending) await pending.catch(() => undefined);
        const adapter = this.adapters.get(key);
        this.adapters.delete(key);
        if (adapter) await adapter.disconnect();
      }),
    ).then(() => undefined);
    this.closing.set(id, closing);
    this.events.emit('ConnectionChanged', {
      connectionId: id,
      connected: false,
      connecting: false,
      disconnecting: true,
    });
    try {
      await closing;
    } finally {
      this.closing.delete(id);
      this.events.emit('ConnectionChanged', {
        connectionId: id,
        connected: false,
        connecting: false,
        disconnecting: false,
      });
    }
  }
  async test(input: unknown) {
    const { password, ...parsed } = connectionSchema.parse(input);
    this.validateAuthentication(parsed);
    const integrated = parsed.sqlServerAuth === 'windows';
    if (integrated) delete parsed.username;
    const adapter = this.factory(
      { ...parsed, id: parsed.id ?? 'test' },
      integrated
        ? undefined
        : (password ?? (parsed.id ? this.credentials.get(parsed.id) : undefined)),
    );
    try {
      await adapter.connect();
      return { success: true };
    } finally {
      // A failing cleanup must not replace the connection error the user needs to see.
      try {
        await adapter.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
  private scheduleHeartbeat(key: string, connection: Connection, adapter: SqlAdapter) {
    const interval = connection.heartbeatInterval ?? 0;
    if (
      !interval ||
      connection.engine === 'sqlite' ||
      this.adapters.get(key) !== adapter ||
      this.blocked.has(connection.id) ||
      this.closing.has(connection.id)
    )
      return;
    const timer = setTimeout(async () => {
      this.heartbeats.delete(key);
      if (this.adapters.get(key) !== adapter || this.closing.has(connection.id)) return;
      try {
        const timeout = connection.connectionTimeout ?? 10000;
        if (adapter.heartbeat) await adapter.heartbeat(timeout);
        else await adapter.query('SELECT 1', [], { limit: 1, timeout, readOnly: true });
      } catch {
        // A late failure from an old handle must not close an explicit reconnection.
        if (this.adapters.get(key) === adapter && !this.closing.has(connection.id))
          await this.disconnect(connection.id, true).catch(() => undefined);
        return;
      }
      this.scheduleHeartbeat(key, connection, adapter);
    }, interval * 1000);
    timer.unref();
    this.heartbeats.set(key, timer);
  }
  async shutdown() {
    await Promise.all(
      [
        ...new Set(
          [...this.adapters.keys(), ...this.connecting.keys(), ...this.scopeReleases.keys()].map(
            (key) => JSON.parse(key)[0] as string,
          ),
        ),
      ].map((id) => this.disconnect(id)),
    );
  }
  private validateAuthentication(connection: Pick<Connection, 'engine' | 'sqlServerAuth'>) {
    if (connection.sqlServerAuth !== 'windows') return;
    if (connection.engine !== 'sqlserver')
      throw new Error('Windows authentication is only available for SQL Server.');
    if (process.platform !== 'win32')
      throw new Error('Windows authentication is only available on Windows.');
  }
}
