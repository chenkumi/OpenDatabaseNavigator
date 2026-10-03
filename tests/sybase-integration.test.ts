import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SybaseAdapter } from '../src/main/database/adapters/sybase/sybase-adapter';
import { connectionSchema } from '../src/shared/schemas';
import { createObjectSchema } from '../src/shared/create-object';
import { SqlBuilder } from '../src/main/database/sql-builder';
import { planCreateObject } from '../src/main/application/services/create-object-service';
import {
  describeStructure,
  applyStructure,
} from '../src/main/application/services/table-structure-service';
import {
  readObjectDefinition,
  applyObjectChange,
} from '../src/main/application/services/database-object-service';
import { planDropObject } from '../src/main/application/services/drop-object-service';

it.skipIf(process.env.ASE_INTEGRATION !== '1')(
  'real ASE: metadata, parameter CRUD, paging and four object lifecycles',
  async () => {
    const connection = {
      ...connectionSchema.parse({
        name: 'ASE integration',
        engine: 'sybase',
        host: process.env.ASE_HOST,
        port: Number(process.env.ASE_PORT || 5000),
        database: process.env.ASE_DATABASE,
        username: process.env.ASE_USERNAME,
        aseDriver: process.env.ASE_DRIVER,
        tls: process.env.ASE_TLS === '1',
        aseTrustedFile: process.env.ASE_TRUSTED_FILE,
        readTimeout: Number(process.env.ASE_READ_TIMEOUT || 0),
        writeTimeout: Number(process.env.ASE_WRITE_TIMEOUT || 0),
        aseJavaPath: process.env.ASE_JAVA_PATH,
        aseDdlgenPath: process.env.ASE_DDLGEN_PATH,
        aseJconnectPath: process.env.ASE_JCONNECT_PATH,
        charset: process.env.ASE_CHARSET || undefined,
      }),
      id: 'ase-integration',
    };
    const adapter = new SybaseAdapter(connection, process.env.ASE_PASSWORD);
    const textSample: Record<string, string> = {
      utf8: '資料',
      iso_1: 'café',
      cp1252: '€ café',
      big5: '資料',
      cp936: '资料',
      gb18030: '资料',
      sjis: '日本語',
      eucjis: '日本語',
    };
    const sample = textSample[connection.charset || 'utf8'];
    const schema = process.env.ASE_SCHEMA || 'dbo';
    const name = 'dw_ase_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const view = name + '_v',
      index = name + '_i',
      trigger = name + '_tr';
    const b = new SqlBuilder('sybase');
    const ref = { connectionId: connection.id, schema, table: name };
    const table = b.table(ref);
    const run = (sql: string, params: unknown[] = [], readOnly = false, offset = 0) =>
      adapter.query(sql, params, { limit: 2, timeout: 30000, readOnly, offset });
    const created: { kind: 'table' | 'view' | 'index' | 'trigger'; name: string }[] = [];
    const create = async (kind: 'table' | 'view' | 'index' | 'trigger', objectName: string) => {
      const input = createObjectSchema.parse({
        ...ref,
        kind,
        name: objectName,
        columns: [
          { name: 'id', type: 'int', nullable: false, primaryKey: true },
          {
            name: 'note',
            type: 'varchar(80)',
            nullable: true,
            primaryKey: false,
            defaultSql: "'initial'",
          },
        ],
        selectSql: `SELECT id,note FROM ${table}`,
        indexColumns: [{ name: 'note', descending: false }],
        body: 'SET NOCOUNT ON;',
      });
      const plan = await planCreateObject(adapter, connection, input);
      await adapter.executeDdl(plan.statements, 30000);
      created.push({ kind, name: objectName });
    };
    try {
      await adapter.connect();
      if (connection.charset)
        expect((await run('SELECT @@client_csname AS charset', [], true)).rows[0].charset).toBe(
          connection.charset,
        );
      expect(await adapter.databases()).toContain(connection.database);
      expect(await adapter.schemas()).toContain(schema);
      // GO batches must retain server status variables. Driver-side probes or
      // SET ROWCOUNT between execute calls would invalidate both assertions.
      await adapter.withScriptSession(async (execute) => {
        const signal = new AbortController().signal;
        await execute('CREATE TABLE #dw_status (id int NOT NULL)', signal, 30000);
        await execute('INSERT INTO #dw_status SELECT 1 UNION ALL SELECT 2', signal, 30000);
        await execute(
          "IF @@rowcount <> 2 RAISERROR 20000 'Batch rowcount was changed'",
          signal,
          30000,
        );
        await expect(
          execute("SELECT CONVERT(int, 'not-a-number')", signal, 30000),
        ).rejects.toThrow();
        await execute("IF @@error = 0 RAISERROR 20001 'Batch error was cleared'", signal, 30000);
      });
      await create('table', name);
      expect((await adapter.describe(ref)).find((column) => column.name === 'id')?.primaryKey).toBe(
        true,
      );
      for (let id = 1; id <= 4; id++) {
        const insert = new SqlBuilder('sybase').insert(ref, {
          id,
          note: `${sample} O'Brien ${id}`,
        });
        expect((await run(insert.sql, insert.params)).affectedRows).toBe(1);
      }
      const page = await run(`SELECT id,note FROM ${table} ORDER BY id`, [], true, 2);
      expect(page.rows.map((row) => row.id)).toEqual([3, 4]);
      expect(page.rows[0].note).toBe(`${sample} O'Brien 3`);
      const update = new SqlBuilder('sybase').update(ref, { note: 'changed' }, [
        { column: 'id', operator: '=', value: 1 },
      ]);
      expect((await run(update.sql, update.params)).affectedRows).toBe(1);
      const remove = new SqlBuilder('sybase').delete(ref, [
        { column: 'id', operator: '=', value: 4 },
      ]);
      expect((await run(remove.sql, remove.params)).affectedRows).toBe(1);
      const exact = await run(
        "SELECT CONVERT(NUMERIC(28,6), '12345678901234567890.123456') AS value",
        [],
        true,
      );
      expect(exact.rows[0].value).toBe('12345678901234567890.123456');
      const detail = await describeStructure(adapter, connection, ref);
      await applyStructure(
        adapter,
        connection,
        ref,
        { action: 'type', column: 'note', type: 'varchar(100)' },
        detail.version,
        30000,
      );
      await create('view', view);
      const viewRef = { ...ref, table: view };
      const viewDetail = await describeStructure(adapter, connection, viewRef);
      await applyStructure(
        adapter,
        connection,
        viewRef,
        { action: 'view', sql: `CREATE VIEW ${b.table(viewRef)} AS SELECT id FROM ${table}` },
        viewDetail.version,
        30000,
      );
      await create('index', index);
      await create('trigger', trigger);
      for (const kind of ['index', 'trigger'] as const) {
        const objectRef = { ...ref, kind, objectName: kind === 'index' ? index : trigger };
        const definition = await readObjectDefinition(adapter, connection, objectRef);
        expect(definition.readOnlyReason).toBeUndefined();
        await applyObjectChange(
          adapter,
          connection,
          objectRef,
          definition.editableSql,
          definition.version,
          30000,
        );
      }
      if (connection.aseDdlgenPath && connection.aseJconnectPath) {
        let exported = '';
        await adapter.exportSql({
          includeData: process.env.ASE_EXPORT_DATA === '1',
          timeout: 30000,
          signal: new AbortController().signal,
          write: async (chunk) => {
            exported += chunk;
          },
          progress() {},
        });
        for (const object of [name, view, index, trigger]) expect(exported).toContain(object);
        if (process.env.ASE_EXPORT_DATA === '1') expect(exported).toContain('INSERT INTO');
      }
      // Exercise validated DROP plans; cleanup below also handles partially failed tests.
      for (const item of [...created].reverse()) {
        const plan = await planDropObject(adapter, connection, {
          ...ref,
          kind: item.kind,
          objectName: item.name,
        });
        await adapter.executeDdl(plan.statements, 30000);
        created.splice(created.indexOf(item), 1);
      }
      if (connection.readTimeout > 0 && connection.readTimeout <= 5000) {
        await expect(run("WAITFOR DELAY '00:00:10'")).rejects.toThrow('Network read timed out');
        expect((await run('SELECT 1 AS value')).rows[0].value).toBe(1);
      }
    } finally {
      const cleanup: unknown[] = [];
      for (const item of created.reverse()) {
        const target =
          item.kind === 'index'
            ? `${table}.${b.quote(item.name)}`
            : b.table({ schema, table: item.name });
        try {
          await adapter.executeDdl([`DROP ${item.kind.toUpperCase()} ${target}`], 30000);
        } catch (error) {
          cleanup.push(error);
        }
      }
      await adapter.disconnect();
      if (cleanup.length)
        throw new AggregateError(
          cleanup,
          `ASE test cleanup failed for ${name}. Remove only this test's objects manually.`,
        );
    }
  },
  180000,
);
