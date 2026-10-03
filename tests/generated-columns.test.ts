import { expect, it, describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createAdapter } from '../src/main/database/factory';
import { connectionSchema } from '../src/shared/schemas';
import { createObjectSchema } from '../src/shared/create-object';
import { planCreateObject } from '../src/main/application/services/create-object-service';
import {
  describeStructure,
  applyStructure,
} from '../src/main/application/services/table-structure-service';
import {
  generationCapabilities,
  generationClause,
  planGeneratedChange,
} from '../src/main/database/generated-columns';
import type { GeneratedChange } from '../src/shared/generated-columns';
import type { SqlAdapter } from '../src/main/database/adapter';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS } from '../src/shared/types';

it('parses nested generation expressions and preserves following column attributes', () => {
  const clause =
    "`total` decimal(12,2) GENERATED ALWAYS AS ((qty * cost) + abs(1)) STORED COMMENT 'saved'";
  const span = generationClause(clause, 'mysql')!;
  expect(span.generation).toEqual({ expression: '(qty * cost) + abs(1)', storage: 'stored' });
  expect(clause.slice(span.end)).toBe(" COMMENT 'saved'");
  expect(generationClause('value INT DEFAULT 1', 'sqlite')).toBeUndefined();
});
it('gates PostgreSQL generation creation and expression editing by server version', async () => {
  const adapter = (version: string) =>
    ({ query: async () => ({ rows: [{ version }] }) }) as unknown as SqlAdapter;
  expect(await generationCapabilities(adapter('110000'), 'postgres')).toMatchObject({ modes: [] });
  expect(await generationCapabilities(adapter('160000'), 'postgres')).toMatchObject({
    modes: ['stored'],
    editExpression: false,
  });
  expect(await generationCapabilities(adapter('170000'), 'postgres')).toMatchObject({
    modes: ['stored'],
    editExpression: true,
  });
  expect(await generationCapabilities(adapter('180000'), 'postgres')).toMatchObject({
    modes: ['virtual', 'stored'],
  });
});
const configs = [
  { name: 'SQLite', engine: 'sqlite', database: ':memory:', schema: 'main' },
  {
    name: 'PostgreSQL',
    engine: 'postgres',
    port: 15432,
    username: 'workspace',
    database: 'workspace',
    schema: 'public',
  },
  {
    name: 'MySQL',
    engine: 'mysql',
    port: 13306,
    username: 'root',
    database: 'workspace',
    schema: 'workspace',
  },
  {
    name: 'MariaDB',
    engine: 'mysql',
    port: 13307,
    username: 'root',
    database: 'workspace',
    schema: 'workspace',
  },
  {
    name: 'SQL Server',
    engine: 'sqlserver',
    port: 11433,
    username: 'sa',
    database: 'master',
    schema: 'dbo',
  },
];
for (const config of configs)
  describe.skipIf(config.engine !== 'sqlite' && process.env.DB_INTEGRATION !== '1')(
    config.name,
    () => {
      it('creates tables with generated columns, adds and edits expressions, preserves data and rejects invalid changes', async () => {
        const { schema, ...input } = config;
        const connection = {
          ...connectionSchema.parse({ ...input, host: '127.0.0.1' }),
          id: randomUUID(),
        };
        const adapter = createAdapter(connection, process.env.DB_TEST_PASSWORD);
        const table = 'dw_gen_' + randomUUID().replaceAll('-', '').slice(0, 14),
          ref = { schema, table };
        const run = (sql: string) =>
          adapter.query(sql, [], { limit: 100, timeout: 10000, readOnly: false });
        const change = async (value: GeneratedChange) => {
          const before = await describeStructure(adapter, connection, ref);
          return applyStructure(adapter, connection, ref, value, before.version, 10000);
        };
        let created = false;
        try {
          const plan = await planCreateObject(
            adapter,
            connection,
            createObjectSchema.parse({
              connectionId: connection.id,
              schema,
              kind: 'table',
              name: table,
              columns: [
                { name: 'id', type: 'int', nullable: false, primaryKey: true },
                { name: 'qty', type: 'int', nullable: true, primaryKey: false },
                {
                  name: 'total',
                  type: 'int',
                  nullable: true,
                  primaryKey: false,
                  generation: { expression: 'qty * 2', storage: 'stored' },
                },
              ],
            }),
          );
          await adapter.executeDdl!(plan.statements, 10000);
          created = true;
          await run(`INSERT INTO ${table}(id,qty) VALUES(1,5)`);
          let detail = await describeStructure(adapter, connection, ref);
          expect(detail.columns.find((c) => c.name === 'total')?.generation?.storage).toBe(
            'stored',
          );
          expect(detail.columns.find((c) => c.name === 'total')?.defaultSql).toBe('');
          const dataColumns = await adapter.describe(ref);
          expect(dataColumns.find((c) => c.name === 'total')?.generated).toBe(true);
          expect(dataColumns.find((c) => c.name === 'qty')?.generated).not.toBe(true);
          expect(String((await run(`SELECT total FROM ${table}`)).rows[0].total)).toBe('10');
          if (config.engine === 'sqlserver') {
            detail = await applyStructure(
              adapter,
              connection,
              ref,
              {
                action: 'column-properties',
                column: 'total',
                properties: { comment: "計算欄位's 註解" },
              },
              detail.version,
              10000,
            );
          }
          detail = await change({
            action: 'generated-edit',
            column: 'total',
            generation: { expression: 'qty * 3', storage: 'stored' },
          });
          expect(String((await run(`SELECT total FROM ${table}`)).rows[0].total)).toBe('15');
          if (config.engine === 'sqlserver')
            expect(detail.columns.find((c) => c.name === 'total')?.properties?.comment).toBe(
              "計算欄位's 註解",
            );
          const extraMode = detail.generationCapabilities!.modes[0];
          detail = await change({
            action: 'generated-add',
            name: 'extra',
            type: 'int',
            generation: { expression: 'qty + 4', storage: extraMode },
          });
          expect(String((await run(`SELECT extra FROM ${table}`)).rows[0].extra)).toBe('9');
          if (detail.generationCapabilities?.changeStorage) {
            detail = await change({
              action: 'generated-edit',
              column: 'extra',
              generation: {
                expression: detail.columns.find((c) => c.name === 'extra')!.generation!.expression,
                storage: 'stored',
              },
            });
            expect(detail.columns.find((c) => c.name === 'extra')?.generation?.storage).toBe(
              'stored',
            );
          }
          const before = await describeStructure(adapter, connection, ref);
          await expect(
            change({
              action: 'generated-edit',
              column: 'total',
              generation: { expression: 'missing_column + 1', storage: 'stored' },
            }),
          ).rejects.toThrow();
          expect((await describeStructure(adapter, connection, ref)).version).toBe(before.version);
          expect(String((await run(`SELECT qty,total FROM ${table}`)).rows[0].qty)).toBe('5');
          await expect(
            planGeneratedChange(adapter, before, {
              action: 'generated-add',
              name: 'bad',
              type: 'int',
              generation: { expression: 'qty); DROP TABLE test; --', storage: 'stored' },
            }),
          ).rejects.toThrow();
          await run(`UPDATE ${table} SET qty=7 WHERE id=1`);
          expect(String((await run(`SELECT total FROM ${table}`)).rows[0].total)).toBe('21');
          const current = await describeStructure(adapter, connection, ref);
          const dropped = await applyStructure(
            adapter,
            connection,
            ref,
            { action: 'drop', column: 'extra' },
            current.version,
            10000,
          );
          expect(dropped.columns.some((c) => c.name === 'extra')).toBe(false);
        } finally {
          if (created) await run(`DROP TABLE ${table}`);
          await adapter.disconnect();
        }
      }, 60000);
    },
  );

it('preserves SQLite indexes, triggers, rowids and stored computed values across a rebuild', async () => {
  const connection = {
    ...connectionSchema.parse({ name: 'SQLite', engine: 'sqlite', database: ':memory:' }),
    id: randomUUID(),
  };
  const adapter = createAdapter(connection);
  const run = (sql: string) =>
    adapter.query(sql, [], { limit: 100, timeout: 10000, readOnly: false });
  try {
    await run(
      'CREATE TABLE test(id INTEGER PRIMARY KEY AUTOINCREMENT,qty INT,total INT AS(qty*2) STORED)',
    );
    await run('CREATE UNIQUE INDEX total_unique ON test(total)');
    await run('CREATE TABLE audit(v INT)');
    await run(
      'CREATE TRIGGER log_insert AFTER INSERT ON test BEGIN INSERT INTO audit VALUES(new.total); END',
    );
    await run('INSERT INTO test(id,qty) VALUES(50,3)');
    await run('DELETE FROM test');
    await run('INSERT INTO test(qty) VALUES(4)');
    const detail = await describeStructure(adapter, connection, { schema: 'main', table: 'test' });
    await applyStructure(
      adapter,
      connection,
      detail,
      {
        action: 'generated-edit',
        column: 'total',
        generation: { expression: 'qty*3', storage: 'virtual' },
      },
      detail.version,
      10000,
    );
    expect(String((await run('SELECT id FROM test')).rows[0].id)).toBe('51');
    expect((await run('SELECT * FROM audit')).rows).toHaveLength(2);
    await run('INSERT INTO test(qty) VALUES(5)');
    expect(String((await run('SELECT max(id) AS id FROM test')).rows[0].id)).toBe('52');
    await expect(run('INSERT INTO test(qty) VALUES(5)')).rejects.toThrow('UNIQUE');
    expect(String((await run('SELECT max(v) AS v FROM audit')).rows[0].v)).toBe('15');
  } finally {
    await adapter.disconnect();
  }
});

it('requires shared approval for generated changes and rejects direct writes to computed values', async () => {
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore({
        ...DEFAULT_SETTINGS,
        policy: { ...DEFAULT_SETTINGS.policy, ddl: 'ask', destructive: 'ask' },
      }),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    { get: () => undefined, set() {}, delete() {} },
    createAdapter,
  );
  try {
    const connection = await app.connections.save({
      name: 'generated',
      engine: 'sqlite',
      database: ':memory:',
      agentAccess: 'write',
    });
    const adapter = await app.connections.connect(connection.id);
    await adapter.query('CREATE TABLE sample(id INT PRIMARY KEY, qty INT)', [], {
      limit: 0,
      timeout: 5000,
      readOnly: false,
    });
    const ref = { connectionId: connection.id, schema: 'main', table: 'sample' };
    const actor = { kind: 'agent' as const, id: 'agent', name: 'Agent' };
    const before = await describeStructure(adapter, connection, ref);
    const added = await app.commands.dispatch(
      'structure.apply',
      {
        ...ref,
        version: before.version,
        change: {
          action: 'generated-add',
          name: 'total',
          type: 'int',
          generation: { expression: 'qty*2', storage: 'stored' },
        },
      },
      actor,
    );
    expect(added.approvalId).toBeTruthy();
    expect((await app.commands.resolveApproval(added.approvalId!, true, HUMAN)).success).toBe(true);
    const current = await describeStructure(adapter, connection, ref);
    const pending = await app.commands.dispatch(
      'structure.apply',
      {
        ...ref,
        version: current.version,
        change: {
          action: 'generated-edit',
          column: 'total',
          generation: { expression: 'qty*3', storage: 'stored' },
        },
      },
      actor,
    );
    expect(app.permissions.list().find((p) => p.id === pending.approvalId)?.risk).toBe(
      'destructive',
    );
    expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
      true,
    );
    const rejected = await app.commands.dispatch(
      'data.insert',
      { ...ref, values: { id: 1, qty: 5, total: 20 } },
      HUMAN,
    );
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('maintained by the database');
    expect(
      (await app.commands.dispatch('data.insert', { ...ref, values: { id: 1, qty: 5 } }, HUMAN))
        .success,
    ).toBe(true);
    const row = await adapter.query('SELECT total FROM sample', [], {
      limit: 5,
      timeout: 5000,
      readOnly: true,
    });
    expect(String(row.rows[0].total)).toBe('15');
  } finally {
    await app.connections.shutdown();
  }
});
