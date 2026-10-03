import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splitSqlScript } from '../src/main/database/sql-script-parser';
import { readSqlFile } from '../src/main/application/services/sql-file';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS, type Engine } from '../src/shared/types';
import type { ScriptProgress } from '../src/shared/sql-script';
import { createAdapter } from '../src/main/database/factory';

it('preserves CRLF inside literals while recognizing Windows script delimiters', () => {
  for (const engine of ['sqlite', 'mysql', 'postgres', 'sqlserver', 'sybase'] as const) {
    expect(splitSqlScript("SELECT 'first\r\nsecond';\r\nSELECT 2;", engine)[0].sql).toContain(
      "'first\r\nsecond'",
    );
  }
  expect(splitSqlScript('SELECT $$a\r\nb$$;\r\nSELECT 2;', 'postgres')[0].sql).toContain(
    '$$a\r\nb$$',
  );
  expect(
    splitSqlScript('SELECT 1;\r\nGO\r\nSELECT 2;\r\nGO', 'sqlserver').map((v) => v.line),
  ).toEqual([1, 3]);
  expect(
    splitSqlScript('DELIMITER $$\r\nSELECT 1$$\r\nDELIMITER ;\r\nSELECT 2;', 'mysql').map(
      (v) => v.line,
    ),
  ).toEqual([2, 4]);
});

it('splits native delimiters without splitting quoted/commented SQL or trigger bodies', () => {
  expect(splitSqlScript('CREATE TABLE t (\nsource text,\ndelimiter int\n);', 'mysql')).toHaveLength(
    1,
  );
  expect(splitSqlScript('SELECT foo$tag$ FROM t; SELECT 2;', 'postgres')).toHaveLength(2);
  expect(
    splitSqlScript(
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET end=1; UPDATE t SET begin=2; END; SELECT 1;',
      'sqlite',
    ),
  ).toHaveLength(2);
  expect(
    splitSqlScript("-- start\nSELECT ';'; /* ; */ SELECT $$a;\nGO\nb$$;", 'postgres').map(
      (v) => v.line,
    ),
  ).toEqual([2, 2]);
  expect(splitSqlScript("SELECT E'a\\\';b';SELECT 2;", 'postgres')).toHaveLength(2);
  expect(
    splitSqlScript(
      'CREATE FUNCTION f() RETURNS int LANGUAGE SQL BEGIN ATOMIC SELECT CASE WHEN true THEN 1 ELSE 2 END; END; SELECT 2;',
      'postgres',
    ),
  ).toHaveLength(2);
  expect(
    splitSqlScript(
      "SELECT 'GO\nx';\nGO\nDECLARE @x int=1; SELECT @x;\nGO 2 -- repeat\n",
      'sqlserver',
    ),
  ).toHaveLength(3);
  expect(
    splitSqlScript(
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES(CASE WHEN 1 THEN ';' END); UPDATE t SET a=1; END; SELECT 2;",
      'sqlite',
    ),
  ).toHaveLength(2);
  expect(
    splitSqlScript(
      "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT ';'; END$$\nDELIMITER ;\nCALL p();",
      'mysql',
    ),
  ).toHaveLength(2);
  expect(
    splitSqlScript(
      "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_BACKSLASH_ESCAPES' */; SELECT 'a\\'; SET SQL_MODE=@OLD_SQL_MODE; SELECT 'a\\\';b';",
      'mysql',
    ),
  ).toHaveLength(4);
  expect(
    splitSqlScript("SET @text = 'SQL_MODE=''NO_BACKSLASH_ESCAPES'''; SELECT 'a\\\';b';", 'mysql'),
  ).toHaveLength(2);
  expect(
    splitSqlScript('SET sql_mode=\'ANSI_QUOTES\'; SELECT "a\\"; SELECT 2;', 'mysql'),
  ).toHaveLength(3);
});
it('rejects malformed files, unsupported client commands and ambiguous lexical modes before execution', () => {
  for (const sql of [
    "SELECT 'unfinished",
    'SELECT $$unfinished',
    '/* comment',
    '\\i /tmp/secret',
    '-- hi\nCOPY t FROM STDIN;\n1\n\\.',
    'SET standard_conforming_strings=off;',
  ])
    expect(() => splitSqlScript(sql, 'postgres')).toThrow();
  expect(() => splitSqlScript('SELECT 1\nGO 1001', 'sqlserver')).toThrow('GO count');
  expect(() => splitSqlScript("SET SQL_MODE=CONCAT(@@SQL_MODE,',ANSI_QUOTES');", 'mysql')).toThrow(
    'dynamic mode',
  );
  expect(() => splitSqlScript('SELECT 1\nDELIMITER $$', 'mysql')).toThrow('completed');
  expect(() => splitSqlScript('-- only a comment', 'sqlite')).toThrow('no statements');
});
it('reads BOM encodings and rejects malformed or oversized files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dw-script-file-'));
  try {
    const file = join(dir, 'test.sql');
    await writeFile(file, Buffer.from("\ufeffSELECT '中文';", 'utf16le'));
    expect((await readSqlFile(file)).sql).toBe("SELECT '中文';");
    await writeFile(file, Buffer.from([0xc0, 0xaf]));
    await expect(readSqlFile(file)).rejects.toThrow('UTF-8');
    await writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(readSqlFile(file)).rejects.toThrow('16 MiB');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
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
      set: (id, v) => {
        secrets.set(id, v);
      },
      delete: (id) => {
        secrets.delete(id);
      },
    },
    createAdapter,
  );
}
export async function finish(app: Application, id: string) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const progress = app.scripts.status(id, HUMAN);
    if (progress.state !== 'running') return progress;
    await new Promise((r) => setTimeout(r, 20));
  }
  app.scripts.cancel(id, HUMAN);
  throw new Error('SQL file did not finish within 40 seconds.');
}
for (const config of [
  { engine: 'sqlite' as const, port: undefined, username: undefined, database: '' },
  { engine: 'postgres' as const, port: 15432, username: 'workspace', database: 'workspace' },
  { engine: 'mysql' as const, port: 13306, username: 'root', database: 'workspace' },
  { engine: 'mysql' as const, port: 13307, username: 'root', database: 'workspace' },
  { engine: 'sqlserver' as const, port: 11433, username: 'sa', database: 'master' },
])
  it.skipIf(config.engine !== 'sqlite' && process.env.DB_INTEGRATION !== '1')(
    `SQL file sessions: ${config.engine}:${config.port ?? 'file'}`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dw-script-')),
        app = fixture(),
        name = 'dw_script_' + randomUUID().replaceAll('-', '').slice(0, 12);
      const connection = await app.connections.save({
        ...config,
        database: config.engine === 'sqlite' ? join(dir, 'test.db') : config.database,
        name: 'script',
        host: '127.0.0.1',
        password: process.env.DB_TEST_PASSWORD,
        agentAccess: 'write',
      });
      const base = {
        connectionId: connection.id,
        database: connection.database,
        fileName: 'fixture.sql',
      };
      const execute = async (sql: string, continueOnError = false): Promise<ScriptProgress> => {
        const preview = await app.scripts.preview({ ...base, sql });
        const id = randomUUID(),
          result = await app.commands.dispatch(
            'script.execute',
            { ...base, sql, id, continueOnError, mysqlSqlMode: preview.mysqlSqlMode },
            HUMAN,
          );
        expect(result.success, result.error).toBe(true);
        return finish(app, id);
      };
      let adapter = await app.connections.connect(connection.id);
      const query = (sql: string) =>
        adapter.query(sql, [], { limit: 100, timeout: 10000, readOnly: false });
      try {
        const suffix = config.engine === 'sqlserver' ? '\nGO\n' : ';\n';
        let sql = `CREATE TABLE ${name} (id int PRIMARY KEY, label varchar(80))${suffix}`;
        sql +=
          (config.engine === 'sqlite'
            ? 'BEGIN'
            : config.engine === 'postgres'
              ? 'BEGIN'
              : config.engine === 'mysql'
                ? 'START TRANSACTION'
                : 'BEGIN TRANSACTION') + suffix;
        sql += `INSERT INTO ${name} VALUES (1, 'first;value')${suffix}INSERT INTO ${name} VALUES (2, 'second')${suffix}COMMIT${suffix}`;
        sql += `CREATE ${config.engine === 'sqlserver' ? 'TABLE #temp_script' : 'TEMPORARY TABLE temp_script'} (id int)${suffix}`;
        if (config.engine === 'sqlserver')
          sql += `DECLARE @id int=3; INSERT INTO #temp_script VALUES(@id);\nGO\nINSERT INTO ${name} SELECT id, 'temp' FROM #temp_script;\nGO\n`;
        else
          sql += `INSERT INTO temp_script VALUES(3)${suffix}INSERT INTO ${name} SELECT id, 'temp' FROM temp_script${suffix}`;
        expect((await execute(sql)).state).toBe('completed');
        expect(
          (await query(`SELECT id FROM ${name} ORDER BY id`)).rows.map((r) => Number(r.id)),
        ).toEqual([1, 2, 3]);
        const failed = await execute(
          `INSERT INTO ${name} VALUES(4,'four')${suffix}INSERT INTO ${name} VALUES(4,'duplicate')${suffix}INSERT INTO ${name} VALUES(5,'five')${suffix}`,
        );
        expect(failed.state).toBe('failed');
        expect(failed.completed).toBe(2);
        const continued = await execute(
          `INSERT INTO ${name} VALUES(4,'duplicate')${suffix}INSERT INTO ${name} VALUES(6,'six')${suffix}`,
          true,
        );
        expect(continued.failed).toBe(1);
        expect(continued.completed).toBe(2);
        const rows = (await query(`SELECT id FROM ${name} ORDER BY id`)).rows.map((r) =>
          Number(r.id),
        );
        expect(rows).toEqual([1, 2, 3, 4, 6]);
        const begin =
          config.engine === 'mysql'
            ? 'START TRANSACTION'
            : config.engine === 'sqlserver'
              ? 'BEGIN TRANSACTION'
              : 'BEGIN';
        await execute(
          `${begin}${suffix}INSERT INTO ${name} VALUES(99,'rollback on close')${suffix}`,
        );
        expect((await query(`SELECT id FROM ${name} WHERE id=99`)).rows).toHaveLength(0);
        const body =
          config.engine === 'mysql'
            ? `DELIMITER $$\nCREATE PROCEDURE ${name}_p() BEGIN INSERT INTO ${name} VALUES(8, 'body;value'); END$$\nDELIMITER ;\nCALL ${name}_p(); DROP PROCEDURE ${name}_p;`
            : config.engine === 'postgres'
              ? `DO $body$ BEGIN INSERT INTO ${name} VALUES(8, 'body;value'); END $body$;`
              : config.engine === 'sqlite'
                ? `CREATE TRIGGER ${name}_tr AFTER INSERT ON ${name} WHEN NEW.id=8 BEGIN UPDATE ${name} SET label=CASE WHEN id=8 THEN 'body;value' ELSE label END; END; INSERT INTO ${name} VALUES(8,'trigger'); DROP TRIGGER ${name}_tr;`
                : `CREATE TRIGGER ${name}_tr ON ${name} AFTER INSERT AS BEGIN UPDATE ${name} SET label='body;value' WHERE id=8; END\nGO\nINSERT INTO ${name} VALUES(8,'trigger');\nGO\nDROP TRIGGER ${name}_tr;\nGO\n`;
        const bodyResult = await execute(body);
        expect(bodyResult.state, JSON.stringify(bodyResult)).toBe('completed');
        expect((await query(`SELECT label FROM ${name} WHERE id=8`)).rows[0].label).toBe(
          'body;value',
        );
        const long =
          config.engine === 'mysql'
            ? 'SELECT SLEEP(10)'
            : config.engine === 'postgres'
              ? 'SELECT pg_sleep(10)'
              : config.engine === 'sqlserver'
                ? "WAITFOR DELAY '00:00:10'"
                : `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n`;
        const cancelSql = `INSERT INTO ${name} VALUES(20,'before cancel')${suffix}${long}${suffix}INSERT INTO ${name} VALUES(21,'after cancel')${suffix}`;
        const plan = await app.scripts.preview({ ...base, sql: cancelSql });
        const cancelId = randomUUID();
        const cancelRun = await app.commands.dispatch(
          'script.execute',
          { ...base, sql: cancelSql, mysqlSqlMode: plan.mysqlSqlMode, id: cancelId },
          HUMAN,
        );
        expect(cancelRun.success, cancelRun.error).toBe(true);
        const cancelDeadline = Date.now() + 5000;
        while (app.scripts.status(cancelId, HUMAN).completed < 1 && Date.now() < cancelDeadline)
          await new Promise((r) => setTimeout(r, 20));
        expect(() =>
          app.scripts.cancel(cancelId, { kind: 'agent', id: HUMAN.id, name: 'other' }),
        ).toThrow('not found');
        const cancelStarted = Date.now();
        app.scripts.cancel(cancelId, HUMAN);
        expect((await finish(app, cancelId)).state).toBe('cancelled');
        expect(Date.now() - cancelStarted).toBeLessThan(3000);
        expect(
          (await query(`SELECT id FROM ${name} WHERE id>=20 ORDER BY id`)).rows.map((r) =>
            Number(r.id),
          ),
        ).toEqual([20]);
        const disconnectId = randomUUID();
        const running = await app.commands.dispatch(
          'script.execute',
          { ...base, sql: long, mysqlSqlMode: plan.mysqlSqlMode, id: disconnectId },
          HUMAN,
        );
        expect(running.success, running.error).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 40));
        const disconnected = await app.commands.dispatch(
          'connection.disconnect',
          { connectionId: connection.id, discard: true },
          HUMAN,
        );
        expect(disconnected.success, disconnected.error).toBe(true);
        expect((await finish(app, disconnectId)).state).toBe('cancelled');
        await expect(app.connections.connect(connection.id)).rejects.toThrow('disconnected');
        adapter = await app.connections.connect(connection.id, undefined, true);
        // The file must not downgrade a denied write policy to its overall destructive approval.
        const actor = { kind: 'agent' as const, id: 'script-agent', name: 'Script agent' };
        const settings = await app.commands.dispatch(
          'settings.save',
          {
            ...app.getSettings(),
            agentLevel: 'execute',
            policy: {
              ...app.getSettings().policy,
              destructive: 'ask',
              insert: 'allow',
              ddl: 'deny',
            },
          },
          HUMAN,
        );
        expect(settings.success, settings.error).toBe(true);
        const denied = await app.commands.dispatch(
          'script.execute',
          {
            ...base,
            sql: `CREATE TABLE ${name}_blocked(id int)`,
            id: randomUUID(),
            mysqlSqlMode: config.engine === 'mysql' ? '' : undefined,
          },
          actor,
        );
        expect(denied.success).toBe(false);
        expect(denied.approvalId).toBeUndefined();
        const pending = await app.commands.dispatch(
          'script.execute',
          {
            ...base,
            sql: `INSERT INTO ${name} VALUES(7,'approved')`,
            id: randomUUID(),
            mysqlSqlMode: config.engine === 'mysql' ? '' : undefined,
          },
          actor,
        );
        expect(pending.approvalId).toBeTruthy();
        const approved = await app.commands.resolveApproval(pending.approvalId!, true, HUMAN);
        expect(approved.success, approved.error).toBe(true);
        expect((await finish(app, (approved.data as ScriptProgress).id)).state).toBe('completed');
      } finally {
        app.scripts.cancelAll();
        if (config.engine === 'mysql')
          await query(`DROP PROCEDURE IF EXISTS ${name}_p`).catch(() => {});
        await query(`DROP TABLE ${name}`).catch(() => {});
        await app.connections.shutdown();
        await rm(dir, { recursive: true, force: true });
      }
    },
    90000,
  );
