import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { createAdapter } from '../src/main/database/factory';
import { DEFAULT_SETTINGS, type Actor, type Engine } from '../src/shared/types';

function fixture() {
  const secrets = new Map<string, string>();
  return new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore({
        ...DEFAULT_SETTINGS,
        agentLevel: 'assist',
        policy: { ...DEFAULT_SETTINGS.policy, ddl: 'ask' },
      }),
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
function dispatcher(app: Application, connectionId: string) {
  return async (name: string, args: object = {}) => {
    const result = await app.commands.dispatch(
      name,
      name === 'connection.save' ? args : { connectionId, ...args },
      HUMAN,
    );
    expect(result.success, `${name}: ${result.error}`).toBe(true);
    return result.data as any;
  };
}

it('DDL approval binds the complete creation definition', async () => {
  const app = fixture();
  try {
    const c = await app.connections.save({
      name: 'review',
      engine: 'sqlite',
      database: ':memory:',
      agentAccess: 'write',
    });
    await app.connections.connect(c.id);
    const agent: Actor = { kind: 'agent', id: 'review', name: 'Review' };
    const args = {
      connectionId: c.id,
      database: ':memory:',
      schema: 'main',
      kind: 'table',
      name: 'approved',
      columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }],
    };
    const asked = await app.commands.dispatch('object.create', args, agent);
    expect(asked.approvalId).toBeTruthy();
    expect(
      (await app.commands.resolveApproval(asked.approvalId!, true, HUMAN, 'session')).success,
    ).toBe(true);
    for (const changed of [
      { ...args, name: 'different' },
      { ...args, columns: [{ name: 'secret', type: 'text', nullable: true, primaryKey: false }] },
      {
        connectionId: c.id,
        database: ':memory:',
        schema: 'main',
        kind: 'view',
        name: 'view1',
        selectSql: 'SELECT 1 AS id',
      },
    ]) {
      const response = await app.commands.dispatch('object.create', changed, agent);
      expect(response.approvalId, JSON.stringify(response)).toBeTruthy();
    }
    const call = dispatcher(app, c.id);
    await call('query.execute', { sql: 'DROP TABLE approved' });
    expect((await app.commands.dispatch('object.create', args, agent)).success).toBe(true);
  } finally {
    await app.connections.shutdown();
  }
});

it('metadata saves preserve live editors; transport changes and deletion protect drafts and close related tabs', async () => {
  const app = fixture();
  try {
    const c = await app.connections.save({
      name: 'review',
      engine: 'sqlite',
      database: ':memory:',
    });
    const other = await app.connections.save({
      name: 'other',
      engine: 'sqlite',
      database: ':memory:',
    });
    const adapter = await app.connections.connect(c.id);
    const tab = app.workspace.open({
      connectionId: c.id,
      type: 'table',
      title: 'draft',
      sql: '',
      table: 't',
    });
    const unrelated = app.workspace.open({
      connectionId: other.id,
      type: 'query',
      title: 'other',
      sql: '',
    });
    app.workspace.update(tab.id, { dirty: true });
    const call = dispatcher(app, c.id);
    await call('connection.save', { ...c, name: 'renamed', color: '#123456', group: 'new group' });
    expect(await app.connections.connect(c.id)).toBe(adapter);
    expect(app.workspace.get().tabs.find((t) => t.id === tab.id)?.dirty).toBe(true);
    for (const [name, args] of [
      ['connection.save', { ...c, database: 'different.sqlite' }],
      ['connection.delete', { connectionId: c.id }],
    ] as const) {
      const denied = await app.commands.dispatch(name, args, HUMAN);
      expect(denied.error).toContain('Unsaved changes:');
      expect(app.connections.status(c.id).connected).toBe(true);
      expect(app.workspace.get().tabs).toHaveLength(2);
    }
    await call('connection.save', { ...c, database: 'different.sqlite', discard: true });
    expect(app.workspace.get().tabs.map((t) => t.id)).toEqual([unrelated.id]);
    await expect(app.connections.connect(c.id)).rejects.toThrow('disconnected');
    const clean = app.workspace.open({
      connectionId: c.id,
      type: 'query',
      title: 'clean',
      sql: '',
    });
    await call('connection.delete');
    expect(app.connections.list().map((item) => item.id)).toEqual([other.id]);
    expect(app.workspace.get().tabs.some((t) => t.id === clean.id)).toBe(false);
    expect(app.workspace.get().tabs.map((t) => t.id)).toEqual([unrelated.id]);
  } finally {
    await app.connections.shutdown();
  }
});

const servers: {
  engine: Engine;
  name: string;
  database: string;
  port?: number;
  username?: string;
}[] = [
  { engine: 'sqlite', name: 'SQLite', database: ':memory:' },
  { engine: 'mysql', name: 'MySQL', port: 13306, username: 'root', database: 'workspace' },
  { engine: 'mysql', name: 'MariaDB', port: 13307, username: 'root', database: 'workspace' },
  {
    engine: 'postgres',
    name: 'PostgreSQL',
    port: 15432,
    username: 'workspace',
    database: 'workspace',
  },
  { engine: 'sqlserver', name: 'SQL Server', port: 11433, username: 'sa', database: 'master' },
];
for (const server of servers)
  describe.skipIf(server.engine !== 'sqlite' && process.env.DB_INTEGRATION !== '1')(
    server.name,
    () => {
      it('inserts a row using only column defaults', async () => {
        const app = fixture();
        const table = 'review_' + randomUUID().replaceAll('-', '');
        const c = await app.connections.save({
          ...server,
          host: '127.0.0.1',
          password: process.env.DB_TEST_PASSWORD,
        });
        const call = dispatcher(app, c.id);
        try {
          await call('query.execute', {
            sql: `CREATE TABLE ${table} (id INT DEFAULT 7, label VARCHAR(20) DEFAULT 'auto')`,
          });
          await call('data.insert', { table, values: {} });
          expect((await call('data.select', { table })).rows).toEqual([
            { id: server.engine === 'sqlite' ? '7' : 7, label: 'auto' },
          ]);
          await call('query.execute', { sql: `DROP TABLE ${table}` });
          const identity = {
            sqlite: 'INTEGER PRIMARY KEY',
            mysql: 'INT PRIMARY KEY AUTO_INCREMENT',
            postgres: 'INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
            sqlserver: 'INT IDENTITY(1,1) PRIMARY KEY',
            sybase: 'INT IDENTITY PRIMARY KEY',
            redis: '',
          }[server.engine];
          await call('query.execute', { sql: `CREATE TABLE ${table} (id ${identity})` });
          await call('data.insert', { table, values: {} });
          expect((await call('data.select', { table })).rows).toEqual([
            { id: server.engine === 'sqlite' ? '1' : 1 },
          ]);
          await call('query.execute', { sql: `DROP TABLE ${table}` });
          await call('query.execute', {
            sql: `CREATE TABLE ${table} (required_value INT NOT NULL)`,
          });
          expect(
            (
              await app.commands.dispatch(
                'data.insert',
                { connectionId: c.id, table, values: {} },
                HUMAN,
              )
            ).success,
          ).toBe(false);
        } finally {
          await call('query.execute', { sql: `DROP TABLE IF EXISTS ${table}` });
          await app.connections.shutdown();
        }
      }, 30000);
    },
  );

describe.skipIf(process.env.DB_INTEGRATION !== '1')('server regressions', () => {
  for (const port of [13306, 13307])
    it(`MySQL session state cannot leak to later scoped operations (${port})`, async () => {
      const app = fixture();
      const name = 'review_' + randomUUID().replaceAll('-', '');
      const c = await app.connections.save({
        name,
        engine: 'mysql',
        host: '127.0.0.1',
        port,
        username: 'root',
        database: 'workspace',
        password: process.env.DB_TEST_PASSWORD,
      });
      const call = dispatcher(app, c.id);
      const query = (sql: string) => call('query.execute', { database: 'workspace', sql });
      try {
        await query(`CREATE DATABASE ${name}`);
        await query(`CREATE TABLE workspace.${name} (id INT)`);
        await query(`CREATE TABLE ${name}.${name} (id INT)`);
        await query(`USE ${name}`);
        expect((await query('SELECT DATABASE() AS actual')).rows[0].actual).toBe('workspace');
        await call('data.insert', { database: 'workspace', table: name, values: { id: 42 } });
        expect((await query(`SELECT * FROM workspace.${name}`)).rows).toEqual([{ id: 42 }]);
        expect((await query(`SELECT * FROM ${name}.${name}`)).rows).toEqual([]);
        await query('SET @review_variable = 123');
        expect((await query('SELECT @review_variable AS value')).rows[0].value).toBe(null);
        await query('SET autocommit = 0');
        expect((await query('SELECT @@autocommit AS value')).rows[0].value).toBe('1');
        await query('BEGIN');
        await call('data.insert', { database: 'workspace', table: name, values: { id: 43 } });
        await query('ROLLBACK');
        expect((await query(`SELECT id FROM workspace.${name} ORDER BY id`)).rows).toEqual([
          { id: 42 },
          { id: 43 },
        ]);
      } finally {
        await query(`DROP TABLE IF EXISTS workspace.${name}`);
        await query(`DROP DATABASE IF EXISTS ${name}`);
        await app.connections.shutdown();
      }
    }, 30000);

  it('SQL Server preserves DECIMAL, NUMERIC and decimal SQL_VARIANT values and parameterized updates', async () => {
    const app = fixture();
    const table = 'review_' + randomUUID().replaceAll('-', '');
    const c = await app.connections.save({
      name: table,
      engine: 'sqlserver',
      host: '127.0.0.1',
      port: 11433,
      username: 'sa',
      database: 'master',
      password: process.env.DB_TEST_PASSWORD,
    });
    const call = dispatcher(app, c.id);
    try {
      const cases = [
        ['123456789012345.123456', 21, 6],
        ['-99999999999999999999999999999999999999', 38, 0],
        ['0.12345678901234567890123456789012345678', 38, 38],
        ['0.0000', 8, 4],
        ['-1.25', 4, 2],
      ];
      for (const [value, precision, scale] of cases) {
        const sql = `SELECT CAST('${value}' AS DECIMAL(${precision},${scale})) AS d, CAST('${value}' AS NUMERIC(${precision},${scale})) AS n, CAST(CAST('${value}' AS DECIMAL(${precision},${scale})) AS SQL_VARIANT) AS v`;
        expect((await call('query.execute', { sql })).rows).toEqual([
          { d: value, n: value, v: value },
        ]);
      }
      expect(
        (await call('query.read', { sql: 'SELECT CAST(NULL AS DECIMAL(38,6)) AS d' })).rows,
      ).toEqual([{ d: null }]);
      await call('query.execute', {
        sql: `CREATE TABLE ${table} (id DECIMAL(21,6) PRIMARY KEY, label VARCHAR(20))`,
      });
      const id = '123456789012345.123456';
      await call('data.insert', { table, values: { id, label: 'first' } });
      expect((await call('data.select', { table })).rows).toEqual([{ id, label: 'first' }]);
      await call('data.update', {
        table,
        values: { label: 'updated' },
        filters: [{ column: 'id', operator: '=', value: id }],
      });
      expect((await call('data.select', { table })).rows).toEqual([{ id, label: 'updated' }]);
    } finally {
      await call('query.execute', { sql: `DROP TABLE IF EXISTS ${table}` });
      await app.connections.shutdown();
    }
  }, 30000);
});
