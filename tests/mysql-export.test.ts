import { it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { mysqlSqlExport, mysqlViewOrder } from '../src/main/database/adapters/mysql/sql-export';
import { MysqlAdapter } from '../src/main/database/adapters/mysql/mysql-adapter';
import { splitSqlScript } from '../src/main/database/sql-script-parser';
import { connectionSchema } from '../src/shared/schemas';
import type { Connection } from '../src/shared/types';
import { mysqlViewDependencies } from '../src/main/database/adapters/mysql/view-dependencies';

it('orders native view references without treating quoted text as dependencies', () => {
  expect([
    ...mysqlViewDependencies(
      'SELECT (a),a,b,EXTRACT(YEAR FROM d) FROM source, second JOIN third ON third.id=source.id WHERE EXISTS(SELECT 1 FROM nested)',
      'db',
    ),
  ]).toEqual(['source', 'second', 'third', 'nested']);
  expect([
    ...mysqlViewDependencies(
      'WITH a AS(SELECT * FROM a), b AS(SELECT * FROM a JOIN underlying ON 1=1) SELECT * FROM a,b',
      'db',
    ),
  ]).toEqual(['a', 'underlying']);
  expect([
    ...mysqlViewDependencies(
      'WITH RECURSIVE a AS(SELECT * FROM seed UNION ALL SELECT * FROM a) SELECT * FROM a',
      'db',
    ),
  ]).toEqual(['seed']);
  expect([
    ...mysqlViewDependencies(
      'SELECT * FROM external.v JOIN (local_a JOIN local_b ON 1=1) ON 1=1',
      'db',
    ),
  ]).toEqual(['local_a', 'local_b']);
  const v = (name: string, body: string) => ({
    kind: 'VIEW',
    name,
    sql: 'CREATE VIEW `db`.' + '`' + name + '` AS ' + body,
    mode: '',
    collation: 'utf8mb4_general_ci',
  });
  expect(
    mysqlViewOrder(
      [v('outer', 'SELECT * FROM `db`.`inner`'), v('inner', "SELECT 'db.outer' AS val")],
      'db',
    ).map((v) => v.name),
  ).toEqual(['inner', 'outer']);
  expect(() =>
    mysqlViewOrder([v('a', 'SELECT * FROM `db`.`b`'), v('b', 'SELECT * FROM `db`.`a`')], 'db'),
  ).toThrow('Cyclic');
});

for (const port of [13306, 13307])
  it.skipIf(process.env.DB_INTEGRATION !== '1')(
    `MySQL SQL export round trip and snapshot (${port})`,
    async () => {
      const name = 'dw_export_' + randomUUID().replaceAll('-', '').slice(0, 12);
      const connection = {
        ...connectionSchema.parse({
          name: 'export',
          engine: 'mysql',
          host: '127.0.0.1',
          port,
          username: 'root',
          database: name,
          charset: 'latin1',
        }),
        id: randomUUID(),
      } as Connection;
      const password = process.env.DB_TEST_PASSWORD;
      const admin = await mysql.createConnection({
        host: connection.host,
        port,
        user: 'root',
        password,
        charset: 'utf8mb4',
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
      let adapter: MysqlAdapter | undefined;
      const exec = async (sql: string) => {
        await admin.query(sql);
      };
      const dump = async (data: boolean, onWrite?: (chunk: string) => Promise<void>) => {
        let sql = '';
        await mysqlSqlExport(connection, password, {
          includeData: data,
          signal: new AbortController().signal,
          timeout: 15000,
          write: async (chunk) => {
            sql += chunk;
            await onWrite?.(chunk);
          },
          progress: () => {},
        });
        return sql;
      };
      const importSql = async (sql: string) => {
        await adapter?.disconnect();
        adapter = new MysqlAdapter(connection, password);
        await adapter.withScriptSession(async (execute) => {
          for (const unit of splitSqlScript(sql, 'mysql'))
            await execute(unit.sql, new AbortController().signal, 15000);
        });
      };
      try {
        await exec(
          'CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
        );
        await exec('USE `' + name + '`');
        await exec("SET time_zone='+00:00'");
        await exec("SET sql_mode='NO_AUTO_VALUE_ON_ZERO'");
        await exec(
          "CREATE TABLE parent(id INT PRIMARY KEY AUTO_INCREMENT,label VARCHAR(30) COMMENT 'comment', UNIQUE(label)) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        );
        await exec("INSERT INTO parent VALUES(0,'zero'),(1,'one'),(900,'deleted')");
        await exec('DELETE FROM parent WHERE id=900');
        await exec(
          "CREATE TABLE precise(id INT PRIMARY KEY, n DECIMAL(65,25), large BIGINT UNSIGNED, f FLOAT,d DOUBLE,txt VARCHAR(100),latin VARCHAR(30) CHARACTER SET latin1, bin LONGBLOB, bits BIT(12), e ENUM('a','b'), s SET('x','y'), stamp TIMESTAMP(6), dt DATETIME(6), tm TIME(6), day DATE,j JSON,g POINT,computed INT GENERATED ALWAYS AS (id*2) STORED, v INT GENERATED ALWAYS AS (id+1) VIRTUAL,parent_id INT, CONSTRAINT fk_parent FOREIGN KEY(parent_id) REFERENCES parent(id)) ENGINE=InnoDB",
        );
        await admin.query(
          "INSERT INTO precise(id,n,large,f,d,txt,latin,bin,bits,e,s,stamp,dt,tm,day,j,g,parent_id) VALUES(1,1234567890123456789012345678901234567890.1234567890123456789012345,18446744073709551615,1.23456789,1.2345678901234567,?, ?,X'00FFDEAD',b'101010111100',2,3,'2025-10-31 12:34:56.123456','2020-01-02 03:04:05.678901','-123:45:56.123456','0000-00-00','{\"hello\":\"世界\"}',ST_GeomFromText('POINT(1 2)',4326),1)",
          ["中😀\0文\\quote'", 'café'],
        );
        await exec('INSERT INTO precise(id,parent_id) VALUES(2,NULL)');
        await exec("CREATE INDEX txt_idx ON precise(txt(10)) COMMENT 'index comment'");
        await exec('CREATE VIEW z_inner AS SELECT id,txt FROM precise');
        await exec(
          'CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW a_outer AS SELECT * FROM z_inner',
        );
        await exec('CREATE TABLE audit_log(value VARCHAR(100)) ENGINE=InnoDB');
        await exec("CREATE TABLE `quote'table` (`欄名` VARCHAR(20)) ENGINE=InnoDB");
        await exec("INSERT INTO `quote'table` VALUES('引號')");
        if (port === 13307) {
          await exec('CREATE TABLE network_types(id UUID, v4 INET4, v6 INET6) ENGINE=InnoDB');
          await exec(
            "INSERT INTO network_types VALUES('12345678-9abc-4ef0-8234-56789abcdef0','192.0.2.1','2001:db8::1')",
          );
          expect(
            (await admin.query('SELECT CAST(id AS CHAR) AS id FROM network_types'))[0],
          ).toEqual([{ id: '12345678-9abc-4ef0-8234-56789abcdef0' }]);
        }
        await exec(
          'CREATE VIEW cte_view AS WITH z_inner AS(SELECT id,txt FROM precise) SELECT * FROM z_inner',
        );
        await exec(
          "CREATE TRIGGER t_first AFTER INSERT ON precise FOR EACH ROW BEGIN INSERT INTO audit_log VALUES('first;值'); END",
        );
        await exec(
          "CREATE TRIGGER t_second AFTER INSERT ON precise FOR EACH ROW FOLLOWS t_first BEGIN INSERT INTO audit_log VALUES('second'); END",
        );
        await exec('CREATE FUNCTION add_one(x INT) RETURNS INT DETERMINISTIC RETURN x+1');
        await exec("CREATE PROCEDURE greet() BEGIN SELECT 'hello;world' AS text_value; END");
        await exec("SET collation_connection='latin1_swedish_ci'");
        await exec(
          "CREATE VIEW language_view AS SELECT 'café' AS value,COLLATION('café') AS collation_name",
        );
        const [languageBefore] = await admin.query('SELECT * FROM language_view');
        await exec('SET NAMES utf8mb4');
        const exact =
          "SELECT id,CAST(n AS CHAR) AS n,CAST(large AS CHAR) AS large,CAST(f+0e0 AS CHAR) AS f,CAST(d AS CHAR) AS d,HEX(txt) AS txt,HEX(latin) AS latin,HEX(bin) AS bin,HEX(bits) AS bits,e+0 AS e,s+0 AS s,CAST(stamp AS CHAR) AS stamp,CAST(dt AS CHAR) AS dt,CAST(tm AS CHAR) AS tm,CAST(day AS CHAR) AS day,JSON_EXTRACT(j,'$.hello') AS j,HEX(ST_AsWKB(g)) AS g,ST_SRID(g) AS srid,computed,v,parent_id FROM precise ORDER BY id";
        const [before] = await admin.query(exact);
        let changed = false;
        const sql = await dump(true, async () => {
          if (!changed) {
            changed = true;
            await exec("UPDATE precise SET txt='changed' WHERE id=1");
            await exec("INSERT INTO parent(label) VALUES('after snapshot')");
          }
        });
        expect(sql.indexOf('VIEW `z_inner`')).toBeLessThan(sql.indexOf('VIEW `a_outer`'));
        await exec('DROP DATABASE `' + name + '`');
        await exec(
          'CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
        );
        await exec('USE `' + name + '`');
        await importSql(sql);
        const [after] = await admin.query(exact);
        expect(after).toEqual(before);
        expect((await admin.query("SELECT * FROM `quote'table`"))[0]).toEqual([{ 欄名: '引號' }]);
        if (port === 13307)
          expect(
            (
              await admin.query(
                'SELECT CAST(id AS CHAR) AS id,CAST(v4 AS CHAR) AS v4,CAST(v6 AS CHAR) AS v6 FROM network_types',
              )
            )[0],
          ).toEqual([
            { id: '12345678-9abc-4ef0-8234-56789abcdef0', v4: '192.0.2.1', v6: '2001:db8::1' },
          ]);
        expect((await admin.query('SELECT * FROM audit_log'))[0]).toEqual([]);
        expect((await admin.query('SELECT * FROM a_outer'))[0]).toHaveLength(2);
        expect((await admin.query('SELECT * FROM cte_view'))[0]).toHaveLength(2);
        expect((await admin.query('SELECT * FROM language_view'))[0]).toEqual(languageBefore);
        expect((await admin.query('SELECT add_one(2) AS n'))[0]).toEqual([{ n: 3 }]);
        expect(JSON.stringify((await admin.query('CALL greet()'))[0])).toContain('hello;world');
        await exec("INSERT INTO parent(label) VALUES('next')");
        expect((await admin.query("SELECT id FROM parent WHERE label='next'"))[0]).toEqual([
          { id: 901 },
        ]);
        await exec('INSERT INTO precise(id) VALUES(3)');
        expect((await admin.query('SELECT value FROM audit_log'))[0]).toEqual([
          { value: 'first;值' },
          { value: 'second' },
        ]);
        const schemaSql = await dump(false);
        expect(schemaSql).not.toContain('INSERT INTO `precise`');
        await adapter?.disconnect();
        adapter = undefined;
        await exec('DROP DATABASE `' + name + '`');
        await exec(
          'CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
        );
        await exec('USE `' + name + '`');
        await importSql(schemaSql);
        expect((await admin.query('SELECT * FROM precise'))[0]).toEqual([]);
        await exec('CREATE TABLE old_engine(id INT) ENGINE=MyISAM');
        await exec('INSERT INTO old_engine VALUES(123)');
        let waiting: Promise<unknown> | undefined,
          writeFinished = false;
        const lockedDump = await dump(true, async () => {
          if (!waiting) {
            waiting = admin.query('INSERT INTO old_engine VALUES(456)').then(() => {
              writeFinished = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(writeFinished).toBe(false);
          }
        });
        await waiting;
        expect(writeFinished).toBe(true);
        expect(lockedDump).toContain('INSERT INTO `old_engine`');
        expect(lockedDump).not.toContain('(456)');
        expect(await dump(false)).toContain('ENGINE=MyISAM');
        let added = false;
        await expect(
          dump(false, async () => {
            if (!added) {
              added = true;
              await exec('CREATE TABLE concurrent_new(id INT) ENGINE=InnoDB');
            }
          }),
        ).rejects.toThrow('objects changed');
        await exec('DROP TABLE concurrent_new');
        const controller = new AbortController();
        await expect(
          mysqlSqlExport(connection, password, {
            includeData: true,
            signal: controller.signal,
            timeout: 10000,
            write: async () => {
              controller.abort();
            },
            progress: () => {},
          }),
        ).rejects.toThrow('cancelled');
        await admin.query({ sql: 'INSERT INTO old_engine VALUES(789)', timeout: 2000 });
      } finally {
        await adapter?.disconnect();
        await admin.query('DROP DATABASE IF EXISTS `' + name + '`');
        await admin.end();
      }
    },
    60000,
  );
