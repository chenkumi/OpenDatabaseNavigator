import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  aseSqlExport,
  aseExportTools,
  validateAseDdl,
} from '../src/main/database/adapters/sybase/sql-export';
import { connectionSchema } from '../src/shared/schemas';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import {
  aseDataRestorePlan,
  aseDdlSignature,
} from '../src/main/database/adapters/sybase/export-plan';
import { aseDataExport } from '../src/main/database/adapters/sybase/data-export';

it('defers native triggers and foreign keys, preserving session context and rejecting inline rewrites', () => {
  const base = 'use rental\ngo\nset quoted_identifier on\ngo\ncreate table dbo.t(id int)\ngo\n';
  const tail =
    'alter table dbo.t add constraint fk foreign key(id) references dbo.t(id)\ngo\ncreate trigger dbo.tr on dbo.t for insert as select 1\ngo\n';
  const plan = aseDataRestorePlan(base + tail, base);
  expect(plan.before).not.toContain('create trigger');
  expect(plan.after).toContain('use rental\nGO');
  expect(plan.after).toContain('set quoted_identifier on\nGO');
  expect(plan.after.indexOf('foreign key')).toBeLessThan(plan.after.indexOf('create trigger'));
  expect(() => aseDataRestorePlan(base + tail, base + tail)).toThrow('did not filter');
  expect(() =>
    aseDataRestorePlan(base.replace('id int', 'id int references dbo.x(id)'), base),
  ).toThrow('safely defer');
  expect(() => aseDataRestorePlan(base + 'drop table dbo.t\ngo', base)).toThrow('safely defer');
  expect(aseDdlSignature('-- generated yesterday\n' + base)).toEqual(
    aseDdlSignature('-- today\n' + base),
  );
});

it('validates native ASE database scope without changing compiled SQL bodies', () => {
  const sql =
    "use [rental]\ngo\ncreate table dbo.t(id int)\ngo\ncreate procedure dbo.p as select 'USE other'\ngo\n";
  expect(validateAseDdl(sql, 'rental')).toBe(1);
  expect(() => validateAseDdl('use wrong\ngo', 'rental')).toThrow('different database');
  expect(() => validateAseDdl('use rental\ngo\ncreate database wrong\ngo', 'rental')).toThrow(
    'different database',
  );
  expect(() => validateAseDdl('-- nothing', 'rental')).toThrow('no statements');
});

it('validates tool settings without allowing export paths on other database engines', async () => {
  const connection = { ...connectionSchema.parse({ name: 'ASE', engine: 'sybase' }), id: 'test' };
  await expect(aseExportTools({ ...connection, aseJavaPath: 'java.exe' })).rejects.toThrow(
    'absolute path',
  );
  for (const field of ['aseJavaPath', 'aseDdlgenPath', 'aseJconnectPath'])
    expect(
      connectionSchema.safeParse({
        name: 'wrong engine',
        engine: 'postgres',
        [field]: 'C:\\tool.jar',
      }).success,
    ).toBe(false);
});

// Discover Java rather than installing or changing the user's runtime. Missing
// Java compiler is an explicit skip; these are real process tests, not ASE tests.
const probe = spawnSync('java', ['-XshowSettings:properties', '-version'], {
  encoding: 'utf8',
  windowsHide: true,
});
const javaHome = /^\s*java.home\s*=\s*(.+)$/m.exec(probe.stderr || '')?.[1]?.trim();
const executable = (name: string) =>
  join(javaHome || '', 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const compiler = javaHome
  ? spawnSync(executable('javac'), ['-version'], { windowsHide: true })
  : undefined;

if (!javaHome || compiler?.status !== 0)
  // A silent skip would make the missing coverage invisible in a green run.
  console.warn(
    'SKIPPED: ASE export tests need a JDK (java and javac) on PATH; none was found, so these cases did not run.',
  );
describe.skipIf(!javaHome || compiler?.status !== 0)(
  'ASE export with a real Java process and simulated ddlgen',
  () => {
    let directory: string;
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'dw-ase-java-test-'));
      const classes = join(directory, 'classes');
      await mkdir(classes);
      const compiled = spawnSync(
        executable('javac'),
        [
          '-encoding',
          'UTF-8',
          '-d',
          classes,
          resolve('tests/fixtures/ase-ddlgen/DDLGenerator.java'),
          resolve('tests/fixtures/ase-ddlgen/SybDriver.java'),
        ],
        { windowsHide: true, encoding: 'utf8' },
      );
      expect(compiled.status, compiled.stderr).toBe(0);
      const packed = spawnSync(
        executable('jar'),
        ['cf', join(directory, 'DDLGen.jar'), '-C', classes, '.'],
        { windowsHide: true, encoding: 'utf8' },
      );
      expect(packed.status, packed.stderr).toBe(0);
      await copyFile(join(directory, 'DDLGen.jar'), join(directory, 'jconn4.jar'));
    }, 30000);
    afterAll(async () => {
      if (
        directory &&
        resolve(directory).startsWith(
          resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'),
        )
      )
        await rm(directory, { recursive: true, force: true });
    });
    const config = (username = 'ok') => ({
      ...connectionSchema.parse({
        name: 'native export',
        engine: 'sybase',
        username,
        database: 'rental_test',
        aseJavaPath: executable('java'),
        aseDdlgenPath: join(directory, 'DDLGen.jar'),
        aseJconnectPath: join(directory, 'jconn4.jar'),
      }),
      id: 'test',
    });
    const options = () => ({
      includeData: false,
      timeout: 5000,
      signal: new AbortController().signal,
      write: async (_chunk: string) => {},
      progress: (_value: unknown) => {},
    });
    const password = "private 中文 '&<> secret";

    it('exports native Unicode SQL with a stdin password and cleans temporary output', async () => {
      const before = (await readdir(tmpdir()))
        .filter((name) => name.startsWith('database-workspace-ase-ddl-'))
        .sort();
      let sql = '';
      const progress: unknown[] = [];
      await aseSqlExport(config(), password, {
        ...options(),
        write: async (chunk) => {
          sql += chunk;
        },
        progress: (value) => progress.push(value),
      });
      expect(sql).toContain("'中文😀'");
      expect(sql).toContain('create database [rental_test]');
      expect(progress).toEqual([{ tables: 1, rows: 0 }]);
      expect(
        (await readdir(tmpdir()))
          .filter((name) => name.startsWith('database-workspace-ase-ddl-'))
          .sort(),
      ).toEqual(before);
    });
    it.each(['diagnostic', 'wrongdb', 'empty', 'nonzero', 'invalid-utf8', 'oversize'])(
      'rejects %s without handing out partial SQL',
      async (mode) => {
        let writes = 0;
        let error: unknown;
        try {
          await aseSqlExport(config(mode), password, {
            ...options(),
            write: async () => {
              writes++;
            },
          });
        } catch (value) {
          error = value;
        }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(password);
        expect(writes).toBe(0);
      },
    );
    it('stops a stalled child on cancellation or deadline', async () => {
      const controller = new AbortController();
      const cancelled = expect(
        aseSqlExport(config('hang'), password, { ...options(), signal: controller.signal }),
      ).rejects.toThrow('cancelled');
      setTimeout(() => controller.abort(), 250);
      await cancelled;
      await expect(
        aseSqlExport(config('hang'), password, { ...options(), timeout: 150 }),
      ).rejects.toThrow('timed out');
    });
    it('monitors native upstream I/O and closes the relay after failure', async () => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('data', () => {});
        socket.once('close', () => sockets.delete(socket));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        await expect(
          aseSqlExport(
            {
              ...config('network'),
              host: '127.0.0.1',
              port: (server.address() as { port: number }).port,
              readTimeout: 150,
            },
            password,
            options(),
          ),
        ).rejects.toThrow('Network read timed out');
        await expect.poll(() => sockets.size).toBe(0);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done) => server.close(() => done()));
      }
    });
    it.each([false, true])(
      'rejects native SQL export data=%s for GUI and MCP before starting a worker',
      async (includeData) => {
        const app = new Application(
          {
            connections: new MemoryStore([]),
            workspace: new MemoryStore({ tabs: [] }),
            settings: new MemoryStore(DEFAULT_SETTINGS),
            history: new MemoryStore([]),
            audit: new MemoryStore([]),
          },
          { get: () => password, set() {}, delete() {} },
          (connection) => ({
            connect: async () => {},
            disconnect: async () => {},
            query: async () => {
              throw new Error('No SQL queries expected in this transport test.');
            },
            schemas: async () => [],
            tables: async () => [],
            databases: async () => [connection.database],
            describe: async () => [],
            exportSql: (options) => aseSqlExport(connection, password, options),
          }),
        );
        try {
          const { id: _, ...input } = config();
          const connection = await app.connections.save(input);
          const request = {
            id: randomUUID(),
            connectionId: connection.id,
            database: connection.database,
            includeData,
          };
          const denied = await app.commands.dispatch('export.start', request, {
            kind: 'agent',
            id: 'test-agent',
            name: 'test',
          });
          expect(denied.success).toBe(false);
          expect(JSON.stringify(app.audit.list()[0])).toContain('read-only');
          const started = await app.commands.dispatch('export.start', request, HUMAN);
          expect(started.success).toBe(false);
          expect(started.error).toContain('read-only');
          expect(() => app.exports.status(request.id, HUMAN)).toThrow();
        } finally {
          await app.exports.shutdown();
          await app.connections.shutdown();
        }
      },
      15000,
    );
    it('streams exact JDBC values before restoring foreign keys and triggers', async () => {
      let sql = '';
      const progress: unknown[] = [];
      await aseSqlExport(config(), password, {
        ...options(),
        includeData: true,
        write: async (chunk) => {
          sql += chunk;
        },
        progress: (value) => progress.push(value),
      });
      expect(sql).toContain('9223372036854775806,12345678901234567890.123456789012345678');
      expect(sql).toContain("U&'\\4e2d\\6587\\+01f600\\0027\\005c\\000a\\0047\\004f\\000a\\0000'");
      expect(sql).toContain('0x0001ff');
      expect(sql).toContain("CONVERT(float,'4.9E-324')");
      expect(sql).toContain("CONVERT(bigdatetime,'20260930 23:59:59.123456')");
      expect(sql).toContain("CONVERT(bigtime,'23:59:59.654321')");
      expect(sql).toContain("CONVERT(date,'00010101')");
      expect(sql).toContain(',1,NULL)');
      expect(sql).toContain("'identity_burn_max',0,'9223372036854775807'");
      expect(sql.indexOf('INSERT INTO')).toBeLessThan(sql.indexOf('foreign key'));
      expect(sql.indexOf('INSERT INTO')).toBeLessThan(sql.indexOf('create trigger'));
      expect(progress.at(-1)).toEqual({ tables: 1, rows: 1 });
    }, 15000);
    it('cancels after taking locks and removes its worker directory', async () => {
      const directories = async () =>
        (await readdir(tmpdir()))
          .filter((name) => name.startsWith('database-workspace-ase-data-'))
          .sort();
      const before = await directories();
      const controller = new AbortController();
      await expect(
        aseSqlExport(config(), password, {
          ...options(),
          includeData: true,
          signal: controller.signal,
          progress: () => controller.abort(),
        }),
      ).rejects.toThrow('cancelled');
      expect(await directories()).toEqual(before);
    }, 15000);
    it.each([
      'lockfail',
      'missinglock',
      'predicated',
      'remote',
      'encrypted',
      'warning',
      'oversizedvalue',
      'tablechanged',
    ])(
      'rejects an incomplete JDBC export: %s',
      async (mode) => {
        await expect(
          aseSqlExport(config(mode), password, { ...options(), includeData: true }),
        ).rejects.toThrow();
      },
      15000,
    );
    it('detects schema changes while retaining the read transaction and cleans up a failed sink', async () => {
      const connection = config();
      const tools = { java: executable('java'), jdbc: join(directory, 'jconn4.jar') };
      const schema = 'use rental_test\ngo\ncreate table dbo.[資料表](id int)\ngo\n';
      let calls = 0;
      await expect(
        aseDataExport(
          connection,
          password,
          { ...options(), includeData: true },
          tools,
          async (options) => {
            await options.write(
              schema + (++calls === 3 ? 'create view dbo.changed as select 1\ngo\n' : ''),
            );
          },
        ),
      ).rejects.toThrow('schema changed');
      await expect(
        aseDataExport(
          connection,
          password,
          {
            ...options(),
            includeData: true,
            write: async () => {
              throw new Error('destination failed');
            },
          },
          tools,
          async (options) => {
            await options.write(schema);
          },
        ),
      ).rejects.toThrow('destination failed');
    }, 20000);
  },
);
