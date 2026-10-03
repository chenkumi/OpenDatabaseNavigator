import { afterEach, describe, expect, it, vi } from 'vitest';
import { CursorStore } from '../src/main/application/services/cursor-store';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';
import { DEFAULT_SETTINGS, type Actor, type Settings } from '../src/shared/types';
import { analyzeSql } from '../src/main/security/sql-policy';
import { CredentialService } from '../src/main/credentials/credential-service';
import { SqlBuilder } from '../src/main/database/sql-builder';
import { redact } from '../src/main/security/redact';
import { assertSingleStatement } from '../src/main/security/single-statement';
import { ResultCollector } from '../src/main/database/adapters/network/common';
import { WorkspaceService } from '../src/main/application/services/workspace-service';
import { EventBus } from '../src/main/application/events/event-bus';
import type { Workspace } from '../src/shared/types';

const agent: Actor = { kind: 'agent', id: 'test-agent', name: 'Test Agent' };
const applications: Application[] = [];
function fixture(settings: Settings = structuredClone(DEFAULT_SETTINGS)) {
  const secrets = new Map<string, string>();
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(settings),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    {
      get: (id) => secrets.get(id),
      set: (id, value) => {
        secrets.set(id, value);
      },
      delete: (id) => {
        secrets.delete(id);
      },
    },
    (connection) => new SqliteAdapter(connection.database),
  );
  applications.push(app);
  return app;
}
async function setup(app: Application, access: 'disabled' | 'read' | 'write' = 'write') {
  const connection = await app.connections.save({
    name: 'Test SQLite',
    engine: 'sqlite',
    database: ':memory:',
    agentAccess: access,
  });
  const created = await app.commands.dispatch(
    'query.execute',
    {
      connectionId: connection.id,
      sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER DEFAULT 0)',
    },
    HUMAN,
  );
  expect(created.success).toBe(true);
  return connection.id;
}
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.connections.shutdown()));
});

describe('shared application services', () => {
  it('redacts persisted SQL drafts while retaining live editor text and omitting results', () => {
    const store = new MemoryStore<Workspace>({ tabs: [] });
    const workspace = new WorkspaceService(
      store,
      new EventBus(),
      (value) => redact(value) as typeof value,
    );
    const sql = "ALTER USER app PASSWORD 'private-value'";
    const tab = workspace.open({
      type: 'query',
      title: 'Credential SQL',
      connectionId: 'test',
      sql,
    });
    workspace.update(tab.id, { selectedRows: [{ private: 'selected data' }] });
    expect(workspace.get().tabs[0].sql).toBe(sql);
    expect(JSON.stringify(store.read())).not.toContain('private-value');
    expect(store.read().tabs[0].selectedRows).toEqual([]);
  });
  it('bounds UTF-8 result pages and rejects an oversized row without breaking the connection', async () => {
    const size = Buffer.byteLength(JSON.stringify({ value: '中' }));
    const collector = new ResultCollector(100, size * 2);
    expect(collector.add({ value: '中' })).toBe(true);
    expect(collector.add({ value: '中' })).toBe(true);
    expect(collector.add({ value: '中' })).toBe(false);
    expect(collector.finish()).toMatchObject({ rowCount: 2, hasMore: true });
    expect(() => new ResultCollector(100, size - 1).add({ value: '中' })).toThrow('response limit');
    const app = fixture();
    const connectionId = await setup(app);
    const adapter = await app.connections.connect(connectionId);
    const options = { limit: 100, timeout: 30000, readOnly: true };
    const large = 'x'.repeat(4 * 1024 * 1024);
    const page = await adapter.query(
      'SELECT ? AS value UNION ALL SELECT ? AS value',
      [large, large],
      options,
    );
    expect(page).toMatchObject({ rowCount: 1, hasMore: true });
    const next = await adapter.query(
      'SELECT ? AS value UNION ALL SELECT ? AS value',
      [large, large],
      { ...options, offset: 1 },
    );
    expect(next).toMatchObject({ rowCount: 1, hasMore: false });
    await expect(
      adapter.query('SELECT ? AS value', ['x'.repeat(8 * 1024 * 1024)], options),
    ).rejects.toThrow('response limit');
    expect(await adapter.query('SELECT 1 AS alive', [], options)).toMatchObject({ rowCount: 1 });
  });
  it('enforces one SQL statement without confusing literals, identifiers or comments', async () => {
    for (const engine of ['sqlite', 'mysql', 'postgres', 'sqlserver'] as const) {
      expect(() =>
        assertSingleStatement("SELECT ';' AS value; -- trailing comment", engine),
      ).not.toThrow();
      expect(() =>
        assertSingleStatement('SELECT 1; /* comment */ DELETE FROM users', engine),
      ).toThrow('Only one');
    }
    expect(() => assertSingleStatement('SELECT $$literal;value$$;', 'postgres')).not.toThrow();
    expect(() => assertSingleStatement('SELECT 1 AS [semi;colon];', 'sqlserver')).not.toThrow();
    const app = fixture();
    const connectionId = await setup(app);
    expect(
      (
        await app.commands.dispatch(
          'query.execute',
          { connectionId, sql: "INSERT INTO users(name) VALUES ('bad'); DELETE FROM users" },
          HUMAN,
        )
      ).success,
    ).toBe(false);
    expect(
      (await app.commands.dispatch('data.select', { connectionId, table: 'users' }, HUMAN)).data,
    ).toMatchObject({ rowCount: 0 });
  });
  it('redacts SQL credentials, connection URLs, bearer headers and known secrets', () => {
    for (const text of [
      "ALTER USER app WITH PASSWORD 'never-reveal'",
      "CREATE USER app IDENTIFIED BY 'never-reveal'",
      'postgres://app:never-reveal@localhost/db',
      'Authorization: Bearer never-reveal',
      'driver failed with never-reveal',
    ])
      expect(JSON.stringify(redact({ text }, ['never-reveal']))).not.toContain('never-reveal');
    expect(redact("ALTER USER app PASSWORD 'unknown-secret'")).not.toContain('unknown-secret');
    expect(redact("CREATE USER app IDENTIFIED BY 'unknown-secret'")).not.toContain(
      'unknown-secret',
    );
    expect(redact('postgres://app:unknown-secret@localhost/db')).not.toContain('unknown-secret');
    expect(redact('Bearer unknown-secret')).not.toContain('unknown-secret');
    expect(redact('Authorization: Bearer unknown-secret')).not.toContain('unknown-secret');
  });
  it('paginates queries with actor-scoped single-use cursors and shares continuation with the desktop', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    for (const name of ['One', 'Two', 'Three'])
      await app.commands.dispatch(
        'data.insert',
        { connectionId, table: 'users', values: { name } },
        HUMAN,
      );
    const first = await app.commands.dispatch(
      'query.read',
      { connectionId, sql: 'SELECT name FROM users ORDER BY id', limit: 1, showInApp: true },
      agent,
    );
    expect(first.data).toMatchObject({ rows: [{ name: 'One' }], hasMore: true });
    const cursor = (first.data as any).nextCursor;
    expect(
      (
        await app.commands.dispatch(
          'query.next',
          { connectionId, cursor },
          { ...agent, id: 'other-agent' },
        )
      ).success,
    ).toBe(false);
    const second = await app.commands.dispatch('query.next', { connectionId, cursor }, HUMAN);
    expect(second.data).toMatchObject({ rows: [{ name: 'Two' }], hasMore: true });
    expect(app.workspace.get().tabs).toHaveLength(1);
    expect(app.workspace.get().tabs[0].result?.rows).toEqual([{ name: 'Two' }]);
    expect(
      (await app.commands.dispatch('query.next', { connectionId, cursor }, HUMAN)).success,
    ).toBe(false);
    const third = await app.commands.dispatch(
      'query.next',
      { connectionId, cursor: (second.data as any).nextCursor },
      HUMAN,
    );
    expect(third.data).toMatchObject({ rows: [{ name: 'Three' }], hasMore: false });
  });
  it('revalidates access before cursor continuation and prohibits changing a SQLite file via scope', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    const first = await app.commands.dispatch(
      'query.read',
      { connectionId, sql: 'SELECT 1 AS n UNION ALL SELECT 2', limit: 1 },
      agent,
    );
    await app.connections.save({ ...app.connections.get(connectionId), agentAccess: 'disabled' });
    expect(
      (
        await app.commands.dispatch(
          'query.next',
          { connectionId, cursor: (first.data as any).nextCursor },
          agent,
        )
      ).success,
    ).toBe(false);
    expect(
      (
        await app.commands.dispatch(
          'query.read',
          { connectionId, database: 'another-file.sqlite', sql: 'SELECT 1' },
          HUMAN,
        )
      ).success,
    ).toBe(false);
  });
  it('allows verified EXPLAIN and blocks EXPLAIN of writes', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    const result = await app.commands.dispatch(
      'query.read',
      { connectionId, sql: 'EXPLAIN QUERY PLAN SELECT * FROM users' },
      agent,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).rows.length).toBeGreaterThan(0);
    expect(analyzeSql('EXPLAIN DELETE FROM users', 'sqlite').risk).not.toBe('read');
    expect(analyzeSql('EXPLAIN ANALYZE DELETE FROM users', 'postgres').risk).not.toBe('read');
  });
  it('expires cursors and bounds the number of stored continuations', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const store = new CursorStore<number>(100, 1);
      const scope = { actorId: 'a', connectionId: 'c', operation: 'query' };
      const cursor = store.put(scope, 42);
      expect(() => store.put(scope, 43)).toThrow('Too many');
      now.mockReturnValue(1101);
      expect(() => store.take(cursor, scope)).toThrow('expired');
      expect(store.take(store.put(scope, 44), scope)).toBe(44);
    } finally {
      now.mockRestore();
    }
  });
  it('runs CRUD through the same bus, parameterizes values and publishes workspace events', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    const events: string[] = [];
    app.events.subscribe((event) => events.push(event.type));
    const name = "Alice'); DROP TABLE users; --";
    expect(
      (
        await app.commands.dispatch(
          'data.insert',
          { connectionId, table: 'users', values: { name } },
          HUMAN,
        )
      ).success,
    ).toBe(true);
    const selected = await app.commands.dispatch(
      'data.select',
      { connectionId, table: 'users' },
      agent,
    );
    expect(selected.data).toMatchObject({ rowCount: 1, rows: [{ name }] });
    const opened = await app.commands.dispatch(
      'app.open_table',
      { connectionId, table: 'users' },
      agent,
    );
    expect(opened.success).toBe(true);
    expect(app.workspace.get().tabs[0].table).toBe('users');
    expect(events).toContain('TableOpened');
    const updated = await app.commands.dispatch(
      'data.update',
      {
        connectionId,
        table: 'users',
        values: { name: 'Bob' },
        filters: [{ column: 'id', operator: '=', value: 1 }],
      },
      HUMAN,
    );
    expect(updated.data).toMatchObject({ affectedRows: 1 });
    expect(
      (await app.commands.dispatch('table.describe', { connectionId, table: 'users' }, HUMAN)).data,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', primaryKey: true }),
        expect.objectContaining({ name: 'score', defaultValue: '0' }),
      ]),
    );
    expect(
      (
        await app.commands.dispatch(
          'data.delete',
          { connectionId, table: 'users', filters: [{ column: 'id', operator: '=', value: 1 }] },
          HUMAN,
        )
      ).data,
    ).toMatchObject({ affectedRows: 1 });
  });
  it('binds approvals to exact commands, only allows human resolution and consumes them once', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    const pending = await app.commands.dispatch(
      'data.insert',
      { connectionId, table: 'users', values: { name: 'Approved' } },
      agent,
    );
    expect(pending.approvalId).toBeTruthy();
    expect(
      (await app.commands.dispatch('data.select', { connectionId, table: 'users' }, HUMAN)).data,
    ).toMatchObject({ rowCount: 0 });
    expect((await app.commands.resolveApproval(pending.approvalId!, true, agent)).success).toBe(
      false,
    );
    expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
      true,
    );
    expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
      false,
    );
    expect(
      (await app.commands.dispatch('data.select', { connectionId, table: 'users' }, HUMAN)).data,
    ).toMatchObject({ rowCount: 1 });
  });
  it('rechecks revoked permissions at approval execution time', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    const pending = await app.commands.dispatch(
      'data.insert',
      { connectionId, table: 'users', values: { name: 'Blocked' } },
      agent,
    );
    await app.connections.save({ ...app.connections.get(connectionId), agentAccess: 'read' });
    expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
      false,
    );
  });
  it('limits temporary approval to the same agent, operation and target, then expires it', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    const input = { connectionId, table: 'users', values: { name: 'First' } };
    const pending = await app.commands.dispatch('data.insert', input, agent);
    expect(
      (await app.commands.resolveApproval(pending.approvalId!, true, HUMAN, 'session')).success,
    ).toBe(true);
    app.events.emit('ConnectionChanged', { connectionId, connected: true });
    expect(
      (await app.commands.dispatch('data.insert', { ...input, values: { name: 'Second' } }, agent))
        .success,
    ).toBe(true);
    expect(
      (await app.commands.dispatch('data.insert', input, { ...agent, id: 'another-session' }))
        .approvalId,
    ).toBeTruthy();
    expect(
      (await app.commands.dispatch('data.insert', { ...input, table: 'another_table' }, agent))
        .approvalId,
    ).toBeTruthy();
    expect(
      (
        await app.commands.dispatch(
          'data.update',
          { ...input, filters: [{ column: 'id', operator: '=', value: 1 }] },
          agent,
        )
      ).approvalId,
    ).toBeTruthy();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000);
    try {
      expect((await app.commands.dispatch('data.insert', input, agent)).approvalId).toBeTruthy();
    } finally {
      clock.mockRestore();
    }
    expect(
      app.audit
        .list()
        .some((entry) => entry.approvalId === pending.approvalId && entry.status === 'success'),
    ).toBe(true);
  });
  it('revokes temporary grants when settings change and always asks for destructive actions', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    const input = { connectionId, table: 'users', values: { name: 'First' } };
    const pending = await app.commands.dispatch('data.insert', input, agent);
    await app.commands.resolveApproval(pending.approvalId!, true, HUMAN, 'session');
    const settings = structuredClone(DEFAULT_SETTINGS);
    await app.commands.dispatch('settings.save', settings, HUMAN);
    expect((await app.commands.dispatch('data.insert', input, agent)).approvalId).toBeTruthy();
    settings.policy.destructive = 'ask';
    await app.commands.dispatch('settings.save', settings, HUMAN);
    const destructive = await app.commands.dispatch(
      'query.execute',
      { connectionId, sql: 'DELETE FROM users' },
      agent,
    );
    expect(destructive.approvalId).toBeTruthy();
    expect(
      (await app.commands.resolveApproval(destructive.approvalId!, true, HUMAN, 'session')).success,
    ).toBe(false);
    expect((await app.commands.resolveApproval(destructive.approvalId!, true, HUMAN)).success).toBe(
      true,
    );
    expect(
      (
        await app.commands.dispatch(
          'query.execute',
          { connectionId, sql: 'DELETE FROM users' },
          agent,
        )
      ).approvalId,
    ).toBeTruthy();
  });
  it('rejects and expires pending approvals without executing their commands', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    const input = { connectionId, table: 'users', values: { name: 'Never inserted' } };
    const rejected = await app.commands.dispatch('data.insert', input, agent);
    expect((await app.commands.resolveApproval(rejected.approvalId!, false, HUMAN)).success).toBe(
      true,
    );
    expect((await app.commands.resolveApproval(rejected.approvalId!, true, HUMAN)).success).toBe(
      false,
    );
    const pending = await app.commands.dispatch('data.insert', input, agent);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000);
    try {
      expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
        false,
      );
    } finally {
      clock.mockRestore();
    }
    expect(
      (await app.commands.dispatch('data.select', { connectionId, table: 'users' }, HUMAN)).data,
    ).toMatchObject({ rowCount: 0 });
  });
  it('hides disabled connections and their workspace context', async () => {
    const app = fixture();
    const connectionId = await setup(app, 'disabled');
    await app.commands.dispatch('app.open_table', { connectionId, table: 'users' }, HUMAN);
    expect((await app.commands.dispatch('connection.list', {}, agent)).data).toEqual([]);
    expect((await app.commands.dispatch('app.get_state', {}, agent)).data).toMatchObject({
      tabs: [],
      selectedRows: [],
    });
    expect((await app.commands.dispatch('table.list', { connectionId }, agent)).success).toBe(
      false,
    );
    expect((await app.commands.dispatch('settings.save', DEFAULT_SETTINGS, agent)).success).toBe(
      false,
    );
  });
  it('enforces read-only, observe and destructive policies', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.agentLevel = 'execute';
    settings.policy.destructive = 'allow';
    const app = fixture(settings);
    const connectionId = await setup(app, 'read');
    expect(
      (
        await app.commands.dispatch(
          'query.execute',
          { connectionId, sql: 'DELETE FROM users' },
          agent,
        )
      ).success,
    ).toBe(false);
    expect(
      (await app.commands.dispatch('query.read', { connectionId, sql: 'DELETE FROM users' }, agent))
        .success,
    ).toBe(false);
    await app.connections.save({ ...app.connections.get(connectionId), agentAccess: 'write' });
    expect(
      (
        await app.commands.dispatch(
          'query.execute',
          { connectionId, sql: 'DELETE FROM users' },
          agent,
        )
      ).approvalId,
    ).toBeTruthy();
    settings.agentLevel = 'observe';
    await app.commands.dispatch('settings.save', settings, HUMAN);
    expect(
      (await app.commands.dispatch('app.open_query', { connectionId, sql: 'SELECT 1' }, agent))
        .success,
    ).toBe(false);
  });
  it('guards dirty tabs and maintains valid tab order', () => {
    const app = fixture();
    const first = app.workspace.open({ type: 'query', title: 'A', connectionId: 'c', sql: '' });
    const second = app.workspace.open({ type: 'query', title: 'B', connectionId: 'c', sql: '' });
    app.workspace.update(first.id, { dirty: true });
    expect(() => app.workspace.close(first.id)).toThrow('Unsaved');
    expect(() => app.workspace.reorder([first.id, first.id])).toThrow();
    app.workspace.reorder([second.id, first.id]);
    expect(app.workspace.get().tabs[0].id).toBe(second.id);
    app.workspace.close(first.id, true);
    expect(app.workspace.get().tabs).toHaveLength(1);
  });
  it('omits credentials from connection results and redacts audit arguments', async () => {
    const app = fixture();
    await app.commands.dispatch(
      'connection.save',
      { name: 'Secret', engine: 'sqlite', database: ':memory:', password: 'TOP-SECRET-123' },
      HUMAN,
    );
    expect(JSON.stringify(app.connections.list())).not.toContain('TOP-SECRET-123');
    expect(JSON.stringify(app.audit.list())).not.toContain('TOP-SECRET-123');
  });
  it('redacts an unsaved test password and sanitizes history and agent results', async () => {
    const app = fixture();
    await app.commands.dispatch(
      'connection.test',
      { name: 'Test secret', engine: 'sqlite', database: ':memory:', password: 'UNSAVED-PASSWORD' },
      HUMAN,
    );
    expect(JSON.stringify(app.audit.list())).not.toContain('UNSAVED-PASSWORD');
    const connection = await app.connections.save({
      name: 'Secret connection',
      engine: 'sqlite',
      database: ':memory:',
      password: 'KNOWN-SECRET',
      agentAccess: 'read',
    });
    const result = await app.commands.dispatch(
      'query.read',
      { connectionId: connection.id, sql: "SELECT 'KNOWN-SECRET' AS value" },
      agent,
    );
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('KNOWN-SECRET');
    expect(JSON.stringify(app.query.listHistory())).not.toContain('KNOWN-SECRET');
  });
  it('rejecting an approval does not execute its command', async () => {
    const app = fixture();
    const connectionId = await setup(app);
    const pending = await app.commands.dispatch(
      'data.insert',
      { connectionId, table: 'users', values: { name: 'Rejected' } },
      agent,
    );
    await app.commands.resolveApproval(pending.approvalId!, false, HUMAN);
    expect(
      (await app.commands.dispatch('data.select', { connectionId, table: 'users' }, HUMAN)).data,
    ).toMatchObject({ rowCount: 0 });
    expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
      false,
    );
  });
});

describe('SQL safety and bounded execution', () => {
  it.each([
    'SELECT 1; DELETE FROM users',
    'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
    "SELECT load_extension('evil')",
    'PRAGMA query_only=OFF',
    'SELECT * INTO new_users FROM users',
  ])('does not classify unsafe SQL as read: %s', (sql) => {
    expect(analyzeSql(sql, 'sqlite').risk).not.toBe('read');
  });
  it('allows normal read queries and classifies unbounded changes', () => {
    expect(analyzeSql('SELECT u.name, COUNT(*) FROM users u GROUP BY u.name', 'sqlite').risk).toBe(
      'read',
    );
    expect(analyzeSql("UPDATE users SET name = 'A'", 'sqlite').risk).toBe('destructive');
    expect(analyzeSql('DELETE FROM users WHERE id = 1', 'sqlite').risk).toBe('delete');
  });
  it('quotes hostile identifiers and parameterizes filters for each SQL dialect', () => {
    for (const engine of ['sqlite', 'mysql', 'postgres', 'sqlserver'] as const) {
      const built = new SqlBuilder(engine).select(
        {
          table: 'users',
          filters: [{ column: 'name', operator: '=', value: "'; DROP TABLE users; --" }],
        },
        10,
      );
      expect(built.sql).not.toContain('DROP');
      expect(built.params).toContain("'; DROP TABLE users; --");
    }
  });
  it('bounds result rows and SQLite enforces read-only at the database level', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await adapter.connect();
    try {
      const result = await adapter.query(
        'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) SELECT * FROM n',
        [],
        { limit: 25, timeout: 3000, readOnly: true },
      );
      expect(result.rows).toHaveLength(25);
      expect(result.hasMore).toBe(true);
      await expect(
        adapter.query('CREATE TABLE forbidden(id INT)', [], {
          limit: 10,
          timeout: 3000,
          readOnly: true,
        }),
      ).rejects.toThrow();
    } finally {
      await adapter.disconnect();
    }
  });
  it('terminates expensive queries on timeout', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await adapter.connect();
    try {
      await expect(
        adapter.query(
          'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n',
          [],
          { limit: 1, timeout: 50, readOnly: true },
        ),
      ).rejects.toThrow('timed out');
    } finally {
      await adapter.disconnect();
    }
  });
  it('cancels a running worker query with an AbortSignal', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await adapter.connect();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    try {
      await expect(
        adapter.query(
          'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n',
          [],
          { limit: 1, timeout: 10000, readOnly: true, signal: controller.signal },
        ),
      ).rejects.toThrow('cancelled');
    } finally {
      clearTimeout(timer);
      await adapter.disconnect();
    }
  });
});

describe('credential storage', () => {
  it('never falls back to plaintext when OS encryption is unavailable', () => {
    const store = new MemoryStore<Record<string, string>>({});
    const credentials = new CredentialService(store, {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from(''),
      decryptString: () => '',
    });
    expect(() => credentials.set('db', 'password')).toThrow('unavailable');
    expect(store.read()).toEqual({});
  });
});
