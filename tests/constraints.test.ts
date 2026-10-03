import { expect, it, describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createAdapter } from '../src/main/database/factory';
import { connectionSchema } from '../src/shared/schemas';
import {
  parseTableConstraints,
  readTableConstraints,
} from '../src/main/database/constraint-catalog';
import {
  describeStructure,
  applyStructure,
  planStructure,
} from '../src/main/application/services/table-structure-service';
import type { ConstraintDefinition } from '../src/shared/constraints';
import type { StructureChange, TableStructure } from '../src/shared/types';
import type { SqlAdapter } from '../src/main/database/adapter';
import { constraintSql } from '../src/main/database/constraint-plan';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS } from '../src/shared/types';

it('parses unnamed and inline constraints with nested expressions and quoted identifiers', () => {
  const items = parseTableConstraints(
    `CREATE TABLE child (
    "x,y" INTEGER CONSTRAINT "inline ck" CHECK (("x,y" > 0) AND ('CHECK(x)' <> '')) NOT NULL,
    y INTEGER REFERENCES parent(id) ON DELETE SET NULL,
    z TEXT CHECK(length(z) > 1),
    CONSTRAINT pair FOREIGN KEY ("x,y", y) REFERENCES parent(a,b) ON UPDATE CASCADE ON DELETE RESTRICT,
    CHECK (z IN ('a','b'))
  )`,
    'sqlite',
    'main',
  );
  expect(items).toHaveLength(5);
  expect(items[0].definition).toMatchObject({
    kind: 'check',
    name: 'inline ck',
    expression: `("x,y" > 0) AND ('CHECK(x)' <> '')`,
  });
  expect(items[1].definition).toMatchObject({
    kind: 'foreign-key',
    columns: ['y'],
    referencedColumns: ['id'],
    onDelete: 'SET NULL',
  });
  expect(items[3].definition).toMatchObject({
    kind: 'foreign-key',
    columns: ['x,y', 'y'],
    referencedColumns: ['a', 'b'],
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  });
  expect(new Set(items.map((item) => item.id)).size).toBe(5);
});

it('reads ASE composite constraints and limits generated SQL to supported actions', async () => {
  const detail: TableStructure = {
    engine: 'sybase',
    schema: 'dbo',
    table: 'child',
    kind: 'table',
    definition: '',
    version: '',
    columns: ['a', 'b'].map((name) => ({
      name,
      type: 'int',
      nullable: true,
      primaryKey: false,
      defaultSql: '',
      defaultValue: null,
    })),
  };
  const adapter = {
    query: async (sql: string) => ({
      success: true,
      hasMore: false,
      rows: sql.includes('sysreferences')
        ? [
            {
              name: 'pair',
              keycnt: 2,
              ref_schema: 'dbo',
              ref_table: 'parent',
              local1: 'a',
              local2: 'b',
              remote1: 'id',
              remote2: 'tenant',
            },
          ]
        : [
            { name: 'positive', text: 'CHECK (a >' },
            { name: 'positive', text: ' 0)' },
          ],
    }),
  } as unknown as SqlAdapter;
  Object.assign(detail, await readTableConstraints(adapter, detail));
  const fk = detail.constraints![0].definition;
  expect(fk).toMatchObject({
    kind: 'foreign-key',
    columns: ['a', 'b'],
    referencedColumns: ['id', 'tenant'],
  });
  expect(constraintSql(detail, fk)).toBe(
    'CONSTRAINT [pair] FOREIGN KEY ([a], [b]) REFERENCES [dbo].[parent] ([id], [tenant])',
  );
  expect(detail.constraints![1].definition).toMatchObject({ expression: '(a > 0)' });
  if (fk.kind === 'foreign-key')
    expect(() => constraintSql(detail, { ...fk, onDelete: 'CASCADE' })).toThrow(
      'referential action',
    );
});

it('edits unnamed inline SQLite constraints without losing surrounding column attributes or data', async () => {
  const connection = {
    ...connectionSchema.parse({ name: 'inline', engine: 'sqlite', database: ':memory:' }),
    id: 'inline',
  };
  const adapter = createAdapter(connection);
  const run = (sql: string) =>
    adapter.query(sql, [], { readOnly: false, limit: 100, timeout: 5000 });
  const ref = { schema: 'main', table: 'child' };
  try {
    await run('CREATE TABLE parent(id INTEGER PRIMARY KEY)');
    await run(
      'CREATE TABLE child(id INTEGER PRIMARY KEY AUTOINCREMENT, score INT CHECK (score > 0) NOT NULL DEFAULT 3, parent_id INT REFERENCES parent(id) ON DELETE CASCADE)',
    );
    await run('INSERT INTO parent VALUES(1)');
    await run('INSERT INTO child VALUES(1,3,1)');
    let detail = await describeStructure(adapter, connection, ref);
    const check = detail.constraints!.find((item) => item.definition.kind === 'check')!;
    detail = await applyStructure(
      adapter,
      connection,
      ref,
      {
        action: 'constraint-upsert',
        id: check.id,
        constraint: { kind: 'check', name: 'named', expression: 'score >= 3', notEnforced: false },
      },
      detail.version,
      5000,
    );
    expect(detail.columns.find((column) => column.name === 'score')).toMatchObject({
      nullable: false,
      defaultSql: '3',
    });
    const fk = detail.constraints!.find((item) => item.definition.kind === 'foreign-key')!;
    await applyStructure(
      adapter,
      connection,
      ref,
      { action: 'constraint-drop', id: fk.id },
      detail.version,
      5000,
    );
    await run('DELETE FROM parent');
    expect((await run('SELECT * FROM child')).rows).toHaveLength(1);
    await run('INSERT INTO child (parent_id) VALUES(7)');
    expect((await run('SELECT id,score FROM child WHERE parent_id=7')).rows).toEqual([
      { id: '2', score: '3' },
    ]);
    await expect(run('INSERT INTO child(score) VALUES(1)')).rejects.toThrow();
  } finally {
    await adapter.disconnect();
  }
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
      it('creates, modifies and deletes checks/composite foreign keys, validates data and rolls back failed changes', async () => {
        const { schema, ...input } = config;
        const connection = {
          ...connectionSchema.parse({ ...input, host: '127.0.0.1' }),
          id: randomUUID(),
        };
        const adapter = createAdapter(connection, process.env.DB_TEST_PASSWORD);
        const stem = 'dw_c_' + randomUUID().replaceAll('-', '').slice(0, 16);
        const parent = stem + '_p',
          table = stem + '_c';
        const ref = { schema, table };
        const run = (sql: string) =>
          adapter.query(sql, [], { limit: 100, timeout: 10000, readOnly: false });
        const change = async (value: StructureChange) => {
          const before = await describeStructure(adapter, connection, ref);
          return applyStructure(adapter, connection, ref, value, before.version, 10000);
        };
        let parentCreated = false,
          childCreated = false;
        try {
          await run(`CREATE TABLE ${parent}(a INT NOT NULL,b INT NOT NULL,PRIMARY KEY(a,b))`);
          parentCreated = true;
          await run(`CREATE TABLE ${table}(id INT PRIMARY KEY,a INT NULL,b INT NULL,score INT)`);
          childCreated = true;
          await run(`CREATE INDEX ${stem}_idx ON ${table}(score)`);
          await run(`INSERT INTO ${parent} VALUES(1,2)`);
          await run(`INSERT INTO ${table} VALUES(1,1,2,5)`);
          const initial = await describeStructure(adapter, connection, ref);
          const check: ConstraintDefinition = {
            kind: 'check',
            name: stem + '_check',
            expression: 'score >= 0',
            notEnforced: false,
          };
          let current = await change({ action: 'constraint-upsert', constraint: check });
          expect(
            current.constraints?.find((item) => item.definition.name === check.name)?.definition,
          ).toMatchObject({ kind: 'check', name: check.name, notEnforced: false });
          await expect(run(`INSERT INTO ${table} VALUES(2,1,2,-1)`)).rejects.toThrow();
          await expect(
            applyStructure(
              adapter,
              connection,
              ref,
              { action: 'constraint-upsert', constraint: { ...check, name: stem + '_stale' } },
              initial.version,
              10000,
            ),
          ).rejects.toThrow('changed');
          const existing = current.constraints!.find(
            (item) => item.definition.name === check.name,
          )!;
          await expect(
            change({
              action: 'constraint-upsert',
              id: existing.id,
              constraint: { ...check, expression: 'score > 10' },
            }),
          ).rejects.toThrow();
          current = await describeStructure(adapter, connection, ref);
          expect(
            current.constraints!.find((item) => item.definition.name === check.name)!.definition,
          ).toEqual(existing.definition);
          expect((await run(`SELECT * FROM ${table}`)).rows).toHaveLength(1);
          current = await change({
            action: 'constraint-upsert',
            id: existing.id,
            constraint: { ...check, expression: 'score >= 2' },
          });
          if (current.constraintCapabilities?.notEnforced) {
            current = await change({
              action: 'constraint-upsert',
              id: current.constraints!.find((item) => item.definition.name === check.name)!.id,
              constraint: { ...check, notEnforced: true },
            });
            await run(`INSERT INTO ${table} VALUES(2,1,2,-1)`);
            await expect(
              change({
                action: 'constraint-upsert',
                id: current.constraints!.find((item) => item.definition.name === check.name)!.id,
                constraint: check,
              }),
            ).rejects.toThrow();
            await run(`DELETE FROM ${table} WHERE id=2`);
          }
          await change({
            action: 'constraint-drop',
            id: current.constraints!.find((item) => item.definition.name === check.name)!.id,
          });
          await run(`INSERT INTO ${table} VALUES(2,1,2,-1)`);
          const fk: ConstraintDefinition = {
            kind: 'foreign-key',
            name: stem + '_fk',
            columns: ['a', 'b'],
            referencedSchema: schema,
            referencedTable: parent,
            referencedColumns: ['a', 'b'],
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          };
          current = await change({ action: 'constraint-upsert', constraint: fk });
          expect(
            current.constraints?.find((item) => item.definition.name === fk.name)?.definition,
          ).toMatchObject(fk);
          await expect(
            change({
              action: 'constraint-upsert',
              id: current.constraints!.find((item) => item.definition.name === fk.name)!.id,
              constraint: { ...fk, referencedTable: `${stem}_missing` },
            }),
          ).rejects.toThrow();
          expect(
            (await describeStructure(adapter, connection, ref)).constraints!.find(
              (item) => item.definition.name === fk.name,
            )?.definition,
          ).toMatchObject(fk);
          await expect(run(`INSERT INTO ${table} VALUES(3,8,9,1)`)).rejects.toThrow();
          await run(`UPDATE ${parent} SET a=3 WHERE a=1`);
          expect((await run(`SELECT a FROM ${table} WHERE id=1`)).rows[0].a).toEqual(
            config.engine === 'sqlite' ? '3' : 3,
          );
          current = await change({
            action: 'constraint-upsert',
            id: current.constraints!.find((item) => item.definition.name === fk.name)!.id,
            constraint: { ...fk, onDelete: 'SET NULL' },
          });
          await run(`DELETE FROM ${parent}`);
          expect(
            (await run(`SELECT a,b FROM ${table}`)).rows.every(
              (row) => row.a === null && row.b === null,
            ),
          ).toBe(true);
          await change({
            action: 'constraint-drop',
            id: current.constraints!.find((item) => item.definition.name === fk.name)!.id,
          });
          await run(`INSERT INTO ${table} VALUES(3,8,9,1)`);
          expect((await run(`SELECT * FROM ${table}`)).rows).toHaveLength(3);
          const final = await describeStructure(adapter, connection, ref);
          expect(final.constraints).toEqual([]);
          if (config.engine === 'sqlite')
            expect(
              (await run(`SELECT name FROM sqlite_schema WHERE name='${stem}_idx'`)).rows,
            ).toHaveLength(1);
          expect(() =>
            planStructure(final, {
              action: 'constraint-upsert',
              constraint: { ...check, expression: '1); DROP TABLE innocent;--' },
            }),
          ).toThrow();
          expect(() =>
            planStructure(final, {
              action: 'constraint-upsert',
              constraint: { ...fk, referencedColumns: ['a'] },
            }),
          ).toThrow('matching');
        } finally {
          if (childCreated) await run(`DROP TABLE ${table}`);
          if (parentCreated) await run(`DROP TABLE ${parent}`);
          await adapter.disconnect();
        }
      }, 60000);
    },
  );

it('routes constraint changes through shared DDL and destructive approvals', async () => {
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
      name: 'constraints',
      engine: 'sqlite',
      database: ':memory:',
      agentAccess: 'write',
    });
    const adapter = await app.connections.connect(connection.id);
    await adapter.query('CREATE TABLE sample(id INT, value INT)', [], {
      limit: 0,
      timeout: 5000,
      readOnly: false,
    });
    const args = { connectionId: connection.id, schema: 'main', table: 'sample' };
    const actor = { kind: 'agent' as const, id: 'agent', name: 'Agent' };
    const before = await describeStructure(adapter, connection, args);
    const pending = await app.commands.dispatch(
      'structure.apply',
      {
        ...args,
        version: before.version,
        change: {
          action: 'constraint-upsert',
          constraint: {
            kind: 'check',
            name: 'positive',
            expression: 'value > 0',
            notEnforced: false,
          },
        },
      },
      actor,
    );
    expect(pending.approvalId).toBeTruthy();
    expect((await describeStructure(adapter, connection, args)).constraints).toEqual([]);
    expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
      true,
    );
    const current = await describeStructure(adapter, connection, args);
    const remove = await app.commands.dispatch(
      'structure.apply',
      {
        ...args,
        version: current.version,
        change: { action: 'constraint-drop', id: current.constraints![0].id },
      },
      actor,
    );
    expect(remove.approvalId).toBeTruthy();
    expect(app.permissions.list().find((item) => item.id === remove.approvalId)?.risk).toBe(
      'destructive',
    );
  } finally {
    await app.connections.shutdown();
  }
});
