import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS, type Engine } from '../src/shared/types';
import { createAdapter } from '../src/main/database/factory';
import { SqlBuilder } from '../src/main/database/sql-builder';
import { renameDefinition } from '../src/main/database/rename-definition';
import { renameObjectSchema } from '../src/shared/rename-object';
import {
  planRenameObject,
  executeRename,
} from '../src/main/application/services/rename-object-service';

async function fixture(engine: Engine = 'sqlite', port?: number) {
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(DEFAULT_SETTINGS),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    { get: () => process.env.DB_TEST_PASSWORD, set() {}, delete() {} },
    createAdapter,
  );
  const database =
    engine === 'sqlite' ? ':memory:' : engine === 'sqlserver' ? 'master' : 'workspace';
  const schema =
    engine === 'sqlite'
      ? 'main'
      : engine === 'postgres'
        ? 'public'
        : engine === 'mysql'
          ? database
          : 'dbo';
  const connection = await app.connections.save({
    engine,
    name: 'Rename test',
    database,
    host: '127.0.0.1',
    port,
    username: engine === 'postgres' ? 'workspace' : engine === 'mysql' ? 'root' : 'sa',
    agentAccess: 'read',
  });
  const adapter = await app.connections.connect(connection.id);
  const scope = { connectionId: connection.id, database, schema };
  const call = async (name: string, args: object) => {
    const commandScope = name.endsWith('.list')
      ? { connectionId: scope.connectionId, database: scope.database }
      : scope;
    const result = await app.commands.dispatch(name, { ...commandScope, ...args }, HUMAN);
    expect(result.success, `${name}: ${result.error}`).toBe(true);
    return result.data as any;
  };
  const sql = (sql: string) =>
    adapter.query(sql, [], { readOnly: false, timeout: 30000, limit: 100 });
  const rename = async (
    kind: 'table' | 'view' | 'index' | 'trigger',
    name: string,
    newName: string,
    table = name,
  ) => {
    const args = { kind, objectName: name, newName, table };
    const plan = await call('object.rename_preview', args);
    await call('object.rename', { ...args, version: plan.version });
    return plan;
  };
  return { app, adapter, scope, connection, call, sql, rename };
}

it('SQLite renames four kinds, preserves rows/index predicates/trigger bodies, and remaps scoped clean tabs', async () => {
  const f = await fixture();
  try {
    await f.sql('CREATE TABLE sample(id INTEGER PRIMARY KEY, note TEXT)');
    await f.sql("INSERT INTO sample VALUES(1,'kept')");
    await f.sql('CREATE INDEX ix_old ON sample(note DESC) WHERE note IS NOT NULL');
    await f.sql(
      "CREATE TRIGGER tr_old AFTER INSERT ON sample BEGIN UPDATE sample SET note='tr_old' WHERE id=NEW.id; END",
    );
    await f.sql('CREATE VIEW v_old AS SELECT id,note FROM sample');
    const tab = f.app.workspace.open({
      ...f.scope,
      type: 'table',
      table: 'sample',
      title: 'sample',
      sql: '',
    });
    const index = f.app.workspace.open({
      ...f.scope,
      type: 'index',
      table: 'sample',
      objectName: 'ix_old',
      title: 'ix_old',
      sql: '',
    });
    const query = f.app.workspace.open({
      ...f.scope,
      type: 'query',
      title: 'query',
      sql: 'SELECT * FROM sample',
    });
    const other = f.app.workspace.open({
      ...f.scope,
      database: 'different',
      type: 'table',
      table: 'sample',
      title: 'sample',
      sql: '',
    });
    f.app.workspace.activate(index.id);
    await f.rename('index', 'ix_old', 'ix_new', 'sample');
    expect(
      (await f.sql("SELECT sql FROM sqlite_schema WHERE name='ix_new'")).rows[0].sql,
    ).toContain('note DESC) WHERE note IS NOT NULL');
    await f.rename('trigger', 'tr_old', 'tr_new', 'sample');
    await f.sql('INSERT INTO sample(id) VALUES(2)');
    expect((await f.sql('SELECT note FROM sample WHERE id=2')).rows[0].note).toBe('tr_old');
    await f.rename('view', 'v_old', 'v_new');
    expect((await f.sql('SELECT * FROM v_new')).rows).toHaveLength(2);
    await f.rename('table', 'sample', 'renamed table');
    expect((await f.sql('SELECT * FROM "renamed table"')).rows).toHaveLength(2);
    expect((await f.sql('SELECT * FROM v_new')).rows).toHaveLength(2);
    const state = f.app.workspace.get();
    expect(state.tabs.map((t) => t.type)).toEqual(['table', 'index', 'query', 'table']);
    expect(state.tabs[0]).toMatchObject({ table: 'renamed table', title: 'renamed table' });
    expect(state.tabs[0].id).not.toBe(tab.id);
    expect(state.tabs[1]).toMatchObject({ table: 'renamed table', objectName: 'ix_new' });
    expect(state.activeTab).toBe(state.tabs[1].id);
    expect(state.tabs[2]).toEqual(query);
    expect(state.tabs[3]).toEqual(other);
  } finally {
    await f.app.connections.shutdown();
  }
});

it('rename checks drafts, source version, new-name collisions and agent DDL permissions', async () => {
  const f = await fixture();
  try {
    await f.sql('CREATE TABLE sample(id INTEGER)');
    const args = {
      ...f.scope,
      kind: 'table',
      objectName: 'sample',
      table: 'sample',
      newName: 'renamed',
    };
    const plan = await f.call('object.rename_preview', args);
    const tab = f.app.workspace.open({
      ...f.scope,
      type: 'table',
      title: 'sample',
      table: 'sample',
      sql: '',
    });
    f.app.workspace.update(tab.id, { dirty: true });
    const dirty = await f.app.commands.dispatch(
      'object.rename',
      { ...args, version: plan.version },
      HUMAN,
    );
    expect(dirty.error).toContain('Unsaved changes');
    f.app.workspace.update(tab.id, { dirty: false });
    const denied = await f.app.commands.dispatch(
      'object.rename',
      { ...args, version: plan.version },
      { kind: 'agent', id: 'reader', name: 'Reader' },
    );
    expect(denied.success).toBe(false);
    await f.sql('ALTER TABLE sample ADD COLUMN note TEXT');
    expect(
      (await f.app.commands.dispatch('object.rename', { ...args, version: plan.version }, HUMAN))
        .error,
    ).toContain('Object changed');
    await f.sql('CREATE TABLE renamed(id INTEGER)');
    expect((await f.app.commands.dispatch('object.rename_preview', args, HUMAN)).error).toContain(
      'already exists',
    );
    expect((await f.adapter.tables('main')).map((t) => t.name)).toEqual(['renamed', 'sample']);
    expect(renameObjectSchema.safeParse({ ...args, newName: ' bad ' }).success).toBe(false);
    expect(renameObjectSchema.safeParse({ ...args, newName: 'bad\0name' }).success).toBe(false);
  } finally {
    await f.app.connections.shutdown();
  }
});

it('SQLite view rename preserves its INSTEAD OF trigger and refuses ambiguous dependencies', async () => {
  const f = await fixture();
  try {
    await f.sql('CREATE TABLE sample(id INTEGER)');
    await f.sql('CREATE VIEW v_old AS SELECT id FROM sample');
    await f.sql(
      'CREATE TRIGGER write_view INSTEAD OF INSERT ON v_old BEGIN INSERT INTO sample VALUES(NEW.id); END',
    );
    await f.sql('CREATE VIEW dependent AS SELECT * FROM v_old');
    await expect(f.rename('view', 'v_old', 'v_new')).rejects.toThrow('referenced');
    await f.sql('DROP VIEW dependent');
    await f.rename('view', 'v_old', 'v_new');
    await f.sql('INSERT INTO v_new VALUES(7)');
    expect((await f.sql('SELECT * FROM sample')).rows).toEqual([{ id: '7' }]);
    expect(
      (await f.sql("SELECT tbl_name FROM sqlite_schema WHERE name='write_view'")).rows[0].tbl_name,
    ).toBe('v_new');
  } finally {
    await f.app.connections.shutdown();
  }
});

it('definition renaming changes only the header and removes IF NOT EXISTS to fail on concurrent collisions', () => {
  const sql = 'CREATE INDEX IF NOT EXISTS "old" ON sample(note) WHERE note=\'old\'';
  expect(renameDefinition(sql, 'sqlite', 'index', '"main"."new"')).toBe(
    'CREATE INDEX "main"."new" ON sample(note) WHERE note=\'old\'',
  );
  expect(
    renameDefinition(
      "CREATE OR ALTER VIEW dbo.old AS SELECT 'old' AS value",
      'sqlserver',
      'view',
      '[dbo].[new]',
    ),
  ).toBe("CREATE OR ALTER VIEW [dbo].[new] AS SELECT 'old' AS value");
});

it('SQLite rebuild rolls back a concurrent destination collision, and quoted new names cannot execute SQL', async () => {
  const f = await fixture();
  try {
    await f.sql('CREATE TABLE sample(id INTEGER)');
    await f.sql('CREATE INDEX IF NOT EXISTS ix_old ON sample(id)');
    const input = {
      ...f.scope,
      kind: 'index' as const,
      objectName: 'ix_old',
      table: 'sample',
      newName: 'ix_new',
    };
    const plan = await planRenameObject(f.adapter, f.connection, input);
    await f.sql('CREATE INDEX ix_new ON sample(id DESC)');
    await expect(executeRename(f.adapter, plan, 5000)).rejects.toThrow('already exists');
    expect(
      (await f.sql("SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name")).rows.map(
        (row) => row.name,
      ),
    ).toEqual(['ix_new', 'ix_old']);
    const name = 'renamed"; DROP TABLE sample;--';
    await f.rename('table', 'sample', name);
    expect((await f.adapter.tables('main')).map((t) => t.name)).toEqual([name]);
  } finally {
    await f.app.connections.shutdown();
  }
});

for (const config of [
  { engine: 'postgres' as const, port: 15432 },
  { engine: 'mysql' as const, port: 13306 },
  { engine: 'mysql' as const, port: 13307 },
  { engine: 'sqlserver' as const, port: 11433 },
])
  it.skipIf(process.env.DB_INTEGRATION !== '1')(
    `real rename lifecycle: ${config.engine}:${config.port}`,
    async () => {
      const f = await fixture(config.engine, config.port);
      const b = new SqlBuilder(config.engine),
        q = (name: string) => b.table({ schema: f.scope.schema, table: name });
      const name = 'rename_' + randomUUID().replaceAll('-', '').slice(0, 10);
      let table = name,
        view = name + '_v',
        index = name + '_i',
        trigger = name + '_tr';
      const fn = trigger + '_fn';
      try {
        await f.call('object.create', {
          kind: 'table',
          name: table,
          columns: [
            { name: 'id', type: 'INT', nullable: false, primaryKey: true },
            { name: 'note', type: 'VARCHAR(60)', nullable: true, primaryKey: false },
          ],
        });
        await f.call('object.create', {
          kind: 'view',
          name: view,
          selectSql: `SELECT * FROM ${q(table)}`,
        });
        await f.call('object.create', {
          kind: 'index',
          name: index,
          table,
          indexColumns: [{ name: 'note', descending: true }],
        });
        await f.call('object.create', {
          kind: 'trigger',
          name: trigger,
          table,
          timing: config.engine === 'sqlserver' ? 'AFTER' : 'BEFORE',
          event: 'INSERT',
          body:
            config.engine === 'postgres'
              ? "NEW.note := 'triggered'; RETURN NEW;"
              : config.engine === 'mysql'
                ? "SET NEW.note = 'triggered';"
                : `UPDATE t SET note='triggered' FROM ${q(table)} t JOIN inserted i ON i.id=t.id;`,
        });
        for (const kind of ['view', 'index', 'trigger'] as const) {
          const old = kind === 'view' ? view : kind === 'index' ? index : trigger;
          await f.rename(kind, old, old + '_new', table);
          if (kind === 'view') view += '_new';
          else if (kind === 'index') index += '_new';
          else trigger += '_new';
        }
        await f.sql(`INSERT INTO ${q(table)} (id) VALUES(1)`);
        expect((await f.sql(`SELECT note FROM ${q(view)}`)).rows[0].note).toBe('triggered');
        const viewDefinition = await f.call('structure.describe', { table: view });
        expect(viewDefinition.definition).toContain(view);
        await f.call('structure.apply', {
          table: view,
          version: viewDefinition.version,
          change: { action: 'view', sql: viewDefinition.definition },
        });
        const triggerDefinition = await f.call('object.describe', {
          kind: 'trigger',
          table,
          objectName: trigger,
        });
        expect(triggerDefinition.editableSql).toContain(trigger);
        await f.call('object.apply', {
          kind: 'trigger',
          table,
          objectName: trigger,
          version: triggerDefinition.version,
          sql: triggerDefinition.editableSql,
        });
        await f.sql(`DROP VIEW ${q(view)}`);
        // Native table rename preserves data/indexes, but does not rewrite all routine bodies.
        await f.rename('table', table, table + '_new');
        table += '_new';
        expect((await f.sql(`SELECT note FROM ${q(table)}`)).rows[0].note).toBe('triggered');
        expect(
          (await f.call('index.list', {})).some((i: any) => i.name === index && i.table === table),
        ).toBe(true);
      } finally {
        await f.sql(`DROP VIEW ${q(view)}`).catch(() => undefined);
        await f.sql(`DROP TABLE ${q(table)}`).catch(() => undefined);
        if (config.engine === 'postgres')
          await f.sql(`DROP FUNCTION ${q(fn)}()`).catch(() => undefined);
        await f.app.connections.shutdown();
      }
    },
    90000,
  );
