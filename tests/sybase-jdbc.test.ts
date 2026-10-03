import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { createServer as createTlsServer, rootCertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { connectionSchema } from '../src/shared/schemas';
import { ASE_ENCODINGS } from '../src/shared/client-encodings';
import { SybaseAdapter } from '../src/main/database/adapters/sybase/sybase-adapter';
import {
  openAseJdbcSession,
  aseJdbcParameter,
} from '../src/main/database/adapters/sybase/jdbc-session';

it('validates ASE encoding selection and does not coerce unsupported parameter values', () => {
  for (const { value } of ASE_ENCODINGS) {
    expect(
      connectionSchema.safeParse({ name: 'ASE', engine: 'sybase', charset: value }).success,
    ).toBe(false);
    expect(
      connectionSchema.safeParse({
        name: 'ASE',
        engine: 'sybase',
        charset: value,
        aseJconnectPath: 'C:/SAP/jconn4.jar',
      }).success,
    ).toBe(true);
  }
  expect(
    connectionSchema.safeParse({
      name: 'ASE',
      engine: 'sybase',
      charset: 'SQL_ASCII',
      aseJconnectPath: 'C:/SAP/jconn4.jar',
    }).success,
  ).toBe(false);
  for (const value of [NaN, Infinity, {}, ['a'], '\ud800', new Date(NaN)])
    expect(() => aseJdbcParameter(value)).toThrow();
  expect(aseJdbcParameter(null)).toBe('N');
  expect(aseJdbcParameter('')).toBe('S');
  expect(aseJdbcParameter(Buffer.alloc(0))).toBe('X');
});

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
describe.skipIf(!javaHome || compiler?.status !== 0)(
  'JDBC worker with real Java and our own contract driver (not SAP)',
  () => {
    let directory: string;
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'dw-ase-query-test-'));
      const classes = join(directory, 'classes');
      await mkdir(classes);
      const compiled = spawnSync(
        executable('javac'),
        [
          '-encoding',
          'UTF-8',
          '-d',
          classes,
          resolve('tests/fixtures/ase-query/SybDriver.java'),
          resolve('src/main/database/adapters/sybase/AseQuerySession.java'),
        ],
        { windowsHide: true, encoding: 'utf8' },
      );
      expect(compiled.status, compiled.stderr).toBe(0);
      const jar = spawnSync(
        executable('jar'),
        ['cf', join(directory, 'jconn4.jar'), '-C', classes, 'com'],
        { windowsHide: true, encoding: 'utf8' },
      );
      expect(jar.status, jar.stderr).toBe(0);
    }, 30000);
    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    const config = (charset = 'utf8', username = 'normal') => ({
      ...connectionSchema.parse({
        name: 'ASE test',
        engine: 'sybase',
        database: 'workspace',
        charset,
        username,
        aseJconnectPath: join(directory, 'jconn4.jar'),
        aseJavaPath: executable('java'),
      }),
      id: 'test',
    });
    const options = { limit: 2, timeout: 15000, readOnly: true };
    const workerDirs = async () =>
      (await readdir(tmpdir()))
        .filter((name) => name.startsWith('database-workspace-ase-session-'))
        .sort();

    it.each([
      ['utf8', '中文😀'],
      ['iso_1', 'café'],
      ['cp1252', '€ café'],
      ['big5', '繁體中文'],
      ['cp936', '简体中文'],
      ['gb18030', '简体中文😀'],
      ['sjis', '日本語'],
      ['eucjis', '日本語'],
    ])(
      'passes %s to JDBC and round-trips parameters without leaving session workers',
      async (charset, value) => {
        const before = await workerDirs();
        const adapter = new SybaseAdapter(config(charset), 'secret');
        try {
          const result = await adapter.query(
            'SELECT params',
            [
              value,
              '',
              null,
              Buffer.alloc(0),
              Buffer.from([0, 255]),
              true,
              1.25,
              9223372036854775807n,
            ],
            options,
          );
          expect(result.rows).toEqual([
            {
              p1: value,
              p2: '',
              p3: null,
              p4: '',
              p5: 'AP8=',
              p6: true,
              p7: '1.25',
              p8: '9223372036854775807',
            },
          ]);
          expect((await adapter.query('SELECT charset', [], options)).rows[0].value).toBe(charset);
          await adapter.heartbeat(15000);
        } finally {
          await adapter.disconnect();
        }
        expect(await workerDirs()).toEqual(before);
      },
      30000,
    );

    it('preserves exact values and bounded results, rejecting warnings even after the response limit', async () => {
      const adapter = new SybaseAdapter(config(), 'secret');
      try {
        expect((await adapter.query('SELECT exact', [], options)).rows[0]).toEqual({
          decimal: '12345678901234567890.123456789012345678',
          bigint: '9223372036854775807',
          中文: "中文😀\0'\n",
          empty: '',
          nullable: null,
          empty_binary: '',
          binary: 'AP8=',
          timestamp: '2026-09-30 23:59:59.123456',
          bit: true,
          float: 1.25,
        });
        const page = await adapter.query('SELECT many', [], { ...options, offset: 2 });
        expect(page.rows).toEqual([{ value: 3 }, { value: 4 }]);
        expect(page.hasMore).toBe(true);
        await expect(adapter.query('SELECT warning', [], options)).rejects.toThrow('truncated');
        await expect(adapter.query('SELECT unsupported', [], options)).rejects.toThrow(
          'Unsupported JDBC result type',
        );
        await expect(adapter.query('SELECT huge', [], options)).rejects.toThrow('8 MiB');
        await expect(adapter.query('SELECT switch_charset', [], options)).rejects.toThrow(
          'character set differs',
        );
        expect((await adapter.query('SELECT 1', [], options)).rows[0].value).toBe(1);
      } finally {
        await adapter.disconnect();
      }
    }, 30000);

    it('preserves SQL status globals between stateful script batches and DDL statements', async () => {
      const adapter = new SybaseAdapter(config(), 'secret');
      const signal = new AbortController().signal;
      const checkRows = "IF @@rowcount <> 2 RAISERROR 20000 'rowcount changed'";
      const checkError = "IF @@error <> 777 RAISERROR 20001 'error changed'";
      try {
        await adapter.withScriptSession(async (execute) => {
          await execute('UPDATE two', signal, 15000);
          await execute(checkRows, signal, 15000);
          await expect(execute('UPDATE fail', signal, 15000)).rejects.toThrow('fixture error 777');
          await execute(checkError, signal, 15000);
        });
        await adapter.executeDdl(['UPDATE two', checkRows], 15000);
      } finally {
        await adapter.disconnect();
      }
    }, 30000);

    it('verifies encoding at script completion and before DDL commit, and honors final cancellation', async () => {
      const adapter = new SybaseAdapter(config(), 'secret');
      const signal = new AbortController().signal;
      try {
        await expect(
          adapter.withScriptSession(async (execute) => {
            await execute('SELECT switch_charset', signal, 15000);
          }),
        ).rejects.toThrow('character set differs');
        await expect(
          adapter.executeDdl(['UPDATE two', 'SELECT switch_charset'], 15000),
        ).rejects.toThrow('character set differs');
        const controller = new AbortController();
        await expect(
          adapter.withScriptSession(async (execute) => {
            await execute('UPDATE two', controller.signal, 15000);
            controller.abort();
          }),
        ).rejects.toThrow(/cancelled/i);
        await adapter.heartbeat(15000);
      } finally {
        await adapter.disconnect();
      }
    }, 30000);

    it('keeps a script on one physical session and rejects lossy SQL/parameters before execution', async () => {
      const adapter = new SybaseAdapter(config('big5'), 'secret');
      try {
        const session = await openAseJdbcSession(config('big5'), 'secret', 15000);
        const raw = (sql: string, params: unknown[] = []) =>
          new Promise<unknown[]>((resolve, reject) => {
            const cells: unknown[] = [];
            let error: Error | undefined;
            let request;
            try {
              request = session.queryRaw(
                { query_str: sql, query_timeout: 15, query_polling: true },
                params,
              );
            } catch (reason) {
              reject(reason);
              return;
            }
            request.on('column', (_index: number, value: unknown) => cells.push(value));
            request.on('error', (reason: Error) => {
              error = reason;
            });
            request.on('free', () => (error ? reject(error) : resolve(cells)));
          });
        try {
          await raw('UPDATE sample');
          expect(await raw('SELECT state')).toEqual([1]);
          await expect(raw('SELECT params', ['😀'])).rejects.toThrow('statement was not sent');
          await expect(raw("SELECT '😀'")).rejects.toThrow('statement was not sent');
          await expect(raw('SET CHAR_CONVERT utf8')).rejects.toThrow('reconnect');
          expect(await raw('SELECT state')).toEqual([1]);
          await expect(raw('SELECT error')).rejects.toThrow('[REDACTED]');
          expect(await raw('SELECT state')).toEqual([1]);
        } finally {
          await new Promise<void>((resolve, reject) =>
            session.close((error) => (error ? reject(error) : resolve())),
          );
        }
        await adapter.withScriptSession(async (execute) => {
          await execute('UPDATE sample', new AbortController().signal, 15000);
          await execute('SELECT state', new AbortController().signal, 15000);
        });
      } finally {
        await adapter.disconnect();
      }
    }, 30000);

    it.each([false, true])(
      'owns TCP/TLS (%s) deadlines per JDBC session, leaving idle anchors usable',
      async (tls) => {
        const certPath = resolve('tests/fixtures/localhost-test-cert.pem');
        const cert = await readFile(certPath),
          key = await readFile('tests/fixtures/localhost-test-key.pem');
        const sockets = new Set<Socket>();
        const received: number[] = [];
        const accept = (socket: Socket) =>
          socket.on('data', (chunk: Buffer) => {
            received.push(...chunk);
            for (const value of chunk) if (value === 1) socket.write(Buffer.from([1]));
          });
        const server = tls ? createTlsServer({ cert, key }, accept) : createServer(accept);
        server.on('connection', (socket) => {
          sockets.add(socket);
          socket.on('error', () => {});
          socket.once('close', () => sockets.delete(socket));
        });
        server.on('tlsClientError', () => {});
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const adapter = new SybaseAdapter(
          {
            ...config('big5', 'network'),
            host: 'localhost',
            port: (server.address() as { port: number }).port,
            tls,
            aseTrustedFile: certPath,
            readTimeout: 300,
            writeTimeout: 300,
          },
          'secret',
        );
        try {
          await adapter.connect();
          await delay(500);
          await adapter.heartbeat(15000);
          await expect(adapter.query('SELECT network_wait', [], options)).rejects.toThrow(
            /read.*timed out/i,
          );
          await adapter.heartbeat(15000);
          expect(received.filter((value) => value === 2)).toHaveLength(1);
          expect((await adapter.query('SELECT params', ['繁體中文'], options)).rows[0].p1).toBe(
            '繁體中文',
          );
        } finally {
          await adapter.disconnect();
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      30000,
    );

    it('rejects an untrusted TLS endpoint before delivering worker login bytes', async () => {
      const server = createTlsServer({
        cert: await readFile('tests/fixtures/localhost-test-cert.pem'),
        key: await readFile('tests/fixtures/localhost-test-key.pem'),
      });
      const sockets = new Set<Socket>();
      let received = 0;
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => sockets.delete(socket));
      });
      server.on('secureConnection', (socket) =>
        socket.on('data', (chunk: Buffer) => {
          received += chunk.length;
        }),
      );
      server.on('tlsClientError', () => {});
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const ca = join(directory, 'unrelated-root.pem');
      await writeFile(ca, rootCertificates[0]);
      const adapter = new SybaseAdapter(
        {
          ...config('utf8', 'network'),
          host: 'localhost',
          port: (server.address() as { port: number }).port,
          tls: true,
          aseTrustedFile: ca,
        },
        'secret',
      );
      try {
        await expect(adapter.connect()).rejects.toThrow(/certificate|self.signed/i);
        expect(received).toBe(0);
      } finally {
        await adapter.disconnect();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 30000);

    it('cleans cancelled logins and active queries without poisoning the anchor or replaying work', async () => {
      const before = await workerDirs();
      await expect(openAseJdbcSession(config('utf8', 'loginhang'), 'secret', 1500)).rejects.toThrow(
        'timed out',
      );
      const adapter = new SybaseAdapter(config(), 'secret');
      try {
        await adapter.connect();
        const controller = new AbortController();
        const pending = adapter.query('SELECT hang', [], { ...options, signal: controller.signal });
        setTimeout(() => controller.abort(), 1800);
        await expect(pending).rejects.toThrow(/cancelled/i);
        await adapter.heartbeat(15000);
        await expect(
          adapter.query('SELECT hang', [], { ...options, timeout: 2500 }),
        ).rejects.toThrow(/timed out/i);
        expect((await adapter.query('SELECT 1', [], options)).rows).toEqual([{ value: 1 }]);
      } finally {
        await adapter.disconnect();
      }
      expect(await workerDirs()).toEqual(before);
    }, 30000);
  },
);
