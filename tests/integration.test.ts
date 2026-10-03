import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { createAdapter } from '../src/main/database/factory';
import { DEFAULT_SETTINGS, type Engine, type Actor } from '../src/shared/types';
const agent: Actor = { kind: 'agent', id: 'integration-agent', name: 'Integration Agent' };
function fixture() {
  const secrets = new Map<string, string>();
  return new Application(
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
}
const engines: {
  name: string;
  engine: Engine;
  port: number;
  username: string;
  database: string;
  schema: string;
}[] = [
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
describe.skipIf(process.env.DB_INTEGRATION !== '1')('real database integration', () => {
  for (const config of engines) {
    it(`${config.name}: metadata, parameterized CRUD, approval, bounds, timeout and reconnect`, async () => {
      const app = fixture();
      const table = 'dw_' + randomUUID().replaceAll('-', '');
      const { schema, name, ...settings } = config;
      const connection = await app.connections.save({
        ...settings,
        name,
        host: '127.0.0.1',
        password: process.env.DB_TEST_PASSWORD,
        agentAccess: 'write',
        connectionTimeout: 12345,
        ...(config.engine === 'mysql' ? { charset: 'latin1' } : {}),
      });
      const args = { connectionId: connection.id, table, schema };
      const dispatch = async (name: string, input: object, actor = HUMAN) => {
        if (process.env.DB_INTEGRATION_DEBUG) console.info(config.name, name);
        const result = await app.commands.dispatch(name, input, actor);
        expect(result.success, `${name}: ${result.error}`).toBe(true);
        return result.data as any;
      };
      let created = false;
      try {
        await dispatch('connection.connect', { connectionId: connection.id });
        if (config.engine === 'mysql') {
          const session = await dispatch('query.execute', {
            connectionId: connection.id,
            sql: 'SELECT @@character_set_client AS client_charset, @@character_set_connection AS connection_charset',
          });
          expect(session.rows[0]).toMatchObject({
            client_charset: 'latin1',
            connection_charset: 'latin1',
          });
        }
        const available = await dispatch('database.options', { connectionId: connection.id });
        const databaseOptions =
          config.engine === 'mysql'
            ? { charset: 'utf8mb4', collation: 'utf8mb4_bin' }
            : config.engine === 'sqlserver'
              ? { collation: 'Latin1_General_100_CI_AS' }
              : {};
        if (config.engine === 'mysql') expect(available.charsets).toContain('utf8mb4');
        if ('collation' in databaseOptions)
          expect(available.collations.map((item: { name: string }) => item.name)).toContain(
            databaseOptions.collation,
          );
        const databaseName = `${table}_db`;
        await dispatch('database.create', {
          connectionId: connection.id,
          database: databaseName,
          ...databaseOptions,
        });
        try {
          if (config.engine === 'mysql' || config.engine === 'sqlserver') {
            const metadata = await dispatch('query.execute', {
              connectionId: connection.id,
              sql:
                config.engine === 'mysql'
                  ? `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${databaseName}'`
                  : `SELECT collation_name AS collation FROM sys.databases WHERE name = '${databaseName}'`,
            });
            expect(metadata.rows[0]).toMatchObject(databaseOptions);
          }
          expect(await dispatch('database.list', { connectionId: connection.id })).toContain(
            databaseName,
          );
          const duplicate = await app.commands.dispatch(
            'database.create',
            { connectionId: connection.id, database: databaseName },
            HUMAN,
          );
          expect(duplicate.success).toBe(false);
        } finally {
          await dispatch('query.execute', {
            connectionId: connection.id,
            sql: `DROP DATABASE ${databaseName}`,
          });
        }

        await dispatch('query.execute', {
          connectionId: connection.id,
          sql: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL, score INTEGER DEFAULT 7)`,
        });
        created = true;

        await dispatch('query.execute', {
          connectionId: connection.id,
          sql: `CREATE INDEX ${table}_idx ON ${table}(name)`,
        });
        if (config.engine === 'postgres')
          await dispatch('query.execute', {
            connectionId: connection.id,
            sql: `CREATE FUNCTION ${table}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
          });
        const triggerSql =
          config.engine === 'postgres'
            ? `CREATE TRIGGER ${table}_trg BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${table}_fn()`
            : config.engine === 'mysql'
              ? `CREATE TRIGGER ${table}_trg BEFORE INSERT ON ${table} FOR EACH ROW SET NEW.score = NEW.score`
              : `CREATE TRIGGER ${table}_trg ON ${table} AFTER INSERT AS SET NOCOUNT ON`;
        await dispatch('query.execute', { connectionId: connection.id, sql: triggerSql });
        if (config.engine === 'mysql')
          await dispatch('query.execute', {
            connectionId: connection.id,
            sql: `CREATE TRIGGER ${table}_sibling BEFORE INSERT ON ${table} FOR EACH ROW SET NEW.score = NEW.score + 1`,
          });
        if (config.engine === 'mysql')
          await dispatch('query.execute', {
            connectionId: connection.id,
            sql: `ALTER TABLE ${table} ALTER INDEX ${table}_idx ${config.name === 'MariaDB' ? 'IGNORED' : 'INVISIBLE'}`,
          });
        // Exercise actual catalog definitions and adapter DDL transactions on
        // every supported server, not just generated SQL snapshots.
        const objectRef = {
          ...args,
          database: config.database,
          objectName: `${table}_idx`,
          kind: 'index',
        };
        const indexDefinition = await dispatch('object.describe', objectRef);
        expect(indexDefinition.readOnlyReason).toBeUndefined();
        const newIndexSql = indexDefinition.editableSql.replace(/\bname\b/g, 'score');
        const indexPlan = await dispatch('object.preview', { ...objectRef, sql: newIndexSql });
        expect(indexPlan.statements.length).toBeGreaterThan(0);
        const editedIndex = await dispatch('object.apply', {
          ...objectRef,
          sql: newIndexSql,
          version: indexDefinition.version,
        });
        expect(editedIndex.editableSql).toContain('score');
        const badIndex = await app.commands.dispatch(
          'object.apply',
          {
            ...objectRef,
            sql: newIndexSql.replace(/\bscore\b/g, 'missing_column'),
            version: editedIndex.version,
          },
          HUMAN,
        );
        expect(badIndex.success).toBe(false);
        expect((await dispatch('object.describe', objectRef)).version).toBe(editedIndex.version);
        const triggerRef = { ...objectRef, objectName: `${table}_trg`, kind: 'trigger' };
        const triggerDefinition = await dispatch('object.describe', triggerRef);
        expect(triggerDefinition.readOnlyReason).toBeUndefined();
        const editedTriggerSql =
          config.engine === 'postgres'
            ? triggerDefinition.editableSql.replace('BEFORE INSERT', 'BEFORE UPDATE')
            : config.engine === 'mysql'
              ? triggerDefinition.editableSql.replace(
                  'SET NEW.score = NEW.score',
                  'BEGIN SET NEW.score = 42; SET NEW.name = NEW.name; END',
                )
              : triggerDefinition.editableSql +
                `; UPDATE ${table} SET score=42 WHERE id IN (SELECT id FROM inserted)`;
        const editedTrigger = await dispatch('object.apply', {
          ...triggerRef,
          sql: editedTriggerSql,
          version: triggerDefinition.version,
        });
        expect(editedTrigger.version).not.toBe(triggerDefinition.version);
        if (config.engine !== 'postgres') {
          await dispatch('data.insert', {
            ...args,
            values: { id: -1, name: 'trigger check', score: 0 },
          });
          const checked = await dispatch('query.read', {
            connectionId: connection.id,
            sql: `SELECT score FROM ${table} WHERE id=-1`,
          });
          expect(Number(checked.rows[0].score)).toBe(config.engine === 'mysql' ? 43 : 42);
          await dispatch('query.execute', {
            connectionId: connection.id,
            sql: `DELETE FROM ${table} WHERE id=-1`,
          });
        }
        const brokenSql =
          config.engine === 'postgres'
            ? editedTriggerSql.replace(`${table}_fn`, 'missing_function')
            : config.engine === 'mysql'
              ? editedTriggerSql.replace('SET NEW.score = 42', 'INVALID SQL')
              : editedTriggerSql + '; INVALID SQL';
        const badTrigger = await app.commands.dispatch(
          'object.apply',
          { ...triggerRef, sql: brokenSql, version: editedTrigger.version },
          HUMAN,
        );
        expect(badTrigger.success).toBe(false);
        expect((await dispatch('object.describe', triggerRef)).version).toBe(editedTrigger.version);
        await dispatch('object.apply', {
          ...triggerRef,
          sql: triggerDefinition.editableSql,
          version: editedTrigger.version,
        });
        if (config.engine === 'mysql')
          await dispatch('query.execute', {
            connectionId: connection.id,
            sql: `DROP TRIGGER ${table}_sibling`,
          });
        if (config.engine === 'sqlserver') {
          const illegal = await app.commands.dispatch(
            'object.preview',
            { ...objectRef, sql: editedIndex.editableSql + ` DROP TABLE ${table}` },
            HUMAN,
          );
          expect(illegal.success).toBe(false);
          await dispatch('query.execute', {
            connectionId: connection.id,
            sql: `DISABLE TRIGGER ${table}_trg ON ${table}`,
          });
          const disabled = await dispatch('object.describe', triggerRef);
          await dispatch('object.apply', {
            ...triggerRef,
            sql: disabled.editableSql + ' -- keep disabled',
            version: disabled.version,
          });
          expect(
            Number(
              (
                await dispatch('query.read', {
                  connectionId: connection.id,
                  sql: `SELECT is_disabled FROM sys.triggers WHERE name='${table}_trg'`,
                })
              ).rows[0].is_disabled,
            ),
          ).toBe(1);
          await dispatch('query.execute', {
            connectionId: connection.id,
            sql: `ENABLE TRIGGER ${table}_trg ON ${table}`,
          });
        }
        expect(
          await dispatch('index.list', { connectionId: connection.id, database: config.database }),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: `${table}_idx`, table, schema }),
          ]),
        );
        expect(
          await dispatch('trigger.list', {
            connectionId: connection.id,
            database: config.database,
          }),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: `${table}_trg`, table, schema }),
          ]),
        );
        expect(await dispatch('database.list', { connectionId: connection.id })).toContain(
          config.database,
        );
        expect(await dispatch('schema.list', { connectionId: connection.id })).toContain(schema);
        expect(await dispatch('table.list', { connectionId: connection.id, schema })).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: table, kind: 'table' })]),
        );
        expect(await dispatch('table.describe', args)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'id', primaryKey: true }),
            expect.objectContaining({ name: 'name', nullable: false }),
          ]),
        );
        const hostile = "Alice'); DROP TABLE users; --";
        expect(
          await dispatch('data.insert', { ...args, values: { id: 1, name: hostile } }),
        ).toMatchObject({ affectedRows: 1 });
        await dispatch('data.insert', { ...args, values: { id: 2, name: 'Bob' } });
        await dispatch('data.insert', { ...args, values: { id: 3, name: 'Carol' } });
        expect(
          await dispatch(
            'data.select',
            { ...args, limit: 1, sort: [{ column: 'id', direction: 'asc' }] },
            agent,
          ),
        ).toMatchObject({ rowCount: 1, hasMore: true, rows: [{ id: 1, name: hostile }] });
        expect(
          await dispatch(
            'data.select',
            { ...args, limit: 1, offset: 1, sort: [{ column: 'id', direction: 'asc' }] },
            agent,
          ),
        ).toMatchObject({ rows: [{ name: 'Bob' }] });
        const firstPage = await dispatch(
          'query.read',
          {
            connectionId: connection.id,
            sql: `SELECT id, name FROM ${table} ORDER BY id`,
            limit: 1,
          },
          agent,
        );
        const secondPage = await dispatch(
          'query.next',
          { connectionId: connection.id, cursor: firstPage.nextCursor },
          agent,
        );
        const thirdPage = await dispatch(
          'query.next',
          { connectionId: connection.id, cursor: secondPage.nextCursor },
          agent,
        );
        expect([firstPage.rows[0].id, secondPage.rows[0].id, thirdPage.rows[0].id]).toEqual([
          1, 2, 3,
        ]);
        expect(thirdPage.hasMore).toBe(false);
        expect(
          (
            await dispatch(
              'query.read',
              { connectionId: connection.id, sql: `EXPLAIN SELECT * FROM ${table}` },
              agent,
            )
          ).rows.length,
        ).toBeGreaterThan(0);
        const otherDatabase =
          config.engine === 'postgres'
            ? 'postgres'
            : config.engine === 'mysql'
              ? 'mysql'
              : 'tempdb';
        const identitySql =
          config.engine === 'postgres'
            ? 'SELECT current_database() AS name'
            : config.engine === 'mysql'
              ? 'SELECT DATABASE() AS name'
              : 'SELECT DB_NAME() AS name';
        expect(
          await dispatch('query.execute', {
            connectionId: connection.id,
            database: otherDatabase,
            sql: identitySql,
          }),
        ).toMatchObject({ rows: [{ name: otherDatabase }] });
        expect(
          await dispatch('query.execute', { connectionId: connection.id, sql: identitySql }),
        ).toMatchObject({ rows: [{ name: config.database }] });
        const pending = await app.commands.dispatch(
          'data.update',
          {
            ...args,
            values: { name: 'Approved' },
            filters: [{ column: 'id', operator: '=', value: 1 }],
          },
          agent,
        );
        expect(pending.approvalId).toBeTruthy();
        expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
          true,
        );
        expect(
          await dispatch(
            'data.select',
            { ...args, filters: [{ column: 'name', operator: '=', value: 'Approved' }] },
            agent,
          ),
        ).toMatchObject({ rowCount: 1 });
        expect(
          (
            await app.commands.dispatch(
              'query.read',
              { connectionId: connection.id, sql: `DELETE FROM ${table}` },
              agent,
            )
          ).success,
        ).toBe(false);
        expect(
          await dispatch('data.delete', {
            ...args,
            filters: [{ column: 'id', operator: '=', value: 3 }],
          }),
        ).toMatchObject({ affectedRows: 1 });
        const adapter = await app.connections.connect(connection.id);
        const slow =
          config.engine === 'postgres'
            ? 'SELECT pg_sleep(5)'
            : config.engine === 'mysql'
              ? 'SELECT SLEEP(5)'
              : "WAITFOR DELAY '00:00:05'; SELECT 1 AS value";
        await expect(
          adapter.query(slow, [], { limit: 10, timeout: 100, readOnly: true }),
        ).rejects.toThrow(/timed out/);
        expect(await dispatch('data.select', args)).toMatchObject({ rowCount: 2 });
        await app.connections.disconnect(connection.id);
        expect(await dispatch('data.select', args)).toMatchObject({ rowCount: 2 });
      } finally {
        if (created)
          await app.commands.dispatch(
            'query.execute',
            { connectionId: connection.id, sql: `DROP TABLE ${table}` },
            HUMAN,
          );
        if (config.engine === 'postgres')
          await app.commands.dispatch(
            'query.execute',
            { connectionId: connection.id, sql: `DROP FUNCTION IF EXISTS ${table}_fn() CASCADE` },
            HUMAN,
          );
        await app.connections.shutdown();
      }
    }, 30000);
  }
  it('Redis: streams preserve IDs, duplicate fields, pagination and database isolation', async () => {
    const app = fixture();
    const connection = await app.connections.save({
      name: 'Stream integration',
      engine: 'redis',
      readTimeout: 2000,
      writeTimeout: 2000,
      host: '127.0.0.1',
      port: 16379,
      database: '0',
      password: process.env.DB_TEST_PASSWORD,
      agentAccess: 'write',
    });
    const key = 'dw:stream:' + randomUUID();
    const ref = { connectionId: connection.id, database: '12', key };
    const dispatch = async (name: string, args: object = {}) => {
      const result = await app.commands.dispatch(name, { ...ref, ...args }, HUMAN);
      expect(result.success, `${name}: ${result.error}`).toBe(true);
      return result.data as any;
    };
    try {
      const fields = [
        ['level', 'info'],
        ['message', '你好'],
        ['message', 'second'],
        ['metadata', '{"x":1}'],
      ];
      await dispatch('redis.xadd', { id: '9007199254740993-0', fields });
      await dispatch('redis.xadd', { id: '9007199254740993-1', fields: [['different', 'value']] });
      const first = await dispatch('redis.get', { limit: 1 });
      expect(first.type).toBe('stream');
      expect(first.items).toEqual([{ id: '9007199254740993-0', fields }]);
      expect(first.hasMore).toBe(true);
      expect(
        (
          await app.commands.dispatch(
            'redis.get',
            { ...ref, database: '0', cursor: first.nextCursor },
            HUMAN,
          )
        ).success,
      ).toBe(false);
      await dispatch('redis.xdelete', { id: first.items[0].id });
      const second = await dispatch('redis.get', { cursor: first.nextCursor });
      expect(second.items[0].id).toBe('9007199254740993-1');
      expect(second.hasMore).toBe(false);
      await dispatch('redis.expire', { ttl: 90 });
      await dispatch('redis.xadd', { fields: [['level', 'warn']] });
      expect((await dispatch('redis.ttl')).ttl).toBeGreaterThan(0);
      expect((await dispatch('redis.get', { database: '0' })).type).toBe('none');
      const denied = await app.commands.dispatch(
        'redis.xdelete',
        { ...ref, id: '9007199254740993-1' },
        agent,
      );
      expect(denied.success).toBe(false);
      for (const item of (await dispatch('redis.get')).items)
        await dispatch('redis.xdelete', { id: item.id });
      expect((await dispatch('redis.get')).items).toEqual([]);
      expect((await dispatch('redis.get')).type).toBe('stream');
      const jsonUnavailable = await app.commands.dispatch(
        'redis.json_set',
        { ...ref, key: key + ':json', value: '{}' },
        HUMAN,
      );
      expect(jsonUnavailable.success).toBe(false);
      expect(jsonUnavailable.error).toContain('does not support Redis JSON');
    } finally {
      await app.commands.dispatch('redis.delete', ref, HUMAN);
      await app.connections.shutdown();
    }
  });
  it('Redis: native JSON documents and scalars roundtrip without changing type or TTL', async () => {
    const app = fixture();
    const connection = await app.connections.save({
      name: 'JSON integration',
      engine: 'redis',
      readTimeout: 2000,
      writeTimeout: 2000,
      host: '127.0.0.1',
      port: 16380,
      database: '0',
      password: process.env.DB_TEST_PASSWORD,
      agentAccess: 'write',
    });
    const ref = { connectionId: connection.id, database: '12', key: 'dw:json:' + randomUUID() };
    const dispatch = async (name: string, args: object = {}) => {
      const result = await app.commands.dispatch(name, { ...ref, ...args }, HUMAN);
      expect(result.success, `${name}: ${result.error}`).toBe(true);
      return result.data as any;
    };
    try {
      await dispatch('redis.json_set', {
        value: '{"nested":[true,null,"中文"],"large":9007199254740993}',
      });
      const first = await dispatch('redis.get');
      expect(first.type).toBe('json');
      expect(first.items[0]).toContain('9007199254740993');
      expect(JSON.parse(first.items[0]).nested).toEqual([true, null, '中文']);
      await dispatch('redis.expire', { ttl: 90 });
      const malformed = await app.commands.dispatch(
        'redis.json_set',
        { ...ref, value: '{broken' },
        HUMAN,
      );
      expect(malformed.success).toBe(false);
      expect((await dispatch('redis.get')).items).toEqual(first.items);
      for (const value of ['[1,"two"]', '"text"', '42', 'true', 'null', '{}']) {
        await dispatch('redis.json_set', { value });
        const page = await dispatch('redis.get');
        expect(page.type).toBe('json');
        expect(JSON.parse(page.items[0])).toEqual(JSON.parse(value));
        expect(page.ttl).toBeGreaterThan(0);
      }
      expect((await dispatch('redis.get', { database: '0' })).type).toBe('none');
      const approval = await app.commands.dispatch(
        'redis.json_set',
        { ...ref, value: '"agent"' },
        agent,
      );
      expect(approval.success).toBe(false);
      expect(approval.approvalId).toBeTruthy();
    } finally {
      await app.commands.dispatch('redis.delete', ref, HUMAN);
      await app.connections.shutdown();
    }
  });
  it('Redis: database selection isolates reads, writes, cursors, counts and tabs', async () => {
    const app = fixture();
    const connection = await app.connections.save({
      name: 'Redis scopes',
      engine: 'redis',
      readTimeout: 2000,
      writeTimeout: 2000,
      host: '127.0.0.1',
      port: 16379,
      database: '0',
      password: process.env.DB_TEST_PASSWORD,
      agentAccess: 'write',
    });
    const connectionId = connection.id;
    const key = 'dw:scopes:' + randomUUID();
    const dispatch = async (name: string, args: object = {}) => {
      const result = await app.commands.dispatch(name, { connectionId, ...args }, HUMAN);
      expect(result.success, `${name}: ${result.error}`).toBe(true);
      return result.data as any;
    };
    try {
      const before = await dispatch('redis.databases');
      expect(before.inferred).toBe(false);
      expect(before.databases.map((db: any) => db.database)).toEqual(
        Array.from({ length: 16 }, (_, id) => String(id)),
      );
      await Promise.all(
        ['0', '12', '15'].map((database) =>
          dispatch('redis.set', { database, key, value: 'DB' + database }),
        ),
      );
      for (const database of ['0', '12', '15']) {
        expect((await dispatch('redis.get', { database, key })).items).toEqual(['DB' + database]);
        const tab = await dispatch('app.open_redis', { database });
        expect(tab.database).toBe(database);
        expect(tab.title).toBe('Redis DB' + database);
        expect((await dispatch('app.open_redis', { database })).id).toBe(tab.id);
      }
      const after = await dispatch('redis.databases');
      for (const database of ['0', '12', '15'])
        expect(after.databases.find((db: any) => db.database === database).keys).toBe(
          before.databases.find((db: any) => db.database === database).keys + 1,
        );
      await dispatch('redis.expire', { database: '12', key, ttl: 60 });
      expect((await dispatch('redis.ttl', { database: '12', key })).ttl).toBeGreaterThan(0);
      expect((await dispatch('redis.ttl', { database: '0', key })).ttl).toBe(-1);
      await dispatch('redis.rpush', { database: '12', key: key + ':list', value: 'one' });
      await dispatch('redis.rpush', { database: '12', key: key + ':list', value: 'two' });
      const first = await dispatch('redis.lrange', {
        database: '12',
        key: key + ':list',
        limit: 1,
      });
      expect(first.nextCursor).toBeTruthy();
      expect(
        (
          await app.commands.dispatch(
            'redis.lrange',
            { connectionId, database: '0', key: key + ':list', cursor: first.nextCursor },
            HUMAN,
          )
        ).success,
      ).toBe(false);
      expect(
        (
          await dispatch('redis.lrange', {
            database: '12',
            key: key + ':list',
            cursor: first.nextCursor,
          })
        ).items[0].value,
      ).toBe('two');
      for (let index = 0; index < 16; index++)
        await dispatch('redis.scan', { database: String(index), pattern: key });
      await dispatch('redis.delete', { database: '12', key });
      expect((await dispatch('redis.get', { database: '12', key })).type).toBe('none');
      expect((await dispatch('redis.get', { database: '0', key })).items).toEqual(['DB0']);
      await dispatch('connection.disconnect', { discard: true });
      expect(app.workspace.get().tabs).toHaveLength(0);
      expect(app.connections.status(connectionId).connected).toBe(false);
      expect(
        (await app.commands.dispatch('redis.get', { connectionId, database: '15', key }, HUMAN))
          .success,
      ).toBe(false);
      await dispatch('connection.connect');
    } finally {
      for (const database of ['0', '12', '15'])
        await app.commands.dispatch('redis.delete', { connectionId, database, key }, HUMAN);
      await app.commands.dispatch(
        'redis.delete',
        { connectionId, database: '12', key: key + ':list' },
        HUMAN,
      );
      await app.connections.shutdown();
    }
  });
  it('Redis: five types, bounded scan continuation, mutation approval, TTL and credential isolation', async () => {
    const app = fixture();
    const prefix = 'dw:' + randomUUID() + ':';
    const connection = await app.connections.save({
      name: 'Redis integration',
      engine: 'redis',
      readTimeout: 2000,
      writeTimeout: 2000,
      host: '127.0.0.1',
      port: 16379,
      database: '0',
      password: process.env.DB_TEST_PASSWORD,
      agentAccess: 'write',
    });
    const connectionId = connection.id;
    const dispatch = async (name: string, input: object, actor = HUMAN) => {
      const result = await app.commands.dispatch(name, { connectionId, ...input }, actor);
      expect(result.success, `${name}: ${result.error}`).toBe(true);
      return result.data as any;
    };
    try {
      await dispatch('redis.set', { key: prefix + 'string', value: 'hello' });
      await dispatch('redis.hset', { key: prefix + 'hash', field: 'a', value: 'A' });
      await dispatch('redis.hset', { key: prefix + 'hash', field: 'b', value: 'B' });
      await dispatch('redis.rpush', { key: prefix + 'list', value: 'one' });
      await dispatch('redis.rpush', { key: prefix + 'list', value: 'two' });
      await dispatch('redis.sadd', { key: prefix + 'set', member: 'member' });
      await dispatch('redis.zadd', { key: prefix + 'zset', member: 'member', score: 3 });
      expect(await dispatch('redis.get', { key: prefix + 'string' }, agent)).toMatchObject({
        type: 'string',
        items: ['hello'],
      });
      const hash = await dispatch('redis.hgetall', { key: prefix + 'hash', limit: 1 }, agent);
      expect(hash.items).toHaveLength(1);
      expect(hash.nextCursor).toBeTruthy();
      const next = await dispatch(
        'redis.hgetall',
        { key: prefix + 'hash', cursor: hash.nextCursor },
        agent,
      );
      expect(next.items).toHaveLength(1);
      expect(next.items[0].field).not.toBe(hash.items[0].field);
      expect(
        (
          await app.commands.dispatch(
            'redis.hgetall',
            { connectionId, key: prefix + 'hash', cursor: hash.nextCursor },
            agent,
          )
        ).success,
      ).toBe(false);
      expect(
        await dispatch('redis.lrange', { key: prefix + 'list', limit: 1 }, agent),
      ).toMatchObject({ items: [{ index: 0, value: 'one' }], hasMore: true });
      expect(await dispatch('redis.smembers', { key: prefix + 'set' }, agent)).toMatchObject({
        items: ['member'],
      });
      expect(await dispatch('redis.zrange', { key: prefix + 'zset' }, agent)).toMatchObject({
        items: [{ member: 'member', score: 3 }],
      });
      await dispatch('redis.expire', { key: prefix + 'string', ttl: 60 });
      expect((await dispatch('redis.ttl', { key: prefix + 'string' }, agent)).ttl).toBeGreaterThan(
        0,
      );
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await dispatch(
          'redis.scan',
          { pattern: prefix + '*', limit: 2, cursor },
          agent,
        );
        expect(page.items.length).toBeLessThanOrEqual(2);
        keys.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(keys).size).toBe(5);
      const pending = await app.commands.dispatch(
        'redis.set',
        { connectionId, key: prefix + 'string', value: 'approved' },
        agent,
      );
      expect(pending.approvalId).toBeTruthy();
      expect((await app.commands.resolveApproval(pending.approvalId!, true, HUMAN)).success).toBe(
        true,
      );
      expect(await dispatch('redis.get', { key: prefix + 'string' }, agent)).toMatchObject({
        items: ['approved'],
      });
      expect(JSON.stringify(app.audit.list())).not.toContain(process.env.DB_TEST_PASSWORD);
      await dispatch('redis.set', { key: prefix + 'string', value: '中'.repeat(400000) });
      const oversized = await app.commands.dispatch(
        'redis.get',
        { connectionId, key: prefix + 'string' },
        HUMAN,
      );
      expect(oversized.success).toBe(false);
      expect(oversized.error).toContain('1 MiB');
      await dispatch('redis.set', { key: prefix + 'string', value: 'small again' });
      expect(await dispatch('redis.get', { key: prefix + 'string' })).toMatchObject({
        items: ['small again'],
      });
      const typedCursor = await dispatch(
        'redis.hgetall',
        { key: prefix + 'hash', limit: 1 },
        agent,
      );
      expect(
        (
          await app.commands.dispatch(
            'redis.hgetall',
            { connectionId, key: prefix + 'hash', cursor: typedCursor.nextCursor },
            { ...agent, id: 'different-agent' },
          )
        ).success,
      ).toBe(false);
      await dispatch('redis.set', { key: prefix + 'hash', value: 'now a string' });
      expect(
        (
          await app.commands.dispatch(
            'redis.hgetall',
            { connectionId, key: prefix + 'hash', cursor: typedCursor.nextCursor },
            agent,
          )
        ).success,
      ).toBe(false);
      await dispatch('app.open_redis', {}, agent);
      expect(app.workspace.get().tabs[0].type).toBe('redis');
      const policy = app.getSettings();
      policy.agentLevel = 'execute';
      policy.policy.update = 'allow';
      policy.policy.delete = 'deny';
      await app.commands.dispatch('settings.save', policy, HUMAN);
      expect(
        (
          await app.commands.dispatch(
            'redis.expire',
            { connectionId, key: prefix + 'string', ttl: 0 },
            agent,
          )
        ).success,
      ).toBe(false);
      expect(
        (
          await app.commands.dispatch(
            'redis.expire',
            { connectionId, key: prefix + 'string', ttl: 60 },
            agent,
          )
        ).success,
      ).toBe(true);
    } finally {
      for (const type of ['string', 'hash', 'list', 'set', 'zset'])
        await app.commands.dispatch('redis.delete', { connectionId, key: prefix + type }, HUMAN);
      await app.connections.shutdown();
    }
  }, 30000);
});

describe.skipIf(process.env.DB_INTEGRATION !== '1')('real structure editing', () => {
  for (const config of engines) {
    it(`${config.name}: table columns and view definition editing`, async () => {
      const app = fixture();
      const table = 'dw_structure_' + randomUUID().replaceAll('-', '');
      const view = `${table}_v`;
      const { schema, name, ...settings } = config;
      const connection = await app.connections.save({
        ...settings,
        name,
        host: '127.0.0.1',
        password: process.env.DB_TEST_PASSWORD,
        agentAccess: 'write',
      });
      const ref = { connectionId: connection.id, database: config.database, schema, table };
      const call = async (name: string, args: object) => {
        const result = await app.commands.dispatch(name, args, HUMAN);
        expect(result.success, `${name}: ${result.error}`).toBe(true);
        return result.data as any;
      };
      const run = (sql: string) => call('query.execute', { connectionId: connection.id, sql });
      const read = (tableName = table) => call('structure.describe', { ...ref, table: tableName });
      const edit = async (change: object, tableName = table) => {
        const current = await read(tableName);
        await call('structure.preview', { ...ref, table: tableName, change });
        return call('structure.apply', {
          ...ref,
          table: tableName,
          change,
          version: current.version,
        });
      };
      try {
        await run(
          `CREATE TABLE ${table}(id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL, score INTEGER DEFAULT 7)`,
        );
        await run(`INSERT INTO ${table}(id,name) VALUES(1,'one')`);
        const before = await read();
        expect(before.columns.find((c: any) => c.name === 'name').type).toMatch(
          /(?:varchar|character varying)\(100\)/i,
        );
        await edit({
          action: 'add',
          name: 'extra',
          type: 'VARCHAR(30)',
          nullable: false,
          defaultSql: "'added'",
          primaryKey: true,
        });
        expect((await run(`SELECT extra FROM ${table}`)).rows[0].extra).toBe('added');
        await edit({
          action: 'edit-columns',
          primaryKey: ['id', 'score', 'extra'],
          changes: [
            { action: 'type', column: 'name', type: 'VARCHAR(200)' },
            { action: 'type', column: 'score', type: 'BIGINT' },
            { action: 'nullable', column: 'score', nullable: false },
            { action: 'default', column: 'score', defaultSql: '9' },
            { action: 'rename', column: 'extra', name: 'notes' },
          ],
        });
        expect((await read()).columns.find((c: any) => c.name === 'name').type).toContain('200');
        expect(
          (await read()).columns.find((c: any) => c.name === 'score').type.toLowerCase(),
        ).toContain('bigint');
        expect((await read()).columns.find((c: any) => c.name === 'score').nullable).toBe(false);
        expect(
          (await read()).columns.filter((c: any) => c.primaryKey).map((c: any) => c.name),
        ).toEqual(['id', 'score', 'notes']);
        await edit({ action: 'primary-key', columns: ['id'] });
        // A type-only batch must preserve the existing default constraint on SQL Server.
        await edit({
          action: 'edit-columns',
          changes: [{ action: 'type', column: 'score', type: 'DECIMAL(18,0)' }],
        });
        await run(`INSERT INTO ${table}(id,name) VALUES(2,'two')`);
        expect(Number((await run(`SELECT score FROM ${table} WHERE id=2`)).rows[0].score)).toBe(9);
        expect((await read()).columns.some((c: any) => c.name === 'notes')).toBe(true);
        await edit({ action: 'drop', column: 'notes' });
        const stale = await app.commands.dispatch(
          'structure.apply',
          { ...ref, change: { action: 'drop', column: 'score' }, version: before.version },
          HUMAN,
        );
        expect(stale.success).toBe(false);
        await edit({ action: 'primary-key', columns: ['id'] });
        expect((await read()).columns.find((c: any) => c.name === 'id').primaryKey).toBe(true);
        const current = await read();
        const invalid = await app.commands.dispatch(
          'structure.apply',
          {
            ...ref,
            change: { action: 'type', column: 'name', type: 'MISSING_TYPE' },
            version: current.version,
          },
          HUMAN,
        );
        expect(invalid.success).toBe(false);
        expect((await read()).version).toBe(current.version);
        const denied = await app.commands.dispatch(
          'structure.apply',
          { ...ref, change: { action: 'drop', column: 'score' }, version: current.version },
          agent,
        );
        expect(denied.success).toBe(false);
        await run(`CREATE VIEW ${view} AS SELECT id,name,score FROM ${table}`);
        const definition = await read(view);
        expect(definition.kind).toBe('view');
        const newSql = definition.definition.trim().replace(/;$/, '') + ' WHERE id=1';
        await edit({ action: 'view', sql: newSql }, view);
        expect((await run(`SELECT * FROM ${view}`)).rows).toHaveLength(1);
        const stable = await read(view);
        const badView = await app.commands.dispatch(
          'structure.apply',
          {
            ...ref,
            table: view,
            change: { action: 'view', sql: newSql.replace('WHERE id=1', 'WHERE missing_column=1') },
            version: stable.version,
          },
          HUMAN,
        );
        expect(badView.success).toBe(false);
        expect((await run(`SELECT * FROM ${view}`)).rows).toHaveLength(1);
      } finally {
        await app.commands.dispatch(
          'query.execute',
          { connectionId: connection.id, sql: `DROP VIEW IF EXISTS ${view}` },
          HUMAN,
        );
        await app.commands.dispatch(
          'query.execute',
          { connectionId: connection.id, sql: `DROP TABLE IF EXISTS ${table}` },
          HUMAN,
        );
        await app.connections.shutdown();
      }
    }, 30000);
  }
});
