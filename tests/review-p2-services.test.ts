import { expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/main/application/events/event-bus';
import {
  ConnectionService,
  connectionIdentity,
} from '../src/main/application/services/connection-service';
import { MemoryStore } from '../src/main/application/services/store';
import { QueryService } from '../src/main/application/services/query-service';
import { WorkspaceService } from '../src/main/application/services/workspace-service';
import { listDatabaseObjects } from '../src/main/application/services/database-metadata';
import { planDropObject } from '../src/main/application/services/drop-object-service';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';
import { DEFAULT_SETTINGS, type Connection } from '../src/shared/types';
import type { SqlAdapter } from '../src/main/database/adapter';

const credentials = { get: () => undefined, set() {}, delete() {} };
const fake = (): SqlAdapter =>
  ({
    connect: async () => {},
    disconnect: async () => {},
    query: async () => ({ rows: [], columns: [], rowCount: 0, hasMore: false }),
    schemas: async () => [],
    tables: async () => [],
    describe: async () => [],
    databases: async () => [],
  }) as unknown as SqlAdapter;

it('every disconnect path cancels the connections running queries', async () => {
  const events = new EventBus();
  let signal: AbortSignal | undefined;
  const adapter = {
    ...fake(),
    query: (_sql: string, _params: unknown[], options: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(new Error('Query cancelled.')));
      }),
  } as unknown as SqlAdapter;
  const connections = new ConnectionService(
    new MemoryStore([]),
    credentials,
    () => adapter,
    events,
  );
  const saved = await connections.save({ name: 'a', engine: 'sqlite', database: ':memory:' });
  const query = new QueryService(
    connections,
    new WorkspaceService(new MemoryStore({ tabs: [] }), events),
    () => DEFAULT_SETTINGS,
    new MemoryStore([]),
    events,
  );
  const running = query.execute(
    { connectionId: saved.id, sql: 'SELECT 1' } as never,
    { kind: 'human', id: 'u' } as never,
    false,
  );
  await vi.waitFor(() => expect(signal).toBeDefined());
  events.emit('ConnectionChanged', { connectionId: saved.id, disconnecting: true });
  await expect(running).rejects.toThrow('cancelled');
});

it('metadata lookups are narrowed on the server with engine-specific placeholders', async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  const adapter = {
    query: async (sql: string, params: unknown[]) => {
      seen.push({ sql, params });
      return { rows: [], columns: [], rowCount: 0, hasMore: false };
    },
  } as unknown as SqlAdapter;
  const filter = { schema: 's', table: 't', name: 'N' };
  const run = (engine: string, kind: 'index' | 'trigger') =>
    listDatabaseObjects(adapter, { engine } as Connection, kind, filter);
  await run('postgres', 'index');
  await run('sqlserver', 'trigger');
  await run('mysql', 'index');
  await run('sqlite', 'trigger');
  expect(seen[0].sql).toContain(
    'schemaname = $1 AND tablename = $2 AND LOWER(indexname) = LOWER($3) ORDER BY',
  );
  expect(seen[1].sql).toContain(
    's.name = @p1 AND o.name = @p2 AND LOWER(t.name) = LOWER(@p3) ORDER BY',
  );
  expect(seen[2].sql).toMatch(/TABLE_NAME = \? AND LOWER\(INDEX_NAME\) = LOWER\(\?\)\s+GROUP BY/);
  expect(seen[3].params).toEqual(['trigger', 't', 'N']);
  expect(seen.map((item) => item.params.length)).toEqual([3, 3, 3, 3]);
});

it('dropping a SQLite parent table lists child tables changed by foreign key actions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dw-drop-'));
  const file = join(dir, 'a.db');
  const adapter = new SqliteAdapter(file);
  const run = (sql: string) =>
    adapter.query(sql, [], { limit: 10, timeout: 5000, readOnly: false });
  try {
    await run('CREATE TABLE parent (id integer primary key)');
    await run(
      'CREATE TABLE child_cascade (id integer, p integer references parent(id) on delete cascade)',
    );
    await run('CREATE TABLE child_plain (id integer, p integer references parent(id))');
    const connection = { id: 'c', engine: 'sqlite', database: file } as Connection;
    const ref = {
      connectionId: 'c',
      schema: 'main',
      objectName: 'parent',
      table: '',
      kind: 'table',
    } as const;
    const plan = await planDropObject(adapter, connection, ref);
    expect(plan.dependents).toEqual(['child_cascade (ON DELETE CASCADE)']);
    const other = await planDropObject(adapter, connection, { ...ref, objectName: 'child_plain' });
    expect(other.dependents).toEqual([]);
    expect(other.version).not.toBe(plan.version);
  } finally {
    await adapter.disconnect();
  }
});

it('cosmetic connection edits keep the identity that running work is pinned to', async () => {
  const connections = new ConnectionService(
    new MemoryStore([]),
    credentials,
    () => fake(),
    new EventBus(),
  );
  const saved = await connections.save({ name: 'a', engine: 'sqlite', database: ':memory:' });
  const before = connectionIdentity(saved);
  const renamed = await connections.save({ ...saved, name: 'renamed', color: '#ff0000' } as never);
  expect(connectionIdentity(renamed)).toBe(before);
  const moved = await connections.save({ ...saved, database: 'other.db' } as never);
  expect(connectionIdentity(moved)).not.toBe(before);
});

it('an idle database scope is reclaimed instead of locking out new ones', async () => {
  const disconnected: string[] = [];
  const connections = new ConnectionService(
    new MemoryStore([]),
    credentials,
    (c) => ({ ...fake(), disconnect: async () => void disconnected.push(c.database) }),
    new EventBus(),
  );
  const saved = await connections.save({ name: 'a', engine: 'mysql', database: 'home' });
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    await connections.connect(saved.id);
    for (let i = 1; i < 8; i++) await connections.connect(saved.id, `db${i}`);
    clock.mockReturnValue(now + 60_000);
    await connections.connect(saved.id, 'db8');
    expect(disconnected).toEqual(['db1']);
    expect(connections.status(saved.id).connected).toBe(true);
    // Scopes used within the last few seconds are never taken away.
    clock.mockReturnValue(now + 60_001);
    for (let i = 9; i < 20; i++)
      await connections.connect(saved.id, `db${i}`).catch(() => undefined);
    await expect(connections.connect(saved.id, 'db99')).rejects.toThrow('At most 8');
    expect(disconnected).not.toContain('home');
  } finally {
    clock.mockRestore();
    await connections.shutdown();
  }
});
