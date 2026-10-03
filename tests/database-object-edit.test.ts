import { expect, it } from 'vitest';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { assertSqliteTrigger, mysqlIndexClause } from '../src/main/database/object-sql';

it('edits SQLite indexes and compound triggers atomically with conflict and permission checks', async () => {
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(structuredClone(DEFAULT_SETTINGS)),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    { get: () => undefined, set() {}, delete() {} },
    (c) => new SqliteAdapter(c.database),
  );
  const connection = await app.connections.save({
    name: 'test',
    engine: 'sqlite',
    database: ':memory:',
    agentAccess: 'write',
  });
  const adapter = await app.connections.connect(connection.id);
  const run = (sql: string) =>
    adapter.query(sql, [], { limit: 100, timeout: 5000, readOnly: false });
  const call = async (name: string, args: object) => {
    const result = await app.commands.dispatch(name, args, HUMAN);
    expect(result.success, result.error).toBe(true);
    return result.data as any;
  };
  const index = {
    connectionId: connection.id,
    schema: 'main',
    table: 'items',
    objectName: 'items_idx',
    kind: 'index',
  };
  const trigger = { ...index, objectName: 'items_trg', kind: 'trigger' };
  try {
    await run('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT UNIQUE, score INTEGER)');
    await run('CREATE INDEX items_idx ON items(name)');
    await run(
      'CREATE TRIGGER items_trg AFTER INSERT ON items BEGIN UPDATE items SET score=1 WHERE id=NEW.id; END',
    );
    const before = await call('object.describe', index);
    const changed = before.editableSql.replace('(name)', '(score DESC) WHERE score IS NOT NULL');
    const plan = await call('object.preview', { ...index, sql: changed });
    expect(plan.atomic).toBe(true);
    expect(plan.statements[0]).toContain('DROP INDEX "main"."items_idx"');
    const denied = await app.commands.dispatch(
      'object.apply',
      { ...index, sql: changed, version: before.version },
      { kind: 'agent', id: 'test-agent', name: 'Agent' },
    );
    expect(denied.success).toBe(false);
    expect((await call('object.describe', index)).version).toBe(before.version);
    const updated = await call('object.apply', { ...index, sql: changed, version: before.version });
    expect(updated.editableSql).toContain('score DESC');
    const stale = await app.commands.dispatch(
      'object.apply',
      { ...index, sql: changed, version: before.version },
      HUMAN,
    );
    expect(stale.error).toContain('changed since');
    const invalid = await app.commands.dispatch(
      'object.apply',
      { ...index, sql: changed.replace('score DESC', 'missing_column'), version: updated.version },
      HUMAN,
    );
    expect(invalid.success).toBe(false);
    expect((await call('object.describe', index)).version).toBe(updated.version);
    const originalTrigger = await call('object.describe', trigger);
    const sql =
      'CREATE TRIGGER items_trg AFTER INSERT ON items BEGIN UPDATE items SET score=CASE WHEN NEW.score IS NULL THEN 42 ELSE NEW.score END WHERE id=NEW.id; SELECT 2; END';
    const afterTrigger = await call('object.apply', {
      ...trigger,
      sql,
      version: originalTrigger.version,
    });
    await run("INSERT INTO items(id,name) VALUES(1,'a')");
    expect((await run('SELECT score FROM items')).rows[0].score).toBe('42');
    const broken = await app.commands.dispatch(
      'object.apply',
      { ...trigger, sql: sql.replace('SELECT 2', 'INVALID SQL'), version: afterTrigger.version },
      HUMAN,
    );
    expect(broken.success).toBe(false);
    expect((await call('object.describe', trigger)).version).toBe(afterTrigger.version);
    const injected = await app.commands.dispatch(
      'object.apply',
      { ...trigger, sql: sql + '; DROP TABLE items', version: afterTrigger.version },
      HUMAN,
    );
    expect(injected.success).toBe(false);
    const renamed = await app.commands.dispatch(
      'object.preview',
      { ...trigger, sql: sql.replace('items_trg', 'wrong') },
      HUMAN,
    );
    expect(renamed.success).toBe(false);
    const auto = await call('object.describe', {
      ...index,
      objectName: 'sqlite_autoindex_items_1',
    });
    expect(auto.readOnlyReason).toBeTruthy();
    expect(
      (
        await app.commands.dispatch(
          'object.apply',
          { ...index, objectName: auto.name, sql: changed, version: auto.version },
          HUMAN,
        )
      ).success,
    ).toBe(false);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.policy.ddl = 'ask';
    await call('settings.save', settings);
    const request = await app.commands.dispatch(
      'object.apply',
      { ...trigger, sql: sql.replace('THEN 42', 'THEN 43'), version: afterTrigger.version },
      { kind: 'agent', id: 'test-agent', name: 'Agent' },
    );
    expect(request.approvalId).toBeTruthy();
    expect((await call('object.describe', trigger)).version).toBe(afterTrigger.version);
    const approved = await app.commands.resolveApproval(request.approvalId!, true, HUMAN);
    expect(approved.success, approved.error).toBe(true);
    await run("INSERT INTO items(id,name) VALUES(2,'approved')");
    expect((await run('SELECT score FROM items WHERE id=2')).rows[0].score).toBe('43');
  } finally {
    await app.connections.shutdown();
  }
});

it('handles nested expressions and quoted delimiters without accepting extra SQLite statements', () => {
  expect(
    mysqlIndexClause(
      'CREATE TABLE `x` (`v` varchar(20), UNIQUE KEY `idx` (`v`(10) DESC), KEY `other` (`v`))',
      'idx',
    ),
  ).toBe('UNIQUE KEY `idx` (`v`(10) DESC)');
  expect(
    mysqlIndexClause('CREATE TABLE `x` (`v` int, KEY `idx` (`v`) /*!80000 INVISIBLE */)', 'idx'),
  ).toBe('KEY `idx` (`v`) /*!80000 INVISIBLE */');
  expect(() =>
    assertSqliteTrigger(
      "CREATE TRIGGER x AFTER INSERT ON y BEGIN SELECT 'END;'; SELECT CASE WHEN 1 THEN 2 END; END;",
    ),
  ).not.toThrow();
  expect(() =>
    assertSqliteTrigger('CREATE TRIGGER x AFTER INSERT ON y BEGIN SELECT 1; END; DELETE FROM y'),
  ).toThrow();
});
