import { expect, it } from 'vitest';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';
import {
  describeStructure,
  applyStructure,
  planStructure,
} from '../src/main/application/services/table-structure-service';
import { connectionSchema } from '../src/shared/schemas';
import type { StructureChange } from '../src/shared/types';
import { replaceAttribute } from '../src/main/database/structure-sql';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS } from '../src/shared/types';

it('combines properties and columns in one SQLite rebuild, then renames; failures roll back all edits', async () => {
  const adapter = new SqliteAdapter(':memory:');
  const connection = {
    ...connectionSchema.parse({ name: 'batch', engine: 'sqlite', database: ':memory:' }),
    id: 'batch',
  };
  const ref = { schema: 'main', table: 'sample' };
  const run = (sql: string) =>
    adapter.query(sql, [], { readOnly: false, limit: 100, timeout: 5000 });
  try {
    await run(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY AUTOINCREMENT, score INTEGER, note TEXT DEFAULT 'old')",
    );
    await run("INSERT INTO sample VALUES(1,7,'a'),(2,NULL,'b')");
    await run('CREATE INDEX sample_score ON sample(score)');
    await run('CREATE VIEW sample_view AS SELECT score FROM sample');
    const before = await describeStructure(adapter, connection, ref);
    const change: StructureChange = {
      action: 'edit-columns',
      changes: [
        { action: 'rename', column: 'score', name: 'points' },
        { action: 'type', column: 'score', type: 'REAL' },
        { action: 'default', column: 'note', defaultSql: "'new'" },
        { action: 'nullable', column: 'score', nullable: false },
      ],
    };
    const plan = planStructure(before, change);
    expect(plan.statements.filter((sql) => sql.startsWith('CREATE TEMP TABLE'))).toHaveLength(1);
    expect(plan.destructive).toBe(true);
    await expect(
      applyStructure(adapter, connection, ref, change, before.version, 5000),
    ).rejects.toThrow();
    expect((await describeStructure(adapter, connection, ref)).version).toBe(before.version);
    change.changes.pop();
    const after = await applyStructure(adapter, connection, ref, change, before.version, 5000);
    expect(after.columns.find((c) => c.name === 'points')).toMatchObject({
      type: 'REAL',
      nullable: true,
    });
    expect(after.columns.find((c) => c.name === 'note')?.defaultSql).toBe("'new'");
    expect((await run('SELECT * FROM sample_view')).rows).toHaveLength(2);
    expect(
      (await run("SELECT sql FROM sqlite_schema WHERE name='sample_score'")).rows[0].sql,
    ).toContain('points');
    expect((await run('SELECT * FROM sample')).rows).toHaveLength(2);
    const combined: StructureChange = {
      action: 'edit-columns',
      primaryKey: ['id', 'note'],
      changes: [
        { action: 'rename', column: 'note', name: 'label' },
        { action: 'type', column: 'note', type: 'VARCHAR(40)' },
      ],
    };
    const keyed = await applyStructure(adapter, connection, ref, combined, after.version, 5000);
    expect(keyed.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual(['id', 'label']);
    expect(keyed.columns.find((c) => c.name === 'label')).toMatchObject({
      nullable: false,
      type: 'VARCHAR(40)',
    });
    const added = await applyStructure(
      adapter,
      connection,
      ref,
      {
        action: 'add',
        name: 'tenant',
        type: 'INTEGER',
        nullable: false,
        defaultSql: '1',
        primaryKey: true,
      },
      keyed.version,
      5000,
    );
    expect(added.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual([
      'id',
      'label',
      'tenant',
    ]);
    const failed: StructureChange = {
      action: 'edit-columns',
      primaryKey: ['points'],
      changes: [{ action: 'type', column: 'label', type: 'TEXT' }],
    };
    await expect(
      applyStructure(adapter, connection, ref, failed, added.version, 5000),
    ).rejects.toThrow();
    expect((await describeStructure(adapter, connection, ref)).version).toBe(added.version);
  } finally {
    await adapter.disconnect();
  }
});

it('preserves accumulated attributes in MySQL and SQL Server plans', () => {
  for (const engine of ['mysql', 'sqlserver', 'postgres'] as const) {
    const detail: Parameters<typeof planStructure>[0] = {
      engine,
      schema: 'test',
      table: 'sample',
      kind: 'table',
      version: 'v',
      definition: "CREATE TABLE sample (`score` int NULL DEFAULT 7 COMMENT 'keep')",
      columns: [
        {
          name: 'score',
          type: 'int',
          nullable: true,
          defaultValue: 7,
          defaultSql: '7',
          primaryKey: false,
        },
      ],
      dependents: [],
      defaults: {},
      collations: {},
      prefix: [],
    };
    const plan = planStructure(detail, {
      action: 'edit-columns',
      changes: [
        { action: 'type', column: 'score', type: 'bigint' },
        { action: 'nullable', column: 'score', nullable: false },
        { action: 'default', column: 'score', defaultSql: '9' },
        { action: 'rename', column: 'score', name: 'points' },
      ],
    });
    if (engine === 'mysql') {
      expect(plan.statements).toHaveLength(1);
      expect(plan.statements[0]).toContain('bigint NOT NULL DEFAULT 9');
      expect(plan.statements[0]).toContain("COMMENT 'keep'");
      expect(plan.atomic).toBe(false);
    } else if (engine === 'sqlserver') expect(plan.statements[1]).toContain('bigint NOT NULL');
    else expect(plan.statements[1]).toContain('SET NOT NULL');
    expect(plan.statements.at(-1)).toContain('points');
  }
});

it('edits SQLite structure without losing rows, generated values, foreign-key children, indexes, triggers or sequence values', async () => {
  const adapter = new SqliteAdapter(':memory:');
  const connection = {
    ...connectionSchema.parse({ name: 'test', engine: 'sqlite', database: ':memory:' }),
    id: 'test',
  };
  const ref = { schema: 'main', table: 'items' };
  const run = (sql: string) =>
    adapter.query(sql, [], { readOnly: false, limit: 100, timeout: 5000 });
  const edit = async (change: StructureChange, table = 'items') => {
    const target = { ...ref, table };
    const before = await describeStructure(adapter, connection, target);
    return applyStructure(adapter, connection, target, change, before.version, 5000);
  };
  try {
    await run(
      "CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT 'a', score INTEGER CHECK(score>=0), upper_name TEXT GENERATED ALWAYS AS(upper(name)) STORED)",
    );
    await run(
      'CREATE TABLE child(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES items(id) ON DELETE CASCADE)',
    );
    await run('CREATE TABLE logs(value INTEGER)');
    await run('CREATE INDEX items_name ON items(name)');
    await run(
      'CREATE TRIGGER items_log AFTER INSERT ON items BEGIN INSERT INTO logs VALUES(NEW.id); END',
    );
    await run("INSERT INTO items(id,name,score) VALUES(10,'first',7),(100,'removed',8)");
    await run('DELETE FROM items WHERE id=100');
    await run('INSERT INTO child VALUES(1,10)');
    await run('CREATE VIEW item_view AS SELECT id,name,score FROM items');
    const old = await describeStructure(adapter, connection, ref);
    expect(() => planStructure(old, { action: 'primary-key', columns: ['id'] })).toThrow(
      'no primary key changes',
    );
    expect(old.columns.find((c) => c.name === 'score')).toMatchObject({
      nullable: true,
      primaryKey: false,
    });
    expect(old.columns.find((c) => c.name === 'id')).toMatchObject({
      nullable: false,
      primaryKey: true,
    });
    const current = await edit({ action: 'type', column: 'score', type: 'REAL' });
    expect(current.columns.find((c) => c.name === 'score')?.type).toBe('REAL');
    expect((await run('SELECT * FROM child')).rows).toHaveLength(1);
    expect((await run('SELECT upper_name FROM items')).rows[0].upper_name).toBe('FIRST');
    expect((await run('SELECT * FROM logs')).rows).toHaveLength(2);
    await expect(
      applyStructure(
        adapter,
        connection,
        ref,
        { action: 'drop', column: 'name' },
        old.version,
        5000,
      ),
    ).rejects.toThrow('changed since');
    await edit({ action: 'default', column: 'score', defaultSql: '9' });
    await run("INSERT INTO items(name) VALUES('next')");
    expect(Number((await run("SELECT id FROM items WHERE name='next'")).rows[0].id)).toBe(101);
    expect(Number((await run("SELECT score FROM items WHERE name='next'")).rows[0].score)).toBe(9);
    expect((await run('SELECT * FROM logs')).rows).toHaveLength(3);
    await edit({ action: 'add', name: 'extra', type: 'TEXT', nullable: true, defaultSql: '' });
    const nullable = await describeStructure(adapter, connection, ref);
    await expect(edit({ action: 'nullable', column: 'extra', nullable: false })).rejects.toThrow();
    expect((await describeStructure(adapter, connection, ref)).version).toBe(nullable.version);
    await edit({ action: 'rename', column: 'extra', name: 'notes' });
    await edit({ action: 'drop', column: 'notes' });
    await expect(edit({ action: 'drop', column: 'name' })).rejects.toThrow();
    expect((await run('SELECT * FROM item_view')).rows).toHaveLength(2);
    const view = await edit(
      {
        action: 'view',
        sql: "CREATE VIEW item_view AS SELECT id,name,score FROM items WHERE name='first'",
      },
      'item_view',
    );
    expect(view.kind).toBe('view');
    expect((await run('SELECT * FROM item_view')).rows).toHaveLength(1);
    await expect(
      edit(
        { action: 'view', sql: 'CREATE VIEW item_view AS SELECT missing FROM items' },
        'item_view',
      ),
    ).rejects.toThrow();
    expect((await run('SELECT * FROM item_view')).rows).toHaveLength(1);
    await run('CREATE TABLE plain (code TEXT NOT NULL, value TEXT)');
    await run("INSERT INTO plain(rowid,code,value) VALUES(42,'x','v')");
    await edit({ action: 'primary-key', columns: ['code'] }, 'plain');
    expect(Number((await run('SELECT rowid FROM plain')).rows[0].rowid)).toBe(42);
    expect(
      (await describeStructure(adapter, connection, { ...ref, table: 'plain' })).columns[0]
        .primaryKey,
    ).toBe(true);
    await expect(
      edit({ action: 'default', column: 'score', defaultSql: '0); DROP TABLE child; --' }),
    ).rejects.toThrow();
    expect((await run('PRAGMA foreign_keys')).rows[0].foreign_keys).toBe('1');
  } finally {
    await adapter.disconnect();
  }
});

it('preserves independent MySQL column attributes while editing a single property', () => {
  const original =
    "`name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'a b' COMMENT 'keep me'";
  expect(replaceAttribute(original, 'mysql', 'default', "DEFAULT 'next'")).toContain(
    "NOT NULL DEFAULT 'next' COMMENT 'keep me'",
  );
  expect(replaceAttribute(original, 'mysql', 'nullable', '')).toContain(
    "COLLATE utf8mb4_bin DEFAULT 'a b' COMMENT 'keep me'",
  );
  expect(replaceAttribute('`v` int DEFAULT NULL', 'mysql', 'nullable', 'NOT NULL')).toBe(
    '`v` int DEFAULT NULL NOT NULL',
  );
  expect(
    replaceAttribute("v BLOB CONSTRAINT d DEFAULT X'ABCD' NOT NULL", 'sqlite', 'default', ''),
  ).toBe('v BLOB NOT NULL');
});

it('binds structure approvals to the exact change and keeps destructive operations separate', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.policy.ddl = 'ask';
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(settings),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    { get: () => undefined, set() {}, delete() {} },
    (c) => new SqliteAdapter(c.database),
  );
  const agent = { kind: 'agent' as const, id: 'structure-test', name: 'Agent' };
  try {
    const connection = await app.connections.save({
      name: 'test',
      engine: 'sqlite',
      database: ':memory:',
      agentAccess: 'write',
    });
    const adapter = await app.connections.connect(connection.id);
    await adapter.query('CREATE TABLE sample(id INTEGER PRIMARY KEY)', [], {
      readOnly: false,
      limit: 1,
      timeout: 5000,
    });
    const ref = { connectionId: connection.id, schema: 'main', table: 'sample' };
    const detail = await describeStructure(adapter, connection, ref);
    const first = {
      ...ref,
      version: detail.version,
      change: { action: 'add', name: 'one', type: 'TEXT', nullable: true, defaultSql: '' },
    };
    const pending = await app.commands.dispatch('structure.apply', first, agent);
    expect(pending.approvalId).toBeTruthy();
    expect(
      (await app.commands.resolveApproval(pending.approvalId!, true, HUMAN, 'session')).success,
    ).toBe(true);
    const next = await describeStructure(adapter, connection, ref);
    const different = await app.commands.dispatch(
      'structure.apply',
      { ...first, version: next.version, change: { ...first.change, name: 'two' } },
      agent,
    );
    expect(different.approvalId).toBeTruthy();
    const destructive = await app.commands.dispatch(
      'structure.apply',
      { ...ref, version: next.version, change: { action: 'drop', column: 'one' } },
      agent,
    );
    expect(destructive.success).toBe(false);
    expect(destructive.approvalId).toBeUndefined();
    const combined = await app.commands.dispatch(
      'structure.apply',
      {
        ...ref,
        version: next.version,
        change: {
          action: 'edit-columns',
          changes: [
            { action: 'nullable', column: 'one', nullable: false },
            { action: 'type', column: 'one', type: 'INTEGER' },
          ],
        },
      },
      agent,
    );
    expect(combined.success).toBe(false);
    expect(combined.approvalId).toBeUndefined();
    for (const change of [
      { action: 'edit-columns', changes: [], primaryKey: ['id', 'one'] },
      {
        action: 'add',
        name: 'tenant',
        type: 'INTEGER',
        nullable: false,
        defaultSql: '1',
        primaryKey: true,
      },
    ]) {
      const denied = await app.commands.dispatch(
        'structure.apply',
        { ...ref, version: next.version, change },
        agent,
      );
      expect(denied.success).toBe(false);
      expect(denied.approvalId).toBeUndefined();
    }
    expect((await describeStructure(adapter, connection, ref)).columns.map((c) => c.name)).toEqual([
      'id',
      'one',
    ]);
  } finally {
    await app.connections.shutdown();
  }
});
