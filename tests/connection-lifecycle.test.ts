import { expect, it } from 'vitest';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';
import { ConnectionService } from '../src/main/application/services/connection-service';
import { EventBus } from '../src/main/application/events/event-bus';

const credentials = { get: () => undefined, set() {}, delete() {} };
it('disconnect closes only related tabs, protects dirty work and blocks implicit reconnects and stale handles', async () => {
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(DEFAULT_SETTINGS),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    credentials,
    (c) => new SqliteAdapter(c.database),
  );
  try {
    const a = await app.connections.save({ name: 'a', engine: 'sqlite', database: ':memory:' });
    const b = await app.connections.save({ name: 'b', engine: 'sqlite', database: ':memory:' });
    expect(app.connections.status(a.id).connected).toBe(false);
    const adapter = await app.connections.connect(a.id);
    const other = app.workspace.open({
      type: 'query',
      title: 'other',
      connectionId: b.id,
      sql: '',
    });
    for (const type of ['query', 'table', 'index', 'trigger', 'redis'] as const)
      app.workspace.open({ type, title: type, connectionId: a.id, sql: '' });
    const dirty = app.workspace.get().tabs.at(-1)!;
    app.workspace.update(dirty.id, { dirty: true });
    expect(
      (await app.commands.dispatch('connection.disconnect', { connectionId: a.id }, HUMAN)).success,
    ).toBe(false);
    expect(app.connections.status(a.id).connected).toBe(true);
    expect(app.workspace.get().tabs).toHaveLength(6);
    expect(
      (
        await app.commands.dispatch(
          'connection.disconnect',
          { connectionId: a.id, discard: true },
          HUMAN,
        )
      ).success,
    ).toBe(true);
    expect(app.workspace.get().tabs.map((tab) => tab.id)).toEqual([other.id]);
    expect(app.connections.status(a.id)).toMatchObject({ connected: false, connecting: false });
    await expect(adapter.databases()).rejects.toThrow('disconnected');
    const read = await app.commands.dispatch(
      'query.execute',
      { connectionId: a.id, sql: 'SELECT 1', showInApp: true },
      HUMAN,
    );
    expect(read.success).toBe(false);
    expect(app.workspace.get().tabs).toHaveLength(1);
    expect(
      (await app.commands.dispatch('connection.connect', { connectionId: a.id }, HUMAN)).success,
    ).toBe(true);
    await expect(adapter.databases()).rejects.toThrow('disconnected');
  } finally {
    await app.connections.shutdown();
  }
});

it('disconnect cancels a pending connect and closes its late adapter', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closed = 0;
  const service = new ConnectionService(
    new MemoryStore([]),
    credentials,
    () => ({
      connect: () => ready,
      disconnect: async () => {
        closed++;
      },
      query: async () => {
        throw new Error('unused');
      },
      databases: async () => [],
      schemas: async () => [],
      tables: async () => [],
      describe: async () => [],
    }),
    new EventBus(),
  );
  const connection = await service.save({ name: 'slow', engine: 'sqlite', database: ':memory:' });
  const attempt = service.connect(connection.id).catch((error) => error as Error);
  expect(service.status(connection.id).connecting).toBe(true);
  const disconnect = service.disconnect(connection.id, true);
  release();
  expect(await attempt).toBeInstanceOf(Error);
  await disconnect;
  expect(closed).toBe(1);
  expect(service.status(connection.id)).toMatchObject({
    connected: false,
    connecting: false,
    disconnecting: false,
  });
  await expect(service.connect(connection.id)).rejects.toThrow('disconnected');
});
