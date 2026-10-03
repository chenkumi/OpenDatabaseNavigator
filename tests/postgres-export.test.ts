import { it, expect, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createServer, createConnection, type Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { once } from 'node:events';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findPgDump,
  pgDumpConnectionString,
  pgDumpEnvironment,
  postgresSqlExport,
} from '../src/main/database/adapters/postgres/pg-dump';
import { PostgresAdapter } from '../src/main/database/adapters/postgres/postgres-adapter';
import { connectionSchema } from '../src/shared/schemas';
import { splitSqlScript } from '../src/main/database/sql-script-parser';
import type { Connection } from '../src/shared/types';

vi.mock('node:child_process', { spy: true });

const config = (database: string): Connection => ({
  ...connectionSchema.parse({
    name: 'PG export',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 15432,
    username: 'workspace',
    database,
    readTimeout: 2000,
    writeTimeout: 2000,
  }),
  id: randomUUID(),
});

it('isolates native libpq options and keeps secrets out of arguments', async () => {
  const c = config("test' \\ host=other");
  expect(pgDumpConnectionString(c)).toContain("dbname='test\\' \\\\ host=other'");
  const previous = process.env.PGSERVICE;
  process.env.PGSERVICE = 'external';
  try {
    const env = pgDumpEnvironment({ ...c, tls: true }, 'private-secret');
    expect(env.PGSERVICE).toBeUndefined();
    expect(env.PGPASSWORD).toBe('private-secret');
    expect(env.PGSSLMODE).toBe('verify-full');
    expect(pgDumpConnectionString(c)).not.toContain('private-secret');
    expect(pgDumpConnectionString({ ...c, host: 'database.example' }, 12345)).toContain(
      "host='database.example' port='12345' hostaddr='127.0.0.1'",
    );
  } finally {
    if (previous === undefined) delete process.env.PGSERVICE;
    else process.env.PGSERVICE = previous;
  }
  await expect(findPgDump('relative/pg_dump')).rejects.toThrow('absolute path');
  expect(() => pgDumpConnectionString({ ...c, database: 'invalid\0' })).toThrow('Invalid');
});

it.skipIf(process.env.DB_INTEGRATION !== '1')(
  'native PostgreSQL export restores data, dependencies and sequence state through the app parser',
  async () => {
    const name = 'dw_pg_export_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const c = config(name),
      password = process.env.DB_TEST_PASSWORD;
    const clientConfig = { host: c.host, port: c.port, user: c.username, password };
    const admin = new pg.Client({ ...clientConfig, database: 'workspace' });
    await admin.connect();
    let db: pg.Client | undefined;
    let adapter: PostgresAdapter | undefined;
    const open = async () => {
      db = new pg.Client({ ...clientConfig, database: name });
      await db.connect();
    };
    const exportSql = async (includeData: boolean) => {
      let sql = '';
      let tables = 0;
      await postgresSqlExport({ ...c, charset: 'BIG5' }, password, {
        includeData,
        signal: new AbortController().signal,
        timeout: 10000,
        write: async (chunk) => {
          sql += chunk;
        },
        progress: (value) => {
          tables = value.tables;
        },
      });
      expect(tables).toBeGreaterThanOrEqual(5);
      expect(sql).not.toMatch(/^\\(?:un)?restrict /m);
      return sql;
    };
    const restore = async (sql: string) => {
      adapter = new PostgresAdapter(c, password);
      await adapter.withScriptSession(async (execute) => {
        for (const unit of splitSqlScript(sql, 'postgres')) {
          try {
            await execute(unit.sql, new AbortController().signal, 10000);
          } catch (error) {
            throw new Error(
              'Restore statement ' + unit.sql.slice(0, 180) + ': ' + (error as Error).message,
            );
          }
        }
      });
      await adapter.disconnect();
      adapter = undefined;
    };
    try {
      await admin.query('CREATE DATABASE "' + name + '"');
      await open();
      await db!.query(`
      CREATE SCHEMA extra;
      CREATE TYPE extra.status AS ENUM ('new','完成');
      CREATE DOMAIN extra.positive AS numeric(40,20) CHECK(VALUE>=0);
      CREATE TYPE extra.pair AS (a int,b text);
      CREATE TABLE public.items(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text, amount extra.positive, state extra.status, payload bytea, tags text[], json jsonb, doubled bigint GENERATED ALWAYS AS(id*2) STORED);
      CREATE TABLE extra.child(id serial PRIMARY KEY,parent bigint REFERENCES public.items(id), value extra.pair);
      CREATE INDEX labels_partial ON public.items(label) WHERE state='new';
      COMMENT ON TABLE public.items IS '中文 comment';
      CREATE FUNCTION extra.echo(v text) RETURNS text LANGUAGE SQL IMMUTABLE AS $$SELECT v$$;
      CREATE VIEW extra.labels AS SELECT id, extra.echo(label) AS label FROM public.items;
      CREATE VIEW public.labels AS SELECT * FROM extra.labels;
      CREATE TABLE extra.audit(id bigint);
      CREATE FUNCTION extra.audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO extra.audit VALUES(NEW.id); RETURN NEW; END$$;
      CREATE TRIGGER audit_insert AFTER INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION extra.audit_insert();
      CREATE TABLE extra.partitioned(id int, value text) PARTITION BY RANGE(id);
      CREATE TABLE extra.part1 PARTITION OF extra.partitioned FOR VALUES FROM(0) TO(100);
      INSERT INTO extra.partitioned VALUES(1,'分割');
      ALTER TABLE extra.child ENABLE ROW LEVEL SECURITY;
      CREATE POLICY readable ON extra.child FOR SELECT USING (parent>0);
      GRANT SELECT ON public.items TO PUBLIC;
      CREATE EXTENSION hstore;
      CREATE TABLE extra.extended(id uuid, bag hstore, span interval, moment timestamptz);
      INSERT INTO extra.extended VALUES('e112543a-1960-4ef8-9b0b-86494c7d9401','a=>b','2 days 03:04:05.123456','2025-01-02 03:04:05.123456+08');
      SELECT lo_from_bytea(987123,decode('00ff0a0d','hex'));
    `);
      await db!.query(
        'INSERT INTO items(label,amount,state,payload,tags,json) VALUES($1,$2,$3,$4,$5,$6)',
        [
          "中文😀\r\nline\nquote' slash\\",
          '12345678901234567890.12345678901234567890',
          'new',
          Buffer.from([0, 255, 10, 13]),
          ['one', '中文\r\nx'],
          { value: '😀' },
        ],
      );
      await db!.query(
        "INSERT INTO extra.child(parent,value) VALUES(1,ROW(7,'pair')); SELECT setval('items_id_seq',901,true); CREATE MATERIALIZED VIEW extra.cached AS SELECT label FROM items;",
      );
      const snapshot = async () => ({
        items: (
          await db!.query(
            "SELECT id::text,label,amount::text,state::text,encode(payload,'hex') AS payload,tags,json,doubled::text FROM items ORDER BY id",
          )
        ).rows,
        child: (await db!.query('SELECT id,parent::text,value::text FROM extra.child')).rows,
        audit: (await db!.query('SELECT id::text FROM extra.audit')).rows,
        partition: (await db!.query('SELECT * FROM extra.partitioned')).rows,
        views: (await db!.query('SELECT * FROM public.labels')).rows,
        cached: (await db!.query('SELECT * FROM extra.cached')).rows,
        sequence: (await db!.query('SELECT last_value::text,is_called FROM items_id_seq')).rows,
        extended: (
          await db!.query('SELECT id,bag::text,span::text,moment::text FROM extra.extended')
        ).rows,
        lob: (await db!.query("SELECT encode(lo_get(987123),'hex') AS value")).rows,
      });
      const before = await snapshot();
      const sql = await exportSql(true),
        schema = await exportSql(false);
      expect(sql).toContain('12345678901234567890.12345678901234567890');
      expect(schema).not.toMatch(/^INSERT INTO/m);
      await db!.end();
      db = undefined;
      await admin.query('DROP DATABASE "' + name + '"');
      await admin.query('CREATE DATABASE "' + name + '"');
      await restore(sql);
      await open();
      expect(await snapshot()).toEqual(before);
      expect(
        (await db!.query("SELECT obj_description('items'::regclass)")).rows[0].obj_description,
      ).toBe('中文 comment');
      expect(
        (await db!.query("INSERT INTO items(label) VALUES('next') RETURNING id::text")).rows[0].id,
      ).toBe('902');
      expect((await db!.query('SELECT count(*)::int AS n FROM extra.audit')).rows[0].n).toBe(2);
      expect(
        (
          await db!.query(
            "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='extra' AND tablename='child'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await db!.query("SELECT relacl::text FROM pg_class WHERE oid='public.items'::regclass"))
          .rows[0].relacl,
      ).toContain('=r/');
      // Cancellation while pg_dump waits for a table lock must close its backend.
      await db!.query('BEGIN; LOCK TABLE public.items IN ACCESS EXCLUSIVE MODE');
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 350);
      const started = Date.now();
      try {
        await expect(
          postgresSqlExport(c, password, {
            includeData: true,
            signal: abort.signal,
            timeout: 10000,
            write: async () => {},
            progress: () => {},
          }),
        ).rejects.toThrow('cancelled');
        expect(Date.now() - started).toBeLessThan(3000);
      } finally {
        clearTimeout(timer);
      }
      // The native tool remains alive but its backend cannot acquire a lock:
      // only the remote socket read deadline should end this operation.
      try {
        await expect(
          postgresSqlExport({ ...c, readTimeout: 250 }, password, {
            includeData: true,
            signal: new AbortController().signal,
            timeout: 10000,
            write: async () => {},
            progress: () => {},
          }),
        ).rejects.toThrow('Network read timed out');
      } finally {
        await db!.query('ROLLBACK');
      }
      const deadline = Date.now() + 3000;
      while (
        (
          await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name='pg_dump'",
            [name],
          )
        ).rowCount
      ) {
        if (Date.now() > deadline) throw new Error('Cancelled export left a pg_dump backend');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      await db!.end();
      db = undefined;
      await admin.query('DROP DATABASE "' + name + '"');
      await admin.query('CREATE DATABASE "' + name + '"');
      await restore(schema);
      await open();
      expect((await db!.query('SELECT count(*)::int AS n FROM items')).rows[0].n).toBe(0);
    } finally {
      await adapter?.disconnect();
      await db?.end();
      await admin.query('DROP DATABASE IF EXISTS "' + name + '"');
      await admin.end();
    }
  },
  90000,
);

it.skipIf(process.env.DB_INTEGRATION !== '1')(
  'native pg_dump validates TLS through the relay and pauses deadlines for slow output',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dw-pg-tls-'));
    const cert = await readFile(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));
    const key = await readFile(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
    await mkdir(join(root, 'postgresql'));
    await writeFile(join(root, 'postgresql', 'root.crt'), cert);
    const { spawn } = await vi.importActual<typeof childProcess>('node:child_process');
    // Give only the native test child an explicit public test CA. Do not alter
    // the user's libpq trust store or weaken the production verify-full mode.
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: any[]) => {
      if (args[1]?.some((arg: string) => arg.startsWith('--dbname='))) {
        expect(args[2].env.PGSSLMODE).toBe('verify-full');
        args[2] = {
          ...args[2],
          env: { ...args[2].env, PGSSLROOTCERT: join(root, 'postgresql', 'root.crt') },
        };
      }
      return (spawn as any)(...args);
    }) as typeof childProcess.spawn);
    const context = createSecureContext({ cert, key });
    const sockets = new Set<Socket>();
    let secureConnections = 0;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      let pending = Buffer.alloc(0);
      const negotiate = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < 8) return;
        const code = pending.readInt32BE(4);
        if (code === 80877104) {
          // Decline optional GSS encryption, then await SSLRequest.
          pending = pending.subarray(8);
          socket.write('N');
          return;
        }
        if (code !== 80877103 || pending.length !== 8) {
          socket.destroy();
          return;
        }
        socket.off('data', negotiate);
        socket.write('S');
        const tls = new TLSSocket(socket, { isServer: true, secureContext: context });
        sockets.add(tls);
        tls.on('error', () => {});
        tls.once('secure', () => {
          secureConnections++;
          const upstream = createConnection({ host: '127.0.0.1', port: 15432 });
          sockets.add(upstream);
          upstream.on('error', () => tls.destroy());
          upstream.once('connect', () => {
            tls.pipe(upstream);
            upstream.pipe(tls);
          });
          tls.once('close', () => upstream.destroy());
          upstream.once('close', () => tls.destroy());
        });
      };
      socket.on('data', negotiate);
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      let output = '',
        delayed = false;
      await postgresSqlExport(
        {
          ...config('workspace'),
          host: 'localhost',
          tls: true,
          port: (server.address() as { port: number }).port,
          readTimeout: 500,
        },
        process.env.DB_TEST_PASSWORD,
        {
          includeData: false,
          timeout: 10000,
          signal: new AbortController().signal,
          progress: () => {},
          write: async (chunk) => {
            if (!delayed) {
              delayed = true;
              await new Promise((resolve) => setTimeout(resolve, 750));
            }
            output += chunk;
          },
        },
      );
      expect(secureConnections).toBeGreaterThan(0);
      expect(output).toContain('PostgreSQL database dump complete');
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.listen(0, '127.0.0.2');
      await once(server, 'listening');
      await expect(
        postgresSqlExport(
          {
            ...config('workspace'),
            host: '127.0.0.2',
            tls: true,
            port: (server.address() as { port: number }).port,
          },
          process.env.DB_TEST_PASSWORD,
          {
            includeData: false,
            timeout: 10000,
            signal: new AbortController().signal,
            progress: () => {},
            write: async () => {},
          },
        ),
      ).rejects.toThrow(/does not match host name/);
      // Removing the test trust anchor must fail; enabling I/O deadlines must
      // not turn verify-full into a permissive or plaintext connection.
      await rm(join(root, 'postgresql', 'root.crt'));
      await expect(
        postgresSqlExport(
          {
            ...config('workspace'),
            host: '127.0.0.2',
            tls: true,
            port: (server.address() as { port: number }).port,
          },
          process.env.DB_TEST_PASSWORD,
          {
            includeData: false,
            timeout: 10000,
            signal: new AbortController().signal,
            progress: () => {},
            write: async () => {},
          },
        ),
      ).rejects.toThrow(/root certificate|certificate verify failed/);
    } finally {
      spawnSpy.mockRestore();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
