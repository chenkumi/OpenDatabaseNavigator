import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import {
  SybaseAdapter,
  aseConnectionString,
  type AseDriver,
  type AseSession,
} from '../src/main/database/adapters/sybase/sybase-adapter';
import {
  aseColumns,
  aseDefinition,
  aseIndex,
} from '../src/main/database/adapters/sybase/sybase-catalog';
import { connectionSchema } from '../src/shared/schemas';
import { createObjectSchema } from '../src/shared/create-object';
import { SqlBuilder } from '../src/main/database/sql-builder';
import type { SqlAdapter } from '../src/main/database/adapter';
import { analyzeSql } from '../src/main/security/sql-policy';
import { assertSingleStatement } from '../src/main/security/single-statement';
import {
  describeStructure,
  planStructure,
} from '../src/main/application/services/table-structure-service';
import { planCreateObject } from '../src/main/application/services/create-object-service';
import {
  readObjectDefinition,
  planObjectChange,
} from '../src/main/application/services/database-object-service';
import { planDropObject } from '../src/main/application/services/drop-object-service';
import { typeOptions, TYPE_SUGGESTIONS } from '../src/renderer/src/column-types';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { planRenameObject } from '../src/main/application/services/rename-object-service';

const connection = {
  ...connectionSchema.parse({
    name: 'ASE',
    engine: 'sybase',
    host: 'localhost',
    database: 'test',
    username: 'tester',
  }),
  id: 'ase',
};
const options = { limit: 2, timeout: 1000, readOnly: true };
it('uses legacy-compatible SAP values and server-default encoding', () => {
  const value = aseConnectionString(connection);
  expect(value).toContain('Server=localhost;');
  expect(value).toContain('Database=test;UID=tester;');
  expect(value).toContain('CharSet=ServerDefault;Language=us_english;');
  expect(value).not.toContain('ClientCharset=');
});
it('ASE rejects scripts before opening any native session', async () => {
  const fake = native(() => ({}));
  let called = false;
  await expect(
    fake.adapter.withScriptSession(async () => {
      called = true;
    }),
  ).rejects.toThrow('read-only');
  expect(called).toBe(false);
  expect(fake.sessions).toHaveLength(0);
});
type Reply = {
  rows?: unknown[][];
  types?: string[];
  names?: string[];
  error?: string;
  hang?: boolean;
  affected?: number;
};
function native(reply: (sql: string) => Reply, version = 'Adaptive Server Enterprise/16.0 SP04') {
  const sessions: { closed: boolean; numeric: boolean; statements: string[] }[] = [];
  let cancelled = 0;
  const driver: AseDriver = {
    open(_options, callback) {
      const record = { closed: false, numeric: false, statements: [] as string[] };
      sessions.push(record);
      const session: AseSession = {
        setUseNumericString(value) {
          record.numeric = value;
        },
        close(cb) {
          record.closed = true;
          cb();
        },
        queryRaw({ query_str: sql }) {
          record.statements.push(sql);
          const emitter = new EventEmitter();
          let stopped = false,
            freed = false;
          const free = () => {
            if (!freed) {
              freed = true;
              emitter.emit('free');
            }
          };
          const request = Object.assign(emitter, {
            pauseQuery() {
              if (freed) throw new Error('Native statement already freed.');
              stopped = true;
            },
            cancelQuery() {
              cancelled++;
              queueMicrotask(free);
            },
          });
          queueMicrotask(() => {
            const data = sql.includes('@@version')
              ? { names: ['version'], rows: [[version]] }
              : reply(sql);
            if (data.hang) return;
            if (data.rows) {
              emitter.emit(
                'meta',
                (data.names || ['value']).map((name, index) => ({
                  name,
                  sqlType: data.types?.[index] || 'varchar',
                })),
              );
              for (const row of data.rows) {
                if (stopped) break;
                emitter.emit('row');
                row.forEach((value, index) => emitter.emit('column', index, value));
              }
            }
            if (data.affected) emitter.emit('rowcount', data.affected);
            if (data.error) emitter.emit('error', new Error(data.error));
            // A paused stream is not naturally exhausted; its deferred cancel
            // must release it. Keep the cancellation-count assertion meaningful.
            if (!stopped) free();
          });
          return request;
        },
      };
      callback(null, session);
    },
  };
  return {
    adapter: new SybaseAdapter(connection, 'hidden-secret', async () => driver),
    sessions,
    cancelled: () => cancelled,
  };
}

it('ASE connection values are escaped, TLS requires a trust file, and native errors hide credentials', async () => {
  const text = aseConnectionString({ ...connection, host: 'db};UID=evil' }, 'a};PWD=evil');
  expect(text).toContain('Server={db}};UID=evil};');
  expect(text).toContain('Port=5000');
  expect(text).toContain('PWD={a}};PWD=evil};');
  expect(() => connectionSchema.parse({ ...connection, tls: true })).toThrow();
  expect(
    aseConnectionString({ ...connection, tls: true, aseTrustedFile: 'C:\\certs\\root.pem' }),
  ).toContain('Encryption=ssl;TrustedFile=');
  const fake = native(() => ({ error: 'login failed hidden-secret PWD={hidden-secret}' }));
  await expect(fake.adapter.query('SELECT 1', [], options)).rejects.toThrow('[REDACTED]');
  await fake.adapter.disconnect();
  expect(fake.sessions.every((session) => session.closed)).toBe(true);
});

it('ASE streams bounded pages and opens a fresh session for each operation', async () => {
  const fake = native(() => ({ rows: [[0], [1], [2], [3], [4], [5]], types: ['int'] }));
  const result = await fake.adapter.query('SELECT value FROM sample', [], {
    ...options,
    offset: 2,
  });
  expect(result.rows).toEqual([{ value: 2 }, { value: 3 }]);
  expect(result.hasMore).toBe(true);
  expect(fake.cancelled()).toBe(1);
  await fake.adapter.query('SELECT value FROM sample', [], options);
  expect(fake.sessions).toHaveLength(3);
  expect(fake.sessions.map((session) => session.closed)).toEqual([false, true, true]);
  expect(fake.sessions.every((session) => session.numeric)).toBe(true);
  await fake.adapter.disconnect();
  expect(fake.sessions.every((session) => session.closed)).toBe(true);
});

it('ASE heartbeats use the existing anchor and never reconnect after disconnect', async () => {
  const fake = native(() => ({ rows: [[1]], types: ['int'] }));
  await fake.adapter.connect();
  await fake.adapter.heartbeat(1000);
  expect(fake.sessions).toHaveLength(1);
  expect(fake.sessions[0].statements).toContain('SELECT 1');
  await fake.adapter.disconnect();
  await expect(fake.adapter.heartbeat(1000)).rejects.toThrow('closed');
  expect(fake.sessions).toHaveLength(1);
});

it('ASE cancellation, timeout and disconnect release active native sessions', async () => {
  const fake = native(() => ({ hang: true }));
  await fake.adapter.connect();
  await expect(fake.adapter.query('SELECT wait', [], { ...options, timeout: 15 })).rejects.toThrow(
    'timed out',
  );
  const controller = new AbortController();
  const running = fake.adapter.query('SELECT wait', [], { ...options, signal: controller.signal });
  const rejected = expect(running).rejects.toThrow('cancelled');
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await rejected;
  const other = fake.adapter.query('SELECT wait', [], options);
  const closed = expect(other).rejects.toThrow('cancelled');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fake.adapter.disconnect();
  await closed;
  expect(fake.sessions.every((session) => session.closed)).toBe(true);
});

it('ASE rejects lossy values and duplicate names, preserves exact NUMERIC and reports write errors after truncation', async () => {
  for (const types of [['decimal'], ['money'], ['bigint']]) {
    const fake = native(() => ({ rows: [[123]], types }));
    await expect(fake.adapter.query('SELECT value', [], options)).rejects.toThrow(
      /lossless|inexact/,
    );
    await fake.adapter.disconnect();
  }
  const exact = native(() => ({ rows: [['12345678901234567890.123456']], types: ['numeric'] }));
  expect((await exact.adapter.query('SELECT value', [], options)).rows[0].value).toBe(
    '12345678901234567890.123456',
  );
  await exact.adapter.disconnect();
  const duplicate = native(() => ({ rows: [[1, 2]], names: ['same', 'same'] }));
  await expect(duplicate.adapter.query('SELECT value', [], options)).rejects.toThrow(
    'distinct aliases',
  );
  await duplicate.adapter.disconnect();
  const failed = native(() => ({ rows: [[1], [2], [3], [4]], error: 'write failed' }));
  await expect(
    failed.adapter.query('UPDATE sample SET id=1', [], { ...options, readOnly: false }),
  ).rejects.toThrow('read-only');
  expect(failed.sessions).toHaveLength(0);
  await failed.adapter.disconnect();
});

it('ASE rejects DDL before opening a session', async () => {
  const fake = native(() => ({}));
  await expect(
    fake.adapter.executeDdl(['CREATE TABLE t(id int)', 'DROP TABLE t'], 1000),
  ).rejects.toThrow('read-only');
  expect(fake.sessions).toHaveLength(0);
});

function catalog() {
  let special = false,
    missing = false,
    defaultText = "DEFAULT 'old'";
  const adapter = {
    connect: async () => {},
    schemas: async () => ['dbo'],
    tables: async () => [
      { name: 'sample', schema: 'dbo', kind: 'table' },
      { name: 'sample_view', schema: 'dbo', kind: 'view' },
    ],
    describe: async () => [{ name: 'id' }, { name: 'note' }],
    query: async (sql: string, params: unknown[]) => {
      let rows: Record<string, unknown>[];
      if (sql.includes('FROM dbo.sysreferences') || sql.includes('FROM dbo.sysconstraints'))
        rows = [];
      else if (sql.includes('c.name,t.name'))
        rows = [
          { name: 'id', type: 'int', status: 0, cdefault: 0 },
          { name: 'note', type: 'varchar', length: 40, status: 8, cdefault: 77 },
        ];
      else if (sql.includes('AS position') && sql.includes('2048'))
        rows = [
          { name: 'pk_sample', column_name: 'id' },
          { name: 'pk_sample', column_name: null },
        ];
      else if (sql.includes('SELECT c.id,c.text')) rows = [{ id: 77, text: defaultText }];
      else if (sql.includes('SELECT c.text'))
        rows = missing
          ? [{ text: null }]
          : [
              {
                text: String(params[1]).endsWith('view')
                  ? 'CREATE VIEW [dbo].[sample_view] AS '
                  : 'CREATE TRIGGER [dbo].[tr_sample] ON [dbo].[sample] FOR INSERT AS ',
              },
              {
                text: String(params[1]).endsWith('view')
                  ? 'SELECT id FROM dbo.sample'
                  : 'BEGIN SELECT 1 END',
              },
            ];
      else if (sql.includes('i.indid,i.status'))
        rows = [
          {
            indid: 2,
            status: 128,
            status2: special ? 2 : 0,
            segment: 1,
            column_name: 'note',
            direction: 'DESC',
          },
        ];
      else
        rows = [
          {
            name: sql.includes("tr.type='TR'") ? 'tr_sample' : 'ix_sample',
            schema_name: 'dbo',
            table_name: 'sample',
          },
        ];
      return {
        rows,
        columns: [],
        success: true,
        hasMore: false,
        affectedRows: 0,
        rowCount: rows.length,
        duration: 0,
      };
    },
  } as unknown as SqlAdapter;
  return {
    adapter,
    special: () => (special = true),
    missing: () => (missing = true),
    changeDefault: () => (defaultText = "DEFAULT 'new'"),
  };
}
const ref = {
  connectionId: 'ase',
  schema: 'dbo',
  table: 'sample',
  objectName: 'ix_sample',
  kind: 'index' as const,
};
it('ASE rejects a different server product and explicitly unsupported operations', async () => {
  const wrong = native(() => ({}), 'Microsoft SQL Server 2022');
  await expect(wrong.adapter.connect()).rejects.toThrow('supports ASE');
  expect(wrong.sessions.every((session) => session.closed)).toBe(true);
  const fake = native(() => ({}));
  await expect(fake.adapter.query('EXPLAIN SELECT 1', [], options)).rejects.toThrow(
    'read-only SELECT',
  );
  expect(fake.sessions).toHaveLength(0);
  expect(() => new SqlBuilder('sybase').insert(ref, {})).toThrow('explicit column');
});

it('ASE flushes the final row after native release without cancellation and preserves special column names', async () => {
  const fake = native(() => ({ rows: [['a'], ['b'], ['c']], names: ['__proto__'] }));
  const result = await fake.adapter.query('SELECT value', [], options);
  expect(result.rows.map((row) => row['__proto__'])).toEqual(['a', 'b']);
  expect(result.hasMore).toBe(true);
  expect(fake.cancelled()).toBe(0);
  await fake.adapter.disconnect();
});

it('ASE uses shared permissions, cursor paging, database scopes, persistence and disconnect behavior', async () => {
  const scopes: string[] = [],
    fixtures: ReturnType<typeof native>[] = [];
  const saved = new MemoryStore<any[]>([]),
    secrets = new Map<string, string>();
  const app = new Application(
    {
      connections: saved,
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
    (config) => {
      scopes.push(config.database);
      const fake = native(() => ({ rows: [[1], [2], [3]], types: ['int'] }));
      fixtures.push(fake);
      return fake.adapter;
    },
  );
  try {
    const savedConnection = await app.connections.save({
      ...connection,
      id: undefined,
      agentAccess: 'read',
      password: 'only-in-vault',
    });
    expect(JSON.stringify(saved.read())).not.toContain('only-in-vault');
    expect(app.connections.status(savedConnection.id).connected).toBe(false);
    const args = {
      connectionId: savedConnection.id,
      database: 'another_db',
      sql: 'SELECT value FROM dbo.sample',
      limit: 2,
      showInApp: true,
    };
    const first = await app.commands.dispatch('query.execute', args, HUMAN);
    expect(first.success).toBe(true);
    expect((first.data as any).rows).toHaveLength(2);
    expect((first.data as any).nextCursor).toBeTruthy();
    expect(scopes).toEqual(['another_db']);
    const next = await app.commands.dispatch(
      'query.next',
      { connectionId: savedConnection.id, cursor: (first.data as any).nextCursor },
      HUMAN,
    );
    expect(next.success).toBe(true);
    expect((next.data as any).rows).toEqual([{ value: 3 }]);
    const agent = { kind: 'agent' as const, id: 'ase-agent', name: 'ASE agent' };
    const denied = await app.commands.dispatch(
      'query.execute',
      { ...args, sql: 'DROP TABLE dbo.sample' },
      agent,
    );
    expect(denied.success).toBe(false);
    expect(
      fixtures[0].sessions.some((s) => s.statements.some((sql) => sql.includes('DROP TABLE'))),
    ).toBe(false);
    await app.commands.dispatch(
      'connection.disconnect',
      { connectionId: savedConnection.id },
      HUMAN,
    );
    expect(app.workspace.get().tabs).toHaveLength(0);
    expect(app.connections.status(savedConnection.id).connected).toBe(false);
    expect(fixtures[0].sessions.every((session) => session.closed)).toBe(true);
  } finally {
    await app.connections.shutdown();
  }
});
it('ASE catalog assembles definitions, reads PK/default/type and versions metadata changes', async () => {
  const fake = catalog();
  expect((await aseColumns(fake.adapter, ref)).columns).toMatchObject([
    { name: 'id', primaryKey: true, nullable: false },
    { name: 'note', type: 'varchar(40)', defaultSql: "'old'", nullable: true },
  ]);
  expect(await aseDefinition(fake.adapter, { schema: 'dbo', table: 'sample_view' })).toContain(
    'AS SELECT id',
  );
  const before = await describeStructure(fake.adapter, connection, ref);
  fake.changeDefault();
  expect((await describeStructure(fake.adapter, connection, ref)).version).not.toBe(before.version);
  expect((await aseIndex(fake.adapter, ref)).sql).toContain('[note] DESC');
  fake.special();
  expect((await aseIndex(fake.adapter, ref)).readOnlyReason).toBeTruthy();
  fake.missing();
  await expect(aseDefinition(fake.adapter, ref)).rejects.toThrow('complete');
});

it('ASE creates all four object kinds and rejects unsupported trigger timing and injected batches', async () => {
  const { adapter } = catalog();
  const input = (kind: 'table' | 'view' | 'trigger' | 'index', patch = {}) =>
    createObjectSchema.parse({
      connectionId: 'ase',
      schema: 'dbo',
      name: 'new_object',
      table: 'sample',
      kind,
      columns: [{ name: 'id', type: 'INT', nullable: false, primaryKey: true, defaultSql: '1' }],
      indexColumns: [{ name: 'note', descending: true }],
      selectSql: 'SELECT id FROM dbo.sample',
      body: 'SET NOCOUNT ON;',
      ...patch,
    });
  expect((await planCreateObject(adapter, connection, input('table'))).statements[0]).toContain(
    '[id] INT DEFAULT 1 NOT NULL',
  );
  expect((await planCreateObject(adapter, connection, input('view'))).statements[0]).toMatch(
    /^CREATE VIEW/,
  );
  expect((await planCreateObject(adapter, connection, input('index'))).statements[0]).toContain(
    'ON [dbo].[sample] ([note] DESC)',
  );
  expect((await planCreateObject(adapter, connection, input('trigger'))).statements[0]).toContain(
    'ON [dbo].[sample] FOR INSERT AS',
  );
  await expect(
    planCreateObject(adapter, connection, input('trigger', { timing: 'BEFORE' })),
  ).rejects.toThrow('timing');
  await expect(
    planCreateObject(
      adapter,
      connection,
      input('view', { selectSql: 'SELECT 1 DROP TABLE sample' }),
    ),
  ).rejects.toThrow();
});

it('ASE structure and object definitions are read-only and cannot produce edit plans', async () => {
  const { adapter } = catalog();
  const detail = await describeStructure(adapter, connection, ref);
  expect(detail.readOnlyReason).toContain('read-only');
  expect(() =>
    planStructure(detail, { action: 'type', column: 'note', type: 'varchar(80)' }),
  ).toThrow('read-only');
  const index = await readObjectDefinition(adapter, connection, ref);
  expect(index.readOnlyReason).toContain('read-only');
  expect(() => planObjectChange(index, ref, index.editableSql)).toThrow('read-only');
  await expect(planDropObject(adapter, connection, ref)).rejects.toThrow('read-only');
  const triggerRef = { ...ref, kind: 'trigger' as const, objectName: 'tr_sample' };
  const trigger = await readObjectDefinition(adapter, connection, triggerRef);
  expect(trigger.readOnlyReason).toContain('read-only');
});

it('ASE SQL uses quoted identifiers, positional parameters and conservative classification', () => {
  const query = new SqlBuilder('sybase').select(
    { ...ref, offset: 5, filters: [{ column: 'n]ame', operator: '=', value: "'; DROP TABLE t" }] },
    10,
  );
  expect(query.sql).toContain('[n]]ame] = ?');
  expect(query.sql).not.toMatch(/LIMIT|OFFSET/);
  expect(query.params).toEqual(["'; DROP TABLE t"]);
  expect(analyzeSql('SELECT id FROM [dbo].[sample]', 'sybase').risk).toBe('read');
  expect(analyzeSql('EXEC sp_rename x,y', 'sybase').risk).not.toBe('read');
  expect(analyzeSql('SELECT * INTO other FROM sample', 'sybase').risk).not.toBe('read');
  expect(() => assertSingleStatement('SELECT [a;b] FROM [dbo].[sample]', 'sybase')).not.toThrow();
  expect(() => assertSingleStatement('SELECT 1; DROP TABLE sample', 'sybase')).toThrow();
  expect(TYPE_SUGGESTIONS.sybase).toContain('UNITEXT');
  expect(typeOptions('sybase', 'UNIVARCHAR').length).toBe(true);
  expect(typeOptions('sybase', 'BIT').length).toBe(false);
  expect(typeOptions('sybase', 'NUMERIC').scale).toBe(true);
});

it('ASE rejects rename plans for all four object kinds', async () => {
  const { adapter } = catalog();
  for (const [kind, objectName] of [
    ['table', 'sample'],
    ['view', 'sample_view'],
    ['index', 'ix_sample'],
    ['trigger', 'tr_sample'],
  ] as const) {
    await expect(
      planRenameObject(adapter, connection, { ...ref, kind, objectName, newName: 'renamed' }),
    ).rejects.toThrow('read-only');
  }
});
