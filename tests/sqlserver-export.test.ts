import { it, expect } from 'vitest';
import mssql from 'mssql';
import { randomUUID } from 'node:crypto';
import {
  sqlServerSqlExport,
  findSqlServerPowerShell,
  sqlServerExportRelayTarget,
} from '../src/main/database/adapters/sqlserver/sql-export';
import {
  SqlServerAdapter,
  windowsConnectionString,
} from '../src/main/database/adapters/sqlserver/sqlserver-adapter';
import { connectionSchema } from '../src/shared/schemas';
import { splitSqlScript } from '../src/main/database/sql-script-parser';
import type { Connection } from '../src/shared/types';

it('rejects arbitrary native export executables and relative paths', async () => {
  await expect(findSqlServerPowerShell('powershell.exe')).rejects.toThrow('absolute path');
  await expect(findSqlServerPowerShell('C:\\Windows\\notepad.exe')).rejects.toThrow(
    'absolute path',
  );
  expect(
    connectionSchema.safeParse({
      name: 'wrong engine',
      engine: 'mysql',
      sqlServerPowerShellPath: 'C:\\powershell.exe',
    }).success,
  ).toBe(false);
});

it('requires an explicit TCP endpoint for native SQL Server export deadlines', () => {
  const connection = {
    ...connectionSchema.parse({
      engine: 'sqlserver',
      name: 'deadline',
      host: 'tcp:database.example',
      readTimeout: 200,
    }),
    id: 'deadline',
  };
  expect(sqlServerExportRelayTarget(connection)).toMatchObject({
    host: 'database.example',
    port: 1433,
  });
  for (const host of ['server\\instance', 'lpc:localhost', 'np:pipe', 'server,1444', 'bad\0host'])
    expect(() => sqlServerExportRelayTarget({ ...connection, host })).toThrow('TCP host/port');
  expect(sqlServerExportRelayTarget({ ...connection, readTimeout: 0 })).toBeUndefined();
  expect(() => sqlServerExportRelayTarget({ ...connection, sqlServerAuth: 'windows' })).toThrow(
    'server SPN',
  );
  expect(
    sqlServerExportRelayTarget({
      ...connection,
      sqlServerAuth: 'windows',
      sqlServerSpn: 'MSSQLSvc/database.example:1433',
    }),
  ).toMatchObject({ host: 'database.example', port: 1433 });
});

for (const integrated of [false, true])
  it.skipIf(
    integrated
      ? process.platform !== 'win32' || process.env.TEST_WINDOWS_SQLSERVER !== '1'
      : process.env.DB_INTEGRATION !== '1',
  )(
    `SQL Server native export preserves schema, data and identity through the app importer (${integrated ? 'Windows' : 'SQL password'})`,
    async () => {
      const database = 'dw_smo_export_' + randomUUID().replaceAll('-', '').slice(0, 12);
      const connection = {
        ...connectionSchema.parse({
          name: 'SMO export',
          engine: 'sqlserver',
          host: integrated ? process.env.WINDOWS_SQLSERVER_HOST || 'lpc:localhost' : '127.0.0.1',
          port: integrated ? Number(process.env.WINDOWS_SQLSERVER_PORT || 1433) : 11433,
          username: 'sa',
          sqlServerAuth: integrated ? 'windows' : 'sql',
          sqlServerSpn: integrated ? process.env.WINDOWS_SQLSERVER_SPN : undefined,
          database,
          readTimeout: integrated && !process.env.WINDOWS_SQLSERVER_SPN ? 0 : 3000,
          writeTimeout: integrated && !process.env.WINDOWS_SQLSERVER_SPN ? 0 : 2000,
        }),
        id: randomUUID(),
      } as Connection;
      const password = integrated ? undefined : process.env.DB_TEST_PASSWORD;
      const driver = integrated ? (await import('mssql/msnodesqlv8.js')).default : mssql;
      const createPool = (database: string) =>
        new driver.ConnectionPool({
          server: connection.host!,
          port: connection.port,
          user: 'sa',
          password,
          database,
          ...(integrated
            ? {
                driver: 'ODBC Driver 18 for SQL Server',
                connectionString: windowsConnectionString({ ...connection, database }),
              }
            : {}),
          options: {
            encrypt: false,
            trustServerCertificate: false,
            ...(integrated ? { trustedConnection: true } : {}),
          },
        }).connect();
      const admin = await createPool('master');
      let db: mssql.ConnectionPool | undefined, adapter: SqlServerAdapter | undefined;
      const exec = async (sql: string) => {
        try {
          return await db!.request().batch(sql);
        } catch (error) {
          throw new Error(sql.slice(0, 300) + ': ' + (error as Error).message);
        }
      };
      const exportSql = async (includeData: boolean) => {
        let sql = '',
          tables = 0;
        await sqlServerSqlExport(connection, password, {
          includeData,
          timeout: 30000,
          signal: new AbortController().signal,
          write: async (chunk) => {
            sql += chunk;
          },
          progress: (value) => {
            tables = value.tables;
          },
        });
        expect(tables).toBeGreaterThanOrEqual(3);
        return sql;
      };
      const open = async () => {
        db = await createPool(database);
      };
      const restore = async (sql: string) => {
        adapter = new SqlServerAdapter(connection, password);
        await adapter.withScriptSession(async (execute) => {
          for (const batch of splitSqlScript(sql, 'sqlserver')) {
            try {
              await execute(batch.sql, new AbortController().signal, 10000);
            } catch (error) {
              throw new Error(
                'Restore batch ' + batch.sql.slice(0, 180) + ': ' + (error as Error).message,
              );
            }
          }
        });
        await adapter.disconnect();
        adapter = undefined;
      };
      // msnodesqlv8 also uses the process-wide ODBC pool. Closing its JS pool
      // can leave an idle native session until process exit. This test owns
      // this randomly named database, so discard only its remaining sessions.
      const drop = () =>
        admin
          .request()
          .batch(
            `IF DB_ID('${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`,
          );
      try {
        await admin.request().batch('CREATE DATABASE [' + database + ']');
        await open();
        await exec('CREATE SCHEMA extra');
        await exec('CREATE TYPE extra.code FROM nvarchar(50) NOT NULL');
        await exec('CREATE SEQUENCE extra.seq AS bigint START WITH 10 INCREMENT BY 3');
        await exec(`CREATE TABLE dbo.items(id bigint IDENTITY(5,2) PRIMARY KEY,label nvarchar(max),amount numeric(38,18),bits varbinary(max),flt float,tm datetime2(7),dto datetimeoffset(7),v sql_variant,code extra.code,computed AS(id*2) PERSISTED);
      CREATE TABLE extra.child(id int PRIMARY KEY,parent bigint REFERENCES dbo.items(id),amount int CONSTRAINT positive CHECK(amount>0),serial bigint);
      CREATE TABLE extra.audit(id bigint);
      CREATE INDEX label_lookup ON dbo.items(id) INCLUDE(amount) WHERE amount IS NOT NULL;
      EXEC sys.sp_addextendedproperty @name=N'MS_Description',@value=N'中文 comment',@level0type=N'SCHEMA',@level0name=N'dbo',@level1type=N'TABLE',@level1name=N'items';`);
        await exec(
          'ALTER TABLE extra.child ADD CONSTRAINT serial_default DEFAULT (NEXT VALUE FOR extra.seq) FOR serial',
        );
        await exec(
          'CREATE FUNCTION extra.echo(@v nvarchar(max)) RETURNS nvarchar(max) AS BEGIN RETURN @v END',
        );
        await exec(
          'CREATE VIEW extra.labels AS SELECT id,extra.echo(label) AS label FROM dbo.items',
        );
        await exec('CREATE VIEW dbo.labels AS SELECT * FROM extra.labels');
        await exec(`CREATE TABLE extra.types(id int PRIMARY KEY, text_value nvarchar(max), single_value real, geo geometry, location geography, node hierarchyid, document xml, guid uniqueidentifier, clock time(7), legacy varchar(100) COLLATE Latin1_General_100_BIN2, variant_text sql_variant, empty_blob varbinary(max));
      INSERT INTO extra.types VALUES(1,N'nul'+NCHAR(0)+N'中文',1.23456789,geometry::STGeomFromText('POINT (1 2)',4326),geography::Point(25.1,121.5,4326),hierarchyid::Parse('/1/2/'),'<root>中文</root>','e112543a-1960-4ef8-9b0b-86494c7d9401','01:02:03.1234567','é',CAST(N'中文' AS nvarchar(20)),0x);
      CREATE TABLE extra.empty_used(id int IDENTITY(5,2)); INSERT INTO extra.empty_used DEFAULT VALUES; DELETE FROM extra.empty_used; DBCC CHECKIDENT('extra.empty_used',RESEED,901);
      CREATE TABLE extra.empty_new(id int IDENTITY(5,2)); DBCC CHECKIDENT('extra.empty_new',RESEED,801);
      CREATE SEQUENCE extra.used_sequence AS bigint START WITH 50 INCREMENT BY 5;
      SELECT NEXT VALUE FOR extra.used_sequence; SELECT NEXT VALUE FOR extra.used_sequence; SELECT NEXT VALUE FOR extra.used_sequence;
      CREATE SEQUENCE extra.cycling AS int START WITH 9 INCREMENT BY 2 MINVALUE 1 MAXVALUE 10 CYCLE;
      SELECT NEXT VALUE FOR extra.cycling; SELECT NEXT VALUE FOR extra.cycling; SELECT NEXT VALUE FOR extra.cycling;
      CREATE SEQUENCE extra.exhausted AS int START WITH 9 INCREMENT BY 1 MINVALUE 1 MAXVALUE 10 NO CYCLE;
      SELECT NEXT VALUE FOR extra.exhausted; SELECT NEXT VALUE FOR extra.exhausted;
      CREATE TABLE extra.disabled(id int CONSTRAINT must_positive CHECK(id>0)); ALTER TABLE extra.disabled NOCHECK CONSTRAINT must_positive; INSERT INTO extra.disabled VALUES(-1);
      CREATE TABLE [extra].[a]]b]([列]]名] nvarchar(20), chinese varchar(50) COLLATE Chinese_Taiwan_Stroke_BIN, legacy_text text COLLATE Chinese_Taiwan_Stroke_BIN); INSERT INTO [extra].[a]]b] VALUES(N'中文',N'中文',N'舊式中文');
      INSERT INTO extra.types(id) VALUES(2);
      INSERT INTO extra.types(id,variant_text) VALUES(3,CAST(N'中文' COLLATE Chinese_Taiwan_Stroke_BIN AS varchar(20)));
      INSERT INTO extra.types(id,variant_text) VALUES(4,CAST('01:02:03.1234567' AS time(7)));
      INSERT INTO extra.types(id,variant_text) VALUES(5,CAST(1.2345678901234567 AS float));
      INSERT INTO extra.types(id,variant_text) VALUES(6,CAST(0x00FFAABB AS binary(8)));
    `);
        await exec(
          'CREATE TRIGGER dbo.audit_insert ON dbo.items AFTER INSERT AS INSERT INTO extra.audit SELECT id FROM inserted',
        );
        await db!
          .request()
          .input('text', mssql.NVarChar(mssql.MAX), "中文😀\r\nline\nquote' slash\\")
          .batch(
            `INSERT INTO items(label,amount,bits,flt,tm,dto,v,code) VALUES(@text,12345678901234567890.123456789012345678,0x00FF0A0D,1.2345678901234567,'2025-01-02 03:04:05.1234567','2025-01-02 03:04:05.1234567+08:00',CAST(12345678901234567890.123456789012345678 AS numeric(38,18)),N'代碼'); INSERT INTO extra.child(id,parent,amount) VALUES(1,5,2); DBCC CHECKIDENT('dbo.items',RESEED,901); ALTER SEQUENCE extra.seq RESTART WITH 1000;`,
          );
        const snapshot = async () => ({
          items: (
            await exec(
              "SELECT CONVERT(varchar(50),id) AS id,label,CONVERT(varchar(60),amount) AS amount,CONVERT(varchar(max),bits,2) AS bits,CONVERT(varchar(50),CAST(flt AS binary(8)),2) AS flt,CONVERT(varchar(40),tm,126) AS tm,CONVERT(varchar(45),dto,127) AS dto,CONVERT(varchar(60),v) AS v,SQL_VARIANT_PROPERTY(v,'BaseType') AS vtype,SQL_VARIANT_PROPERTY(v,'Precision') AS precision,SQL_VARIANT_PROPERTY(v,'Scale') AS scale,code,CONVERT(varchar(50),computed) AS computed FROM dbo.items",
            )
          ).recordset,
          child: (
            await exec(
              'SELECT id,CONVERT(varchar(50),parent) AS parent,amount,CONVERT(varchar(50),serial) AS serial FROM extra.child',
            )
          ).recordset,
          audit: (await exec('SELECT CONVERT(varchar(50),id) AS id FROM extra.audit')).recordset,
          view: (await exec('SELECT CONVERT(varchar(50),id) AS id,label FROM dbo.labels'))
            .recordset,
          identity: (
            await exec(
              "SELECT CONVERT(varchar(50),last_value) AS value FROM sys.identity_columns WHERE object_id=OBJECT_ID('dbo.items')",
            )
          ).recordset,
          sequence: (
            await exec(
              'SELECT name,CONVERT(varchar(50),current_value) AS value,CONVERT(varchar(50),start_value) AS start,CONVERT(varchar(50),increment) AS step,is_exhausted FROM sys.sequences ORDER BY name',
            )
          ).recordset,
          types: (
            await exec(
              "SELECT text_value,CONVERT(varchar(50),CAST(single_value AS binary(4)),2) AS single_value,CONVERT(varchar(max),geo.Serialize(),2) AS geo,CONVERT(varchar(max),location.Serialize(),2) AS location,node.ToString() AS node,CONVERT(nvarchar(max),document) AS document,CONVERT(varchar(40),guid) AS guid,CONVERT(varchar(40),clock,126) AS clock,legacy,CONVERT(nvarchar(50),variant_text) AS variant_text,SQL_VARIANT_PROPERTY(variant_text,'MaxLength') AS variant_length,CONVERT(varchar(max),empty_blob,2) AS empty_blob FROM extra.types",
            )
          ).recordset,
          quoted: (
            await exec(
              'SELECT [列]]名],chinese,CONVERT(varchar(max),CAST(chinese AS varbinary(max)),2) AS raw,CONVERT(varchar(max),CAST(CONVERT(varchar(max),legacy_text) AS varbinary(max)),2) AS raw_text FROM [extra].[a]]b]',
            )
          ).recordset,
          checks: (
            await exec(
              'SELECT name,is_disabled,is_not_trusted FROM sys.check_constraints ORDER BY name',
            )
          ).recordset,
        });
        const before = await snapshot();
        const sql = await exportSql(true),
          schema = await exportSql(false);
        expect(sql).toContain('12345678901234567890.123456789012345678');
        await db!.close();
        db = undefined;
        await drop();
        await admin.request().batch('CREATE DATABASE [' + database + ']');
        await restore(sql);
        await open();
        expect(await snapshot()).toEqual(before);
        await exec("INSERT INTO dbo.items(label,code) VALUES(N'next',N'next')");
        expect(String((await exec('SELECT MAX(id) AS id FROM dbo.items')).recordset[0].id)).toBe(
          '903',
        );
        expect((await exec('SELECT COUNT(*) AS n FROM extra.audit')).recordset[0].n).toBe(2);
        expect(
          String(
            (await exec('INSERT INTO extra.empty_used OUTPUT inserted.id DEFAULT VALUES'))
              .recordset[0].id,
          ),
        ).toBe('903');
        expect(
          String(
            (await exec('INSERT INTO extra.empty_new OUTPUT inserted.id DEFAULT VALUES'))
              .recordset[0].id,
          ),
        ).toBe('801');
        expect(
          String((await exec('SELECT NEXT VALUE FOR extra.used_sequence AS n')).recordset[0].n),
        ).toBe('65');
        expect(
          String((await exec('SELECT NEXT VALUE FOR extra.cycling AS n')).recordset[0].n),
        ).toBe('5');
        await db!.close();
        db = undefined;
        await drop();
        await admin.request().batch('CREATE DATABASE [' + database + ']');
        await restore(schema);
        await open();
        expect((await exec('SELECT COUNT(*) AS n FROM dbo.items')).recordset[0].n).toBe(0);
        // All table read locks are held before the first SQL chunk is delivered.
        let writer: Promise<unknown> | undefined,
          writerFinished = false;
        await sqlServerSqlExport(connection, password, {
          includeData: true,
          timeout: 30000,
          signal: new AbortController().signal,
          write: async () => {
            if (!writer) {
              writer = exec("INSERT INTO dbo.items(code) VALUES(N'concurrent')").then(() => {
                writerFinished = true;
              });
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            expect(writerFinished).toBe(false);
          },
          progress: () => {},
        });
        await writer;
        expect(writerFinished).toBe(true);
        if (connection.readTimeout) {
          const lock = new driver.Transaction(db!);
          await lock.begin();
          try {
            await new driver.Request(lock).batch(
              'SELECT TOP (1) * FROM dbo.items WITH (TABLOCKX,HOLDLOCK)',
            );
            await expect(
              sqlServerSqlExport({ ...connection, readTimeout: 500 }, password, {
                includeData: true,
                timeout: 30000,
                signal: new AbortController().signal,
                write: async () => {},
                progress: () => {},
              }),
            ).rejects.toThrow('Network read timed out');
          } finally {
            await lock.rollback();
          }
        }
        if (!integrated) {
          await expect(
            sqlServerSqlExport({ ...connection, tls: true }, password, {
              includeData: false,
              timeout: 30000,
              signal: new AbortController().signal,
              write: async () => {},
              progress: () => {},
            }),
          ).rejects.toThrow(/certificate|SSL Provider/i);
        }
        const controller = new AbortController();
        let cancelStarted = 0;
        await expect(
          sqlServerSqlExport(connection, password, {
            includeData: true,
            timeout: 30000,
            signal: controller.signal,
            write: async () => {
              cancelStarted = Date.now();
              controller.abort();
            },
            progress: () => {},
          }),
        ).rejects.toThrow('cancelled');
        expect(Date.now() - cancelStarted).toBeLessThan(3000);
        const deadline = Date.now() + 3000;
        while (
          (
            await admin
              .request()
              .input('db', database)
              .query(
                "SELECT 1 FROM sys.dm_exec_sessions WHERE database_id=DB_ID(@db) AND program_name='Database Workspace SQL export'",
              )
          ).recordset.length
        ) {
          if (Date.now() > deadline)
            throw new Error('Native SQL export sessions remained after cancellation.');
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        await exec(
          'CREATE FUNCTION extra.filter_row(@id bigint) RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS allowed WHERE @id>0',
        );
        await exec(
          'CREATE SECURITY POLICY extra.row_policy ADD FILTER PREDICATE extra.filter_row(id) ON dbo.items WITH(STATE=ON)',
        );
        await expect(exportSql(true)).rejects.toThrow('row-level security');
        expect(await exportSql(false)).toContain('SECURITY POLICY');
      } finally {
        await adapter?.disconnect();
        await db?.close();
        await drop();
        await admin.close();
      }
    },
    150000,
  );
