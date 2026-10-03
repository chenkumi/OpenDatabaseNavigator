import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createAdapter } from '../src/main/database/factory';
import { DEFAULT_SETTINGS, type Actor, type Connection, type Engine } from '../src/shared/types';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { describeStructure } from '../src/main/application/services/table-structure-service';
import { listDatabaseObjects } from '../src/main/application/services/database-metadata';

const run = { limit: 100, timeout: 20_000, readOnly: false } as const;
const run_ = run;
const unique = () => 'dw_' + randomUUID().replaceAll('-', '').slice(0, 20);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('SQLite rejects duplicate result column names instead of overwriting values', async () => {
  const adapter = createAdapter(
    { engine: 'sqlite', database: ':memory:' } as Connection,
    undefined,
  );
  try {
    await expect(adapter.query('SELECT 1 AS id, 2 AS id', [], run)).rejects.toThrow(
      'duplicate column name "id"',
    );
    const ok = await adapter.query('SELECT 1 AS id, 2 AS other', [], run);
    expect(ok.rows).toEqual([{ id: '1', other: '2' }]);
  } finally {
    await adapter.disconnect();
  }
});

const servers: {
  name: string;
  engine: Engine;
  port: number;
  username: string;
  database: string;
}[] = [
  {
    name: 'PostgreSQL',
    engine: 'postgres',
    port: 15432,
    username: 'workspace',
    database: 'workspace',
  },
  { name: 'MySQL', engine: 'mysql', port: 13306, username: 'root', database: 'workspace' },
  { name: 'MariaDB', engine: 'mysql', port: 13307, username: 'root', database: 'workspace' },
  { name: 'SQL Server', engine: 'sqlserver', port: 11433, username: 'sa', database: 'master' },
];
describe.skipIf(process.env.DB_INTEGRATION !== '1')('adapter fixes on real databases', () => {
  for (const server of servers) {
    it(`${server.name}: duplicate columns, session isolation and server-side cancellation`, async () => {
      const { name, ...rest } = server;
      const adapter = createAdapter(
        { id: name, name, host: '127.0.0.1', tls: false, ...rest } as unknown as Connection,
        process.env.DB_TEST_PASSWORD,
      );
      const table = unique();
      const q = (sql: string, options: { timeout?: number } = {}) =>
        adapter.query(sql, [], { ...run, ...options });
      try {
        if (server.engine !== 'sqlserver')
          await expect(q('SELECT 1 AS id, 2 AS id')).rejects.toThrow('duplicate column name "id"');

        if (server.engine === 'postgres') {
          const dates = await q(
            "SELECT DATE '2024-01-01' AS d, TIMESTAMP '2024-01-01 10:20:30' AS t",
          );
          expect(dates.rows[0]).toEqual({ d: '2024-01-01', t: '2024-01-01 10:20:30' });
          const before = (await q('SHOW search_path')).rows[0];
          await q('SET search_path = pg_catalog');
          await q('BEGIN');
          for (let i = 0; i < 6; i++) expect((await q('SHOW search_path')).rows[0]).toEqual(before);
          expect((await q('SELECT txid_current_if_assigned() IS NULL AS clean')).rows[0]).toEqual({
            clean: true,
          });
        }
        if (server.engine === 'sqlserver') {
          // tedious resets pooled sessions (sp_reset_connection); guard that it stays so.
          await q('SET DATEFIRST 3');
          for (let i = 0; i < 6; i++)
            expect(Number((await q('SELECT @@DATEFIRST AS first')).rows[0].first)).toBe(7);
        }

        if (server.engine === 'postgres') {
          await q(`CREATE TABLE ${table} (x int)`);
          await expect(
            q(`INSERT INTO ${table} SELECT 1 FROM (SELECT pg_sleep(4)) s`, { timeout: 500 }),
          ).rejects.toThrow('timed out');
          await sleep(5_000);
          const count = await q(`SELECT COUNT(*) AS n FROM ${table}`);
          expect(Number(count.rows[0].n)).toBe(0);
        }
        if (server.engine === 'mysql') {
          // KILL QUERY makes SLEEP() return 1 rather than fail, so assert the
          // statement is gone from the server instead of checking its side effect.
          const marker = unique();
          await expect(q(`SELECT SLEEP(30) AS ${marker}`, { timeout: 500 })).rejects.toThrow(
            'timed out',
          );
          await sleep(1_000);
          const alive = await q(
            `SELECT COUNT(*) AS n FROM information_schema.processlist WHERE info LIKE '%AS ${marker}%' AND id <> CONNECTION_ID()`,
          );
          expect(Number(alive.rows[0].n)).toBe(0);
        }
      } finally {
        if (server.engine !== 'sqlserver') await q(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
        await adapter.disconnect();
      }
    }, 60_000);
    it(`${server.name}: index metadata is narrowed on the server`, async () => {
      const { name, ...rest } = server;
      const connection = {
        id: name,
        name,
        host: '127.0.0.1',
        tls: false,
        ...rest,
      } as unknown as Connection;
      const adapter = createAdapter(connection, process.env.DB_TEST_PASSWORD);
      const table = unique();
      const schema =
        server.engine === 'postgres'
          ? 'public'
          : server.engine === 'sqlserver'
            ? 'dbo'
            : server.database;
      const run = (sql: string) => adapter.query(sql, [], run_);
      try {
        await run(`CREATE TABLE ${table} (x int)`);
        await run(`CREATE INDEX idx_${table} ON ${table} (x)`);
        const found = await listDatabaseObjects(adapter, connection, 'index', {
          schema,
          table,
          name: `IDX_${table}`.toUpperCase(),
        });
        expect(found.map((item) => item.name.toLowerCase())).toEqual([`idx_${table}`]);
        const none = await listDatabaseObjects(adapter, connection, 'index', {
          schema,
          table: 'no_such_table',
        });
        expect(none).toEqual([]);
      } finally {
        await run(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
        await adapter.disconnect();
      }
    }, 60_000);
    it(`${server.name}: a verified read in a writable session stops at the limit`, async () => {
      const { name, ...rest } = server;
      const adapter = createAdapter(
        { id: name, name, host: '127.0.0.1', tls: false, ...rest } as unknown as Connection,
        process.env.DB_TEST_PASSWORD,
      );
      const sql =
        server.engine === 'postgres'
          ? 'SELECT a.oid AS n FROM pg_class a, pg_class b, pg_class c'
          : server.engine === 'mysql'
            ? 'SELECT a.CHARACTER_SET_NAME AS n FROM information_schema.CHARACTER_SETS a, information_schema.COLLATIONS b, information_schema.COLLATIONS c'
            : 'SELECT a.object_id AS n FROM sys.all_objects a, sys.all_objects b';
      try {
        const result = await adapter.query(sql, [], {
          limit: 10,
          timeout: 15_000,
          readOnly: false,
          truncate: true,
        });
        expect(result.rows).toHaveLength(10);
        expect(result.hasMore).toBe(true);
      } finally {
        await adapter.disconnect();
      }
    }, 40_000);
  }
});

describe.skipIf(process.env.DB_INTEGRATION !== '1')('Redis SET type guard', () => {
  it('stops an agent from replacing another type with SET but lets the user and strings through', async () => {
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
    try {
      const connection = await app.connections.save({
        name: 'Redis set guard',
        engine: 'redis',
        host: '127.0.0.1',
        port: 16379,
        database: '0',
        agentAccess: 'write',
      });
      const key = 'dw:setguard:' + unique();
      const ref = { connectionId: connection.id, database: '12', key };
      const as =
        (actor: Actor) =>
        (name: string, args: object = {}) =>
          app.commands.dispatch(name, { ...ref, ...args }, actor);
      const human = as(HUMAN);
      const agent = as({ kind: 'agent', id: 'set-guard', name: 'Set guard' });
      const policy = app.getSettings();
      policy.agentLevel = 'execute';
      policy.policy.update = 'allow';
      await app.commands.dispatch('settings.save', policy, HUMAN);

      expect((await agent('redis.set', { value: 'one' })).success).toBe(true);
      expect((await agent('redis.set', { value: 'two' })).success).toBe(true);
      expect((await human('redis.delete')).success).toBe(true);
      expect((await human('redis.hset', { field: 'f', value: 'v' })).success).toBe(true);
      // An agent holding only update rights cannot replace a hash through SET...
      expect((await agent('redis.set', { value: 'replace' })).success).toBe(false);
      expect(JSON.stringify((await human('redis.get', {})).data)).toContain('"f"');
      // ...while the desktop user may overwrite deliberately.
      expect((await human('redis.set', { value: 'replace' })).success).toBe(true);
      await human('redis.delete');
    } finally {
      await app.connections.shutdown();
    }
  }, 30_000);
});

describe.skipIf(process.env.DB_INTEGRATION !== '1')('PostgreSQL constraint fidelity', () => {
  it('keeps NO INHERIT checks read-only but leaves ordinary checks and foreign keys editable', async () => {
    const connection = {
      id: 'pg',
      name: 'pg',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15432,
      username: 'workspace',
      database: 'workspace',
      tls: false,
    } as unknown as Connection;
    const adapter = createAdapter(connection, process.env.DB_TEST_PASSWORD);
    const parent = unique();
    const child = unique();
    const q = (sql: string) => adapter.query(sql, [], run_);
    try {
      await q(`CREATE TABLE ${parent} (id int primary key)`);
      await q(
        `CREATE TABLE ${child} (a int, CONSTRAINT fk_${child} FOREIGN KEY (a) REFERENCES ${parent}(id), CONSTRAINT ck_${child} CHECK (a > 0), CONSTRAINT ni_${child} CHECK (a < 100) NO INHERIT)`,
      );
      const detail = await describeStructure(adapter, connection, {
        schema: 'public',
        table: child,
      } as never);
      const byName = (name: string) =>
        detail.constraints!.find((item) => item.definition.name === `${name}_${child}`)!;
      expect(byName('fk').readOnlyReason).toBeUndefined();
      expect(byName('ck').readOnlyReason).toBeUndefined();
      expect(byName('ni').readOnlyReason).toContain('NO INHERIT');
    } finally {
      await q(`DROP TABLE IF EXISTS ${child}`).catch(() => {});
      await q(`DROP TABLE IF EXISTS ${parent}`).catch(() => {});
      await adapter.disconnect();
    }
  }, 30_000);
});
