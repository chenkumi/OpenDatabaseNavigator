import { expect, it, describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createAdapter } from '../src/main/database/factory';
import { connectionSchema } from '../src/shared/schemas';
import {
  describeStructure,
  applyStructure,
} from '../src/main/application/services/table-structure-service';
import {
  planPropertyChange,
  propertyString,
  replaceColumnOption,
  structurePropertyOptions,
} from '../src/main/database/structure-properties';
import type { PropertyChange } from '../src/shared/structure-properties';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS } from '../src/shared/types';

it('quotes Unicode and backslashes for each SQL string mode, and preserves nested column expressions', () => {
  expect(propertyString({ engine: 'mysql' }, "a\\b'中")).toBe("'a\\\\b''中'");
  expect(propertyString({ engine: 'mysql', mysqlNoBackslashEscapes: true }, "a\\b'中")).toBe(
    "'a\\b''中'",
  );
  expect(propertyString({ engine: 'postgres' }, "a\\b'中")).toBe("E'a\\\\b''中'");
  expect(propertyString({ engine: 'sqlserver' }, "a\\b'中")).toBe("N'a\\b''中'");
  expect(
    replaceColumnOption(
      "`v` varchar(40) DEFAULT 'COMMENT' COMMENT 'old' NOT NULL",
      'mysql',
      'comment',
      "COMMENT 'new'",
    ),
  ).toBe("`v` varchar(40) DEFAULT 'COMMENT' COMMENT 'new' NOT NULL");
  expect(
    replaceColumnOption(
      "v TEXT CHECK(v COLLATE BINARY <> 'x') COLLATE NOCASE",
      'sqlite',
      'collation',
      'COLLATE RTRIM',
    ),
  ).toBe("v TEXT CHECK(v COLLATE BINARY <> 'x') COLLATE RTRIM");
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
      it('round trips properties and comments, retains data/defaults/keys and rejects stale or invalid changes', async () => {
        const { schema, ...input } = config;
        const connection = {
          ...connectionSchema.parse({ ...input, host: '127.0.0.1' }),
          id: randomUUID(),
        };
        const adapter = createAdapter(connection, process.env.DB_TEST_PASSWORD);
        const table = 'dw_prop_' + randomUUID().replaceAll('-', '').slice(0, 14),
          ref = { schema, table };
        const run = (sql: string) =>
          adapter.query(sql, [], { limit: 100, timeout: 10000, readOnly: false });
        const change = async (value: PropertyChange) => {
          const before = await describeStructure(adapter, connection, ref);
          return applyStructure(adapter, connection, ref, value, before.version, 10000);
        };
        let created = false;
        try {
          await run(
            `CREATE TABLE ${table}(id INT NOT NULL PRIMARY KEY, label VARCHAR(40) NOT NULL DEFAULT 'guest', amount INT DEFAULT 7)`,
          );
          created = true;
          await run(`INSERT INTO ${table}(id,label) VALUES(1,'Alpha')`);
          const initial = await describeStructure(adapter, connection, ref);
          const options = await structurePropertyOptions(adapter, connection.engine);
          expect(options.column.collation).toBe(true);
          const collation =
            config.engine === 'sqlite'
              ? 'NOCASE'
              : config.engine === 'postgres'
                ? 'pg_catalog."C"'
                : config.engine === 'mysql'
                  ? 'utf8mb4_bin'
                  : 'Latin1_General_100_BIN2';
          const properties =
            config.engine === 'mysql' ? { charset: 'utf8mb4', collation } : { collation };
          let result = await change({ action: 'column-properties', column: 'label', properties });
          const label = () => result.columns.find((c) => c.name === 'label')!;
          expect(label().properties?.collation).toBe(collation);
          expect(label().nullable).toBe(false);
          expect(label().defaultSql).toContain('guest');
          expect(result.columns.find((c) => c.name === 'id')?.primaryKey).toBe(true);
          await expect(
            applyStructure(
              adapter,
              connection,
              ref,
              { action: 'column-properties', column: 'label', properties: { collation: 'bad' } },
              initial.version,
              10000,
            ),
          ).rejects.toThrow('structure changed');
          await expect(
            planPropertyChange(adapter, result, {
              action: 'column-properties',
              column: 'label',
              properties: { collation: 'bad; DROP TABLE x' },
            }),
          ).rejects.toThrow('collation');
          if (options.table.comment) {
            const comment = "使用者's C:\\logs\\note";
            result = await change({ action: 'table-properties', properties: { comment } });
            expect(result.properties?.comment).toBe(comment);
            result = await change({
              action: 'column-properties',
              column: 'label',
              properties: { comment },
            });
            expect(label().properties?.comment).toBe(comment);
            result = await change({
              action: 'column-properties',
              column: 'label',
              properties: { comment: '修改註解' },
            });
            expect(label().properties?.comment).toBe('修改註解');
            result = await change({
              action: 'table-properties',
              properties: { comment: '新註解' },
            });
            expect(result.properties?.comment).toBe('新註解');
            result = await change({
              action: 'column-properties',
              column: 'label',
              properties: { comment: '' },
            });
            result = await change({ action: 'table-properties', properties: { comment: '' } });
            expect(result.properties?.comment).toBe('');
            expect(label().properties?.comment).toBe('');
          }
          if (config.engine === 'mysql') {
            result = await change({
              action: 'column-properties',
              column: 'label',
              properties: { binary: false },
            });
            expect(label().properties?.binary).toBe(false);
            result = await change({
              action: 'column-properties',
              column: 'label',
              properties: { binary: true },
            });
            expect(label().properties?.collation).toBe('utf8mb4_bin');
            result = await change({
              action: 'table-properties',
              properties: { storageEngine: 'MyISAM', charset: 'latin1', collation: 'latin1_bin' },
            });
            expect(result.properties).toMatchObject({
              storageEngine: 'MyISAM',
              charset: 'latin1',
              collation: 'latin1_bin',
            });
            expect(label().properties?.charset).toBe('utf8mb4');
            result = await change({
              action: 'table-properties',
              properties: { storageEngine: 'InnoDB' },
            });
            expect(result.properties?.storageEngine).toBe('InnoDB');
            await expect(
              change({
                action: 'column-properties',
                column: 'label',
                properties: { charset: 'utf8mb4', collation: 'latin1_bin' },
              }),
            ).rejects.toThrow('collation');
          }
          await run(`INSERT INTO ${table}(id) VALUES(2)`);
          const data = (await run(`SELECT label,amount FROM ${table} ORDER BY id`)).rows;
          expect(data.map((r) => r.label)).toEqual(['Alpha', 'guest']);
          expect(String(data[1].amount)).toBe('7');
        } finally {
          if (created) await run(`DROP TABLE ${table}`);
          await adapter.disconnect();
        }
      }, 60000);
    },
  );

it('rolls back a SQLite collation rebuild when new comparison rules violate a unique key', async () => {
  const connection = {
    ...connectionSchema.parse({ name: 'SQLite', engine: 'sqlite', database: ':memory:' }),
    id: randomUUID(),
  };
  const adapter = createAdapter(connection);
  const run = (sql: string) =>
    adapter.query(sql, [], { limit: 100, timeout: 10000, readOnly: false });
  try {
    await run('CREATE TABLE test (v TEXT UNIQUE)');
    await run("INSERT INTO test VALUES('a'),('A')");
    const before = await describeStructure(adapter, connection, { schema: 'main', table: 'test' });
    await expect(
      applyStructure(
        adapter,
        connection,
        before,
        { action: 'column-properties', column: 'v', properties: { collation: 'NOCASE' } },
        before.version,
        10000,
      ),
    ).rejects.toThrow('UNIQUE');
    expect((await describeStructure(adapter, connection, before)).version).toBe(before.version);
    expect((await run('SELECT * FROM test')).rows).toHaveLength(2);
  } finally {
    await adapter.disconnect();
  }
});

it('requires destructive approval for collation changes through the shared command bus', async () => {
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore({
        ...DEFAULT_SETTINGS,
        policy: { ...DEFAULT_SETTINGS.policy, destructive: 'ask' },
      }),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    { get: () => undefined, set() {}, delete() {} },
    createAdapter,
  );
  try {
    const connection = await app.connections.save({
      name: 'properties',
      engine: 'sqlite',
      database: ':memory:',
      agentAccess: 'write',
    });
    const adapter = await app.connections.connect(connection.id);
    await adapter.query('CREATE TABLE sample(v TEXT)', [], {
      limit: 0,
      timeout: 5000,
      readOnly: false,
    });
    const ref = { connectionId: connection.id, schema: 'main', table: 'sample' };
    const before = await describeStructure(adapter, connection, ref);
    const actor = { kind: 'agent' as const, id: 'agent', name: 'Agent' };
    const change: PropertyChange = {
      action: 'column-properties',
      column: 'v',
      properties: { collation: 'NOCASE' },
    };
    const preview = await app.commands.dispatch('structure.preview', { ...ref, change }, actor);
    expect(preview.success).toBe(true);
    const pending = await app.commands.dispatch(
      'structure.apply',
      { ...ref, change, version: before.version },
      actor,
    );
    expect(pending.approvalId).toBeTruthy();
    expect(app.permissions.list().find((item) => item.id === pending.approvalId)?.risk).toBe(
      'destructive',
    );
    expect(
      (await describeStructure(adapter, connection, ref)).columns[0].properties?.collation,
    ).toBe('BINARY');
    expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
      true,
    );
    expect(
      (await describeStructure(adapter, connection, ref)).columns[0].properties?.collation,
    ).toBe('NOCASE');
  } finally {
    await app.connections.shutdown();
  }
});
