import { it, expect } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { installOdbcTimeouts } from '../src/main/database/adapters/sqlserver/odbc-timeouts';
import { nativeRelay } from '../src/main/database/adapters/network/native-relay';
import { windowsConnectionString } from '../src/main/database/adapters/sqlserver/transport';
import { connectionSchema } from '../src/shared/schemas';
import { randomUUID } from 'node:crypto';

it.skipIf(process.platform !== 'win32' || process.env.DB_INTEGRATION !== '1')(
  'real ODBC transport deadlines isolate sessions, preserve paused/idle work, and cover transactions',
  async () => {
    const driver = (await import('mssql/msnodesqlv8.js')).default;
    const config = {
      ...connectionSchema.parse({
        name: 'ODBC I/O',
        engine: 'sqlserver',
        host: '127.0.0.1',
        port: 11433,
        database: 'master',
        sqlServerAuth: 'windows',
        sqlServerSpn: 'MSSQLSvc/database.test:11433',
        readTimeout: 400,
        writeTimeout: 200,
      }),
      id: 'odbc-io',
    };
    const poolConfig = {
      server: config.host!,
      connectionString: windowsConnectionString(config),
      connectionTimeout: 5000,
      requestTimeout: 5000,
      pool: { max: 3, min: 0 },
    };
    const pool = new driver.ConnectionPool(poolConfig);
    pool.on('error', () => {});
    const upstreams = new Set<Socket>();
    installOdbcTimeouts(pool, config, (target, timeouts, fail) =>
      nativeRelay(target, timeouts, fail, ((options: any) => {
        const socket = createConnection(options);
        upstreams.add(socket);
        socket.once('close', () => upstreams.delete(socket));
        return socket;
      }) as typeof createConnection),
    );
    // Docker has SQL password auth, not this Windows account. Exercise the
    // exact native ODBC transport/lifecycle with credentials only in the test.
    // The separate Windows test covers actual integrated identity.
    const nativeConfig = (
      pool as unknown as {
        config: { beforeConnect(config: { conn_str: string }): void; validateConnection: boolean };
      }
    ).config;
    const redirect = nativeConfig.beforeConnect;
    const authenticate = (options: { conn_str: string }) => {
      options.conn_str =
        options.conn_str.replace('Trusted_Connection=Yes;', 'Trusted_Connection=No;') +
        `UID={sa};PWD={${process.env.DB_TEST_PASSWORD!.replaceAll('}', '}}')}};`;
    };
    nativeConfig.beforeConnect = (options) => {
      redirect(options);
      expect(options.conn_str).toContain('HostnameInCertificate={127.0.0.1};');
      expect(options.conn_str).toContain('ServerSPN={MSSQLSvc/database.test:11433};');
      authenticate(options);
    };
    const table = 'dbo.dw_odbc_io_' + randomUUID().replaceAll('-', '');
    let created = false;
    try {
      await pool.connect();
      const query = (sql: string) => new driver.Request(pool).query(sql);
      expect((await query('SELECT 1 AS n')).recordset[0].n).toBe(1);
      await delay(600);
      expect((await query('SELECT 2 AS n')).recordset[0].n).toBe(2);
      await expect(query("WAITFOR DELAY '00:00:02'; SELECT 3 AS n")).rejects.toThrow(
        'Network read timed out',
      );
      expect((await query('SELECT 4 AS n')).recordset[0].n).toBe(4);
      const progress =
        "RAISERROR ('progress', 0, 1) WITH NOWAIT; WAITFOR DELAY '00:00:00.1';".repeat(8) +
        'SELECT 5 AS n';
      const [stalled, moving] = await Promise.allSettled([
        query("WAITFOR DELAY '00:00:02'"),
        query(progress),
      ]);
      expect(stalled.status).toBe('rejected');
      if (stalled.status === 'rejected')
        expect(stalled.reason.message).toContain('Network read timed out');
      expect(moving.status).toBe('fulfilled');
      const request = new driver.Request(pool);
      request.stream = true;
      let first = true;
      request.on('row', () => {
        if (!first) return;
        first = false;
        request.pause();
        setTimeout(() => request.resume(), 650);
      });
      let streamError: Error | undefined;
      request.on('error', (error) => {
        streamError = error;
      });
      await request.query("SELECT 6 AS n; WAITFOR DELAY '00:00:00.1'; SELECT 7 AS n");
      expect(first).toBe(false);
      expect(streamError).toBeUndefined();
      await query(`CREATE TABLE ${table} (n int)`);
      created = true;
      await expect(
        query(`INSERT INTO ${table} VALUES (1); WAITFOR DELAY '00:00:02'`),
      ).rejects.toThrow('Network read timed out');
      expect((await query(`SELECT COUNT(*) AS n FROM ${table}`)).recordset[0].n).toBe(1);
      const transaction = new driver.Transaction(pool);
      await transaction.begin();
      await delay(600);
      await expect(
        new driver.Request(transaction).batch("WAITFOR DELAY '00:00:02'"),
      ).rejects.toThrow('Network read timed out');
      await transaction.rollback().catch(() => {});
      expect((await query('SELECT 8 AS n')).recordset[0].n).toBe(8);
      nativeConfig.validateConnection = false;
      for (const socket of upstreams) socket.cork();
      await expect(query('SELECT 9 AS n')).rejects.toThrow('Network write timed out');
      expect((await query('SELECT 10 AS n')).recordset[0].n).toBe(10);
    } finally {
      try {
        if (created) await new driver.Request(pool).query(`DROP TABLE ${table}`);
      } finally {
        await pool.close();
        expect([...upstreams].every((socket) => socket.destroyed)).toBe(true);
      }
    }
    const tlsPool = new driver.ConnectionPool({ server: config.host!, connectionTimeout: 5000 });
    tlsPool.on('error', () => {});
    installOdbcTimeouts(tlsPool, { ...config, readTimeout: 2000, tls: true });
    const tlsNative = (tlsPool as unknown as { config: typeof nativeConfig }).config;
    const tlsRedirect = tlsNative.beforeConnect;
    tlsNative.beforeConnect = (options) => {
      tlsRedirect(options);
      expect(options.conn_str).toContain('Encrypt=Yes;TrustServerCertificate=No;');
      authenticate(options);
    };
    try {
      // Some Windows ODBC locales return a lossy ANSI diagnostic. The driver
      // retains its stable certificate/encryption help URL in that case.
      await expect(tlsPool.connect()).rejects.toThrow(
        /certificate|憑證|SSL Provider|linkid=2226722/i,
      );
    } finally {
      await tlsPool.close();
    }
  },
  25000,
);
