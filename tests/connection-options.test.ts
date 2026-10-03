import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionService } from '../src/main/application/services/connection-service';
import { MemoryStore } from '../src/main/application/services/store';
import { EventBus } from '../src/main/application/events/event-bus';
import { connectionSchema } from '../src/shared/schemas';
import type { SqlAdapter } from '../src/main/database/adapter';

afterEach(() => vi.useRealTimers());
it('suspends only one database, drains issued work and permanently rejects its old handles', async () => {
  const closed: string[] = [],
    releases = new Map<string, () => void>();
  const service = new ConnectionService(
    new MemoryStore([]),
    { get: () => undefined, set() {}, delete() {} },
    (connection) => ({
      connect: async () => {},
      disconnect: async () => {
        closed.push(connection.database);
      },
      query: async () => {
        throw new Error('Unused');
      },
      schemas: async () => [],
      tables: async () => [],
      describe: async () => [],
      databases: async () => {
        await new Promise<void>((resolve) => releases.set(connection.database, resolve));
        return [];
      },
    }),
    new EventBus(),
  );
  const config = await service.save({ engine: 'sqlserver', name: 'scope', database: 'master' });
  try {
    const master = await service.connect(config.id),
      target = await service.connect(config.id, 'target');
    const reading = target.databases();
    await Promise.resolve();
    let applied = false,
      finish!: () => void;
    const suspended = service.withDatabaseSuspended(config.id, 'target', async () => {
      applied = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    expect(applied).toBe(false);
    expect(closed).toEqual([]);
    await expect(service.connect(config.id, 'target')).rejects.toThrow('being changed');
    await expect(target.tables()).rejects.toThrow('disconnected');
    expect(await master.schemas()).toEqual([]);
    releases.get('target')!();
    await reading;
    await vi.waitFor(() => expect(applied).toBe(true));
    expect(closed).toEqual(['target']);
    expect(service.status(config.id).connected).toBe(true);
    finish();
    await suspended;
    await expect(target.tables()).rejects.toThrow('disconnected');
    expect(await (await service.connect(config.id, 'target')).tables()).toEqual([]);
    await expect(
      service.withDatabaseSuspended(config.id, 'target', async () => {
        throw new Error('DDL failed');
      }),
    ).rejects.toThrow('DDL failed');
    expect(await (await service.connect(config.id, 'target')).tables()).toEqual([]);
  } finally {
    await service.shutdown();
  }
});
it('cancels an in-flight database connection when suspending its scope', async () => {
  let ready!: () => void;
  let disconnected = 0;
  const service = new ConnectionService(
    new MemoryStore([]),
    { get: () => undefined, set() {}, delete() {} },
    () => ({
      connect: () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
      disconnect: async () => {
        disconnected++;
      },
      query: async () => {
        throw new Error('Unused');
      },
      schemas: async () => [],
      tables: async () => [],
      describe: async () => [],
      databases: async () => [],
    }),
    new EventBus(),
  );
  const config = await service.save({ engine: 'sqlserver', name: 'scope' });
  const pending = service.connect(config.id, 'target');
  const rejected = expect(pending).rejects.toThrow('cancelled');
  const suspended = service.withDatabaseSuspended(config.id, 'target', async () => true);
  ready();
  await rejected;
  expect(await suspended).toBe(true);
  expect(disconnected).toBe(1);
  await service.shutdown();
});
function fixture(heartbeat = vi.fn<NonNullable<SqlAdapter['heartbeat']>>().mockResolvedValue()) {
  const adapter = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    heartbeat,
    query: vi.fn(async () => {
      throw new Error('Unused');
    }),
    databases: async () => [],
    schemas: async () => [],
    tables: async () => [],
    describe: async () => [],
  };
  const service = new ConnectionService(
    new MemoryStore([]),
    { get: () => undefined, set() {}, delete() {} },
    () => adapter,
    new EventBus(),
  );
  return { service, adapter };
}
it('releases cached database scopes when network I/O deadlines change', async () => {
  const { service, adapter } = fixture();
  try {
    let config = await service.save({ engine: 'mysql', name: 'I/O settings' });
    const previous = await service.connect(config.id);
    config = await service.save({ ...config, readTimeout: 1500, writeTimeout: 2500 });
    expect(service.get(config.id)).toMatchObject({ readTimeout: 1500, writeTimeout: 2500 });
    expect(service.status(config.id).connected).toBe(false);
    await expect(previous.tables()).rejects.toThrow('disconnected');
    await service.connect(config.id, undefined, true);
    await service.save({ ...config, readTimeout: 0, writeTimeout: 0 });
    expect(adapter.disconnect).toHaveBeenCalledTimes(2);
  } finally {
    await service.shutdown();
  }
});
it('invalidates cached adapters when the native PostgreSQL export tool changes', async () => {
  const { service, adapter } = fixture();
  try {
    const config = await service.save({ engine: 'postgres', name: 'native export' });
    const previous = await service.connect(config.id);
    const changed = await service.save({
      ...config,
      pgDumpPath: 'C:\\PostgreSQL\\bin\\pg_dump.exe',
    });
    expect(service.get(config.id).pgDumpPath).toBe(changed.pgDumpPath);
    expect(adapter.disconnect).toHaveBeenCalledTimes(1);
    expect(service.status(config.id).connected).toBe(false);
    await expect(previous.tables()).rejects.toThrow('disconnected');
    await service.connect(config.id, undefined, true);
    await service.save({ ...changed, pgDumpPath: undefined });
    expect(adapter.disconnect).toHaveBeenCalledTimes(2);
  } finally {
    await service.shutdown();
  }
});

it('invalidates ASE sessions when a native export tool path changes', async () => {
  const { service, adapter } = fixture();
  try {
    let config = await service.save({ engine: 'sybase', name: 'ASE export' });
    for (const [field, path] of [
      ['aseJavaPath', 'C:\\Java\\bin\\java.exe'],
      ['aseDdlgenPath', 'C:\\SAP\\DDLGen.jar'],
      ['aseJconnectPath', 'C:\\SAP\\jconn4.jar'],
    ]) {
      const previous = await service.connect(config.id, undefined, true);
      config = await service.save({ ...config, [field]: path });
      await expect(previous.tables()).rejects.toThrow('disconnected');
    }
    expect(adapter.disconnect).toHaveBeenCalledTimes(3);
  } finally {
    await service.shutdown();
  }
});
it('shutdown drains a scope that is already being released and prevents its pending DDL', async () => {
  let release!: () => void;
  const { service, adapter } = fixture(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
  );
  const config = await service.save({ engine: 'mysql', database: 'target', name: 'shutdown' });
  const handle = await service.connect(config.id);
  const reading = handle.heartbeat!(1000);
  await Promise.resolve();
  let applied = false,
    closed = false;
  const suspended = service.withDatabaseSuspended(config.id, 'target', async () => {
    applied = true;
  });
  const rejection = expect(suspended).rejects.toThrow('disconnected');
  const shutdown = service.shutdown().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(adapter.disconnect).not.toHaveBeenCalled();
  release();
  await reading;
  await rejection;
  await shutdown;
  expect(applied).toBe(false);
  expect(adapter.disconnect).toHaveBeenCalledTimes(1);
});
it('keeps old connection defaults and rejects invalid advanced settings', () => {
  const config = { name: 'test', engine: 'mysql' };
  expect(connectionSchema.parse(config)).toMatchObject({
    connectionTimeout: 10000,
    heartbeatInterval: 0,
  });
  for (const extra of [
    { connectionTimeout: 0 },
    { connectionTimeout: 300001 },
    { heartbeatInterval: -1 },
    { heartbeatInterval: 0.1 },
    { heartbeatInterval: 86401 },
    { charset: 'utf8; SELECT 1' },
    { charset: 'utf8', engine: 'postgres' },
  ])
    expect(connectionSchema.safeParse({ ...config, ...extra }).success).toBe(false);
});
it('starts probes only after connecting, stops on disconnect, and requires explicit reconnection', async () => {
  vi.useFakeTimers();
  const { service, adapter } = fixture();
  const connection = await service.save({
    name: 'test',
    engine: 'redis',
    heartbeatInterval: 2,
    connectionTimeout: 4321,
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(adapter.heartbeat).not.toHaveBeenCalled();
  await service.connect(connection.id);
  await vi.advanceTimersByTimeAsync(2000);
  expect(adapter.heartbeat).toHaveBeenCalledExactlyOnceWith(4321);
  await service.disconnect(connection.id, true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(adapter.heartbeat).toHaveBeenCalledTimes(1);
  await expect(service.connect(connection.id)).rejects.toThrow('disconnected');
  await service.connect(connection.id, undefined, true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(adapter.heartbeat).toHaveBeenCalledTimes(2);
  await service.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});
it('never overlaps probes and drains a running probe when disconnecting', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const heartbeat = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const { service, adapter } = fixture(heartbeat);
  const connection = await service.save({ name: 'test', engine: 'redis', heartbeatInterval: 1 });
  await service.connect(connection.id);
  await vi.advanceTimersByTimeAsync(5000);
  expect(heartbeat).toHaveBeenCalledTimes(1);
  const disconnecting = service.disconnect(connection.id, true);
  expect(adapter.disconnect).not.toHaveBeenCalled();
  release();
  await disconnecting;
  await vi.advanceTimersByTimeAsync(5000);
  expect(heartbeat).toHaveBeenCalledTimes(1);
  expect(adapter.disconnect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('blocks implicit reconnects after a failed heartbeat', async () => {
  vi.useFakeTimers();
  const { service, adapter } = fixture(
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  const connection = await service.save({ name: 'test', engine: 'redis', heartbeatInterval: 1 });
  await service.connect(connection.id);
  await vi.advanceTimersByTimeAsync(10000);
  expect(service.status(connection.id).connected).toBe(false);
  expect(adapter.heartbeat).toHaveBeenCalledTimes(1);
  expect(adapter.disconnect).toHaveBeenCalledTimes(1);
  await expect(service.connect(connection.id)).rejects.toThrow('disconnected');
  expect(adapter.connect).toHaveBeenCalledTimes(1);
});
it('disables probes by default and for SQLite, and disconnects on changing transport settings', async () => {
  vi.useFakeTimers();
  const { service, adapter } = fixture();
  const connection = await service.save({ name: 'test', engine: 'mysql' });
  await service.connect(connection.id);
  await vi.advanceTimersByTimeAsync(60000);
  expect(adapter.heartbeat).not.toHaveBeenCalled();
  await service.save({
    ...connection,
    charset: 'utf8mb4',
    connectionTimeout: 20000,
    heartbeatInterval: 10,
  });
  expect(service.status(connection.id).connected).toBe(false);
  const local = await service.save({
    name: 'local',
    engine: 'sqlite',
    database: ':memory:',
    heartbeatInterval: 1,
  });
  await service.connect(local.id);
  await vi.advanceTimersByTimeAsync(10000);
  expect(adapter.heartbeat).not.toHaveBeenCalled();
  await service.shutdown();
});
