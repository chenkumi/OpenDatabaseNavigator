import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS, type Engine } from '../src/shared/types';
import { createAdapter } from '../src/main/database/factory';
const configs: {
  engine: Engine;
  port?: number;
  database: string;
  schema: string;
  username?: string;
}[] = [
  { engine: 'sqlite', database: ':memory:', schema: 'main' },
  {
    engine: 'postgres',
    port: 15432,
    database: 'workspace',
    schema: 'public',
    username: 'workspace',
  },
  { engine: 'mysql', port: 13306, database: 'workspace', schema: 'workspace', username: 'root' },
  { engine: 'mysql', port: 13307, database: 'workspace', schema: 'workspace', username: 'root' },
  { engine: 'sqlserver', port: 11433, database: 'master', schema: 'dbo', username: 'sa' },
];
for (const config of configs)
  it.skipIf(config.engine !== 'sqlite' && process.env.DB_INTEGRATION !== '1')(
    `create objects: ${config.engine}:${config.port ?? 'local'}`,
    async () => {
      const secrets = new Map<string, string>();
      const app = new Application(
        {
          connections: new MemoryStore([]),
          workspace: new MemoryStore({ tabs: [] }),
          settings: new MemoryStore(DEFAULT_SETTINGS),
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
        createAdapter,
      );
      const connection = await app.connections.save({
        name: 'Create objects',
        engine: config.engine,
        port: config.port,
        database: config.database,
        username: config.username,
        host: '127.0.0.1',
        password: process.env.DB_TEST_PASSWORD,
        agentAccess: 'read',
      });
      const adapter = await app.connections.connect(connection.id);
      const ref = { connectionId: connection.id, database: config.database, schema: config.schema };
      const name = 'create_' + randomUUID().replaceAll('-', '').slice(0, 12);
      const query = (sql: string) =>
        adapter.query(sql, [], { limit: 100, readOnly: false, timeout: 30000 });
      const { SqlBuilder } = await import('../src/main/database/sql-builder');
      const b = new SqlBuilder(config.engine),
        qualified = (table: string) => b.table({ schema: config.schema, table });
      const call = async (command: string, args: object) => {
        const scope = command.endsWith('.list')
          ? { connectionId: connection.id, database: config.database }
          : ref;
        const result = await app.commands.dispatch(command, { ...scope, ...args }, HUMAN);
        expect(result.success, `${command}: ${result.error}`).toBe(true);
        return result.data as any;
      };
      try {
        const tableInput = {
          kind: 'table',
          name,
          columns: [
            { name: 'id', type: 'int', primaryKey: true, nullable: false },
            {
              name: 'label',
              type: 'varchar(40)',
              primaryKey: false,
              nullable: true,
              defaultSql: "'hello'",
            },
          ],
        };
        const tab = await call('app.open_create_object', { kind: 'table' });
        expect(tab.type).toBe('create');
        expect(tab.createKind).toBe('table');
        // Preview cannot create anything and a read-only agent cannot execute DDL.
        await call('object.create_preview', tableInput);
        expect((await adapter.tables(config.schema)).some((table) => table.name === name)).toBe(
          false,
        );
        expect(
          (
            await app.commands.dispatch(
              'object.create',
              { ...ref, ...tableInput },
              { kind: 'agent', id: 'reader', name: 'Reader' },
            )
          ).success,
        ).toBe(false);
        await call('object.create', tableInput);
        expect(
          (await app.commands.dispatch('object.create', { ...ref, ...tableInput }, HUMAN)).success,
        ).toBe(false);
        await call('object.create', {
          kind: 'view',
          name: name + '_view',
          selectSql: `SELECT id,label FROM ${qualified(name)}`,
        });
        await call('object.create', {
          kind: 'index',
          name: name + '_idx',
          table: name,
          indexColumns: [{ name: 'label', descending: true }],
          unique: false,
        });
        const body =
          config.engine === 'postgres'
            ? "NEW.label := 'triggered'; RETURN NEW;"
            : config.engine === 'mysql'
              ? "IF NEW.id > 0 THEN SET NEW.label = CASE WHEN NEW.id > 0 THEN 'triggered' ELSE 'other' END; END IF;"
              : config.engine === 'sqlserver'
                ? `UPDATE t SET label='triggered' FROM ${qualified(name)} t JOIN inserted i ON t.id=i.id;`
                : `UPDATE ${b.quote(name)} SET label='triggered' WHERE id=NEW.id;`;
        const trigger = {
          kind: 'trigger',
          name: name + '_trg',
          table: name,
          timing: ['postgres', 'mysql'].includes(config.engine) ? 'BEFORE' : 'AFTER',
          event: 'INSERT',
          body,
          createFunction: true,
        };
        await call('object.create', trigger);
        await query(`INSERT INTO ${qualified(name)} (id) VALUES (1)`);
        expect(
          (await query(`SELECT label FROM ${qualified(name + '_view')} WHERE id=1`)).rows[0].label,
        ).toBe('triggered');
        expect(
          (await call('index.list', {})).some((item: any) => item.name === name + '_idx'),
        ).toBe(true);
        expect(
          (await call('trigger.list', {})).some((item: any) => item.name === name + '_trg'),
        ).toBe(true);
        const bad = await app.commands.dispatch(
          'object.create_preview',
          {
            ...ref,
            kind: 'table',
            name: name + '_bad',
            columns: [
              {
                name: 'id',
                type: 'int); DROP TABLE ' + name + '; --',
                nullable: true,
                primaryKey: false,
              },
            ],
          },
          HUMAN,
        );
        expect(bad.success).toBe(false);
        expect((await adapter.tables(config.schema)).some((table) => table.name === name)).toBe(
          true,
        );
        if (config.engine === 'postgres') {
          // Function creation rolls back if the trigger name collides; never replace a function.
          const collision = await app.commands.dispatch(
            'object.create',
            { ...ref, ...trigger, functionName: name + '_rollback' },
            HUMAN,
          );
          expect(collision.success).toBe(false);
          expect(
            (await query(`SELECT proname FROM pg_proc WHERE proname='${name}_rollback'`)).rows,
          ).toHaveLength(0);
        }
        // Complete the lifecycle through the same permission-checked commands as the GUI.
        const tableRef = { ...ref, table: name };
        const structure = await call('structure.describe', { table: name });
        await call('structure.apply', {
          table: name,
          version: structure.version,
          change: {
            action: 'add',
            name: 'extra',
            type: 'int',
            nullable: true,
            primaryKey: false,
            defaultSql: '',
          },
        });
        expect((await adapter.describe(tableRef)).some((column) => column.name === 'extra')).toBe(
          true,
        );
        for (const kind of ['index', 'trigger'] as const) {
          const objectName = name + (kind === 'index' ? '_idx' : '_trg');
          const objectRef = { kind, objectName, table: name };
          const definition = await call('object.describe', objectRef);
          await call('object.apply', {
            ...objectRef,
            sql: definition.editableSql,
            version: definition.version,
          });
          const objectTab = await call('app.open_object', { type: kind, objectName, table: name });
          const preview = await call('object.drop_preview', objectRef);
          expect(preview.tabs.some((tab: any) => tab.id === objectTab.id)).toBe(true);
          const denied = await app.commands.dispatch(
            'object.drop',
            { ...ref, ...objectRef, version: preview.version },
            { kind: 'agent', id: 'reader', name: 'Reader' },
          );
          expect(denied.success).toBe(false);
          await call('object.drop', { ...objectRef, version: preview.version });
          expect(
            (await call(`${kind}.list`, {})).some((item: any) => item.name === objectName),
          ).toBe(false);
          expect(app.workspace.get().tabs.some((tab) => tab.id === objectTab.id)).toBe(false);
        }
        const viewName = name + '_view';
        const view = await call('structure.describe', { table: viewName });
        await call('structure.apply', {
          table: viewName,
          version: view.version,
          change: {
            action: 'view',
            sql: `CREATE VIEW ${qualified(viewName)} AS SELECT id,label FROM ${qualified(name)} WHERE id > 0`,
          },
        });
        if (config.engine === 'sqlite') {
          const preview = await call('object.drop_preview', { kind: 'table', objectName: name });
          const blocked = await app.commands.dispatch(
            'object.drop',
            { ...ref, kind: 'table', objectName: name, version: preview.version },
            HUMAN,
          );
          expect(blocked.success).toBe(false); // Remaining view would become invalid: DDL rolls back.
          expect((await query(`SELECT * FROM ${qualified(viewName)}`)).rows).toHaveLength(1);
        }
        for (const kind of ['view', 'table'] as const) {
          const objectName = kind === 'view' ? viewName : name;
          const objectRef = { kind, objectName };
          const objectTab = await call('app.open_table', { table: objectName });
          const preview = await call('object.drop_preview', objectRef);
          expect(
            (await adapter.tables(config.schema)).some((table) => table.name === objectName),
          ).toBe(true);
          await app.commands.dispatch(
            'workspace.update',
            { id: objectTab.id, patch: { dirty: true } },
            HUMAN,
          );
          const guarded = await app.commands.dispatch(
            'object.drop',
            { ...ref, ...objectRef, version: preview.version },
            HUMAN,
          );
          expect(guarded.success).toBe(false);
          expect(
            (await adapter.tables(config.schema)).some((table) => table.name === objectName),
          ).toBe(true);
          const stale = await app.commands.dispatch(
            'object.drop',
            { ...ref, ...objectRef, version: '0'.repeat(64), discard: true },
            HUMAN,
          );
          expect(stale.success).toBe(false);
          await call('object.drop', { ...objectRef, version: preview.version, discard: true });
          expect(
            (await adapter.tables(config.schema)).some((table) => table.name === objectName),
          ).toBe(false);
          expect(app.workspace.get().tabs.some((tab) => tab.id === objectTab.id)).toBe(false);
        }
      } finally {
        await query(`DROP VIEW IF EXISTS ${qualified(name + '_view')}`).catch(() => {});
        await query(`DROP TABLE IF EXISTS ${qualified(name)}`).catch(() => {});
        if (config.engine === 'postgres')
          await query(`DROP FUNCTION IF EXISTS ${qualified(name + '_trg_fn')}()`).catch(() => {});
        await app.connections.shutdown();
      }
    },
    30000,
  );
