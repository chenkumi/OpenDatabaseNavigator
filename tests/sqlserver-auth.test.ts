import { afterEach, expect, it, vi } from 'vitest';
import mssql from 'mssql';
import { EventEmitter } from 'node:events';
import { connectionSchema } from '../src/shared/schemas';
import type { Connection } from '../src/shared/types';
import { ConnectionService } from '../src/main/application/services/connection-service';
import { MemoryStore } from '../src/main/application/services/store';
import { EventBus } from '../src/main/application/events/event-bus';
import {
  SqlServerAdapter,
  windowsConnectionString,
  bindSqlServerParameters,
} from '../src/main/database/adapters/sqlserver/sqlserver-adapter';

const base = {
  name: 'SQL Server',
  engine: 'sqlserver' as const,
  host: 'localhost',
  database: 'master',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture() {
  const secrets = new Map<string, string>();
  const adapter = { connect: vi.fn(), disconnect: vi.fn() };
  const factory = vi.fn((_connection: Connection, _password?: string) => adapter as any);
  const service = new ConnectionService(
    new MemoryStore<Connection[]>([]),
    {
      get: (id) => secrets.get(id),
      set: (id, value) => {
        secrets.set(id, value);
      },
      delete: (id) => {
        secrets.delete(id);
      },
    },
    factory,
    new EventBus(),
  );
  return { service, secrets, factory };
}
it('keeps legacy SQL password authentication as the default and validates the mode', () => {
  expect(connectionSchema.parse(base).sqlServerAuth).toBe('sql');
  expect(() => connectionSchema.parse({ ...base, sqlServerAuth: 'unsupported' })).toThrow();
});
it('removes SQL credentials when switching to Windows authentication and never passes them to the driver', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const { service, secrets, factory } = fixture();
  const saved = await service.save({ ...base, username: 'sql-user', password: 'old-password' });
  expect(secrets.get(saved.id)).toBe('old-password');
  const integrated = await service.save({
    ...saved,
    sqlServerAuth: 'windows',
    password: 'ignored-password',
  });
  expect(integrated.username).toBeUndefined();
  expect(secrets.has(saved.id)).toBe(false);
  await service.connect(saved.id, undefined, true);
  expect(factory.mock.calls.at(-1)?.[1]).toBeUndefined();
  await service.test({ ...integrated, username: 'ignored-user', password: 'ignored-password' });
  expect(factory.mock.calls.at(-1)?.[0]).not.toHaveProperty('username');
  expect(factory.mock.calls.at(-1)?.[1]).toBeUndefined();
  await service.save({
    ...integrated,
    sqlServerAuth: 'sql',
    username: 'sql-user',
    password: 'new-password',
  });
  expect(secrets.get(saved.id)).toBe('new-password');
});
it('rejects Windows authentication on other platforms and other database engines', async () => {
  const { service, factory } = fixture();
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  await expect(service.save({ ...base, sqlServerAuth: 'windows' })).rejects.toThrow(
    'only available on Windows',
  );
  await expect(service.test({ ...base, sqlServerAuth: 'windows' })).rejects.toThrow(
    'only available on Windows',
  );
  const adapter = new SqlServerAdapter({
    ...connectionSchema.parse(base),
    id: 'test',
    sqlServerAuth: 'windows',
  });
  await expect(adapter.connect()).rejects.toThrow('only available on Windows');
  expect(factory).not.toHaveBeenCalled();
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  await expect(
    service.save({ ...base, engine: 'postgres', sqlServerAuth: 'windows' }),
  ).rejects.toThrow('only available for SQL Server');
});
it('escapes ODBC values and preserves explicit instance and local protocol targets', () => {
  const connection = {
    ...connectionSchema.parse(base),
    id: 'test',
    sqlServerAuth: 'windows' as const,
  };
  expect(windowsConnectionString(connection)).toContain('Server={localhost,1433}');
  expect(windowsConnectionString({ ...connection, host: 'server\\instance' })).toContain(
    'Server={server\\instance};',
  );
  expect(windowsConnectionString({ ...connection, host: 'lpc:localhost' })).toContain(
    'Server={lpc:localhost};',
  );
  expect(
    windowsConnectionString({ ...connection, database: 'data};Trusted_Connection=No' }),
  ).toContain('Database={data}};Trusted_Connection=No};Trusted_Connection=Yes;');
});
it('renames bound parameters without rewriting literals, identifiers or comments', () => {
  expect(bindSqlServerParameters("SELECT @p1, @P2, '@p1', [@p1], @@p1, @p10 -- @p1", 2)).toBe(
    "SELECT @dw_param_1, @dw_param_2, '@p1', [@p1], @@p1, @p10 -- @p1",
  );
});

it('keeps the Windows server identity separate from a relayed TCP endpoint', () => {
  const connection = {
    ...connectionSchema.parse({
      ...base,
      host: 'tcp:db.example.test',
      sqlServerAuth: 'windows',
      sqlServerSpn: 'MSSQLSvc/db.example.test:1444',
      port: 1444,
      readTimeout: 1500,
      tls: true,
    }),
    id: 'spn',
  };
  const value = windowsConnectionString(connection, 45678);
  expect(value).toContain('Server={tcp:db.example.test,1444};');
  expect(value).toContain('Address={tcp:127.0.0.1,45678};');
  expect(value).toContain('ServerSPN={MSSQLSvc/db.example.test:1444};');
  expect(value).toContain('HostnameInCertificate={db.example.test};');
  expect(value).toContain('Encrypt=Yes;TrustServerCertificate=No;');
  expect(value).toContain('ConnectRetryCount=0;');
  expect(windowsConnectionString({ ...connection, sqlServerSpn: 'value};Encrypt=No' })).toContain(
    'ServerSPN={value}};Encrypt=No};',
  );
  for (const extra of [
    { sqlServerSpn: undefined },
    { sqlServerSpn: 'bad\0value' },
    { sqlServerSpn: 'x'.repeat(261) },
    { host: 'lpc:localhost' },
    { host: 'server\\instance' },
    { host: 'np:pipe' },
    { host: 'db,1444' },
    { sqlServerAuth: 'sql' },
    { engine: 'postgres' },
  ])
    expect(connectionSchema.safeParse({ ...connection, ...extra }).success).toBe(false);
  expect(
    connectionSchema.safeParse({
      ...connection,
      readTimeout: 0,
      host: 'lpc:localhost',
      sqlServerSpn: undefined,
    }).success,
  ).toBe(true);
});

it('closes the old Windows session when its SPN changes', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const { service } = fixture();
  const saved = await service.save({ ...base, sqlServerAuth: 'windows' });
  const handle = await service.connect(saved.id);
  await service.save({ ...saved, sqlServerSpn: 'MSSQLSvc/db.example.test:1433' });
  expect(service.status(saved.id).connected).toBe(false);
  await expect(handle.connect()).rejects.toThrow('disconnected');
  await expect(service.connect(saved.id)).rejects.toThrow('disconnected');
  await service.connect(saved.id, undefined, true);
  await service.shutdown();
});

it('shares pending pool creation and drains a cancelled login before reconnecting', async () => {
  let ready!: () => void;
  const closed = vi.fn(async () => {});
  const connect = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  class Pool extends EventEmitter {
    connect = connect;
    close = closed;
  }
  const factory = vi.spyOn(mssql, 'ConnectionPool').mockImplementation(Pool as any);
  const adapter = new SqlServerAdapter({ ...connectionSchema.parse(base), id: 'pending' });
  const first = adapter.connect();
  const second = adapter.connect();
  expect(factory).toHaveBeenCalledTimes(1);
  const rejected = Promise.all([
    expect(first).rejects.toThrow('cancelled'),
    expect(second).rejects.toThrow('cancelled'),
  ]);
  const disconnecting = adapter.disconnect();
  ready();
  await rejected;
  await disconnecting;
  expect(closed).toHaveBeenCalledTimes(1);
  await adapter.connect();
  expect(factory).toHaveBeenCalledTimes(2);
  await adapter.disconnect();
  expect(closed).toHaveBeenCalledTimes(2);
});

it.skipIf(process.platform !== 'win32' || process.env.TEST_WINDOWS_SQLSERVER !== '1')(
  'connects with the real Windows identity, queries parameters/metadata/EXPLAIN and reconnects',
  async () => {
    const connection = {
      ...connectionSchema.parse({
        ...base,
        host: process.env.WINDOWS_SQLSERVER_HOST || 'lpc:localhost',
      }),
      id: 'windows-real',
      sqlServerAuth: 'windows' as const,
    };
    const adapter = new SqlServerAdapter(connection);
    const options = { limit: 100, timeout: 5000, readOnly: true };
    const trace = (stage: string) => {
      if (process.env.WINDOWS_SQLSERVER_DEBUG) console.info(stage);
    };
    try {
      trace('connecting');
      await adapter.connect();
      trace('identity');
      const identity = await adapter.query(
        'SELECT auth_scheme FROM sys.dm_exec_connections WHERE session_id=@@SPID',
        [],
        options,
      );
      expect(['NTLM', 'KERBEROS']).toContain(identity.rows[0].auth_scheme);
      trace('parameters');
      const parameter = await adapter.query(
        'SELECT CAST(@p1 AS NVARCHAR(50)) AS value',
        ['Windows test'],
        options,
      );
      expect(parameter.rows).toEqual([{ value: 'Windows test' }]);
      await expect(
        adapter.query(
          "SELECT CAST('123456789012345.123456' AS DECIMAL(21,6)) AS value",
          [],
          options,
        ),
      ).rejects.toThrow('cannot return DECIMAL or SQL_VARIANT losslessly');
      for (const sql of [
        "SELECT CAST('123456789012345.123456' AS NUMERIC(21,6)) AS value",
        "SELECT CONVERT(NVARCHAR(50), CAST('123456789012345.123456' AS DECIMAL(21,6))) AS value",
      ])
        expect((await adapter.query(sql, [], options)).rows).toEqual([
          { value: '123456789012345.123456' },
        ]);
      trace('schemas');
      expect(await adapter.schemas()).toContain('dbo');
      trace('explain');
      expect((await adapter.query('EXPLAIN SELECT 1 AS value', [], options)).rowCount).toBe(1);
      await adapter.disconnect();
      trace('reconnect');
      expect((await adapter.query('SELECT 1 AS value', [], options)).rows[0].value).toBe(1);
      expect(
        await adapter.query('SELECT v FROM (VALUES (1),(2),(3)) AS x(v)', [], {
          ...options,
          limit: 1,
        }),
      ).toMatchObject({ rowCount: 1, hasMore: true });
      await expect(
        adapter.query('SELECT invalid_column_for_auth_test', [], options),
      ).rejects.toThrow();
      await expect(
        adapter.query("WAITFOR DELAY '00:00:02'; SELECT 1 AS value", [], {
          ...options,
          timeout: 100,
        }),
      ).rejects.toThrow(/timed out|canceled|cancelled/i);
      expect((await adapter.query('SELECT 2 AS alive', [], options)).rows[0].alive).toBe(2);
    } finally {
      await adapter.disconnect();
    }
  },
  30000,
);

it.skipIf(
  process.platform !== 'win32' ||
    process.env.TEST_WINDOWS_SQLSERVER !== '1' ||
    !process.env.WINDOWS_SQLSERVER_SPN,
)(
  'Windows TCP identity and deadlines cover adapter queries, scripts and DDL',
  async () => {
    const connection = {
      ...connectionSchema.parse({
        ...base,
        host: process.env.WINDOWS_SQLSERVER_HOST,
        port: Number(process.env.WINDOWS_SQLSERVER_PORT || 1433),
        sqlServerAuth: 'windows',
        sqlServerSpn: process.env.WINDOWS_SQLSERVER_SPN,
        readTimeout: 500,
        writeTimeout: 1000,
      }),
      id: 'windows-tcp',
    };
    const adapter = new SqlServerAdapter(connection);
    const options = { limit: 10, timeout: 5000, readOnly: true };
    try {
      await Promise.all([adapter.connect(), adapter.connect()]);
      const identity = await adapter.query(
        'SELECT auth_scheme FROM sys.dm_exec_connections WHERE session_id=@@SPID',
        [],
        options,
      );
      expect(['NTLM', 'KERBEROS']).toContain(identity.rows[0].auth_scheme);
      await expect(adapter.query("WAITFOR DELAY '00:00:02'", [], options)).rejects.toThrow(
        'Network read timed out',
      );
      await expect(adapter.executeDdl(["WAITFOR DELAY '00:00:02'"], 5000)).rejects.toThrow(
        'Network read timed out',
      );
      await expect(
        adapter.withScriptSession(async (execute) => {
          await execute('SELECT 1', new AbortController().signal, 5000);
          await execute("WAITFOR DELAY '00:00:02'", new AbortController().signal, 5000);
        }),
      ).rejects.toThrow('Network read timed out');
      expect((await adapter.query('SELECT 1 AS n', [], options)).rows[0].n).toBe(1);
    } finally {
      await adapter.disconnect();
    }
  },
  30000,
);

it('allows server connections without an initial database but requires a SQLite file', async () => {
  for (const engine of ['mysql', 'postgres', 'sqlserver', 'redis']) {
    expect(connectionSchema.parse({ name: 'Server', engine }).database).toBe('');
    expect(connectionSchema.parse({ name: 'Server', engine, database: '' }).database).toBe('');
  }
  expect(connectionSchema.safeParse({ name: 'File', engine: 'sqlite' }).success).toBe(false);
  expect(
    connectionSchema.safeParse({ name: 'File', engine: 'sqlite', database: '  ' }).success,
  ).toBe(false);
  const { service, factory } = fixture();
  const connection = await service.save({ ...base, database: '' });
  await service.test({ ...base, database: '' });
  await service.connect(connection.id);
  expect(factory).toHaveBeenCalledWith(expect.objectContaining({ database: '' }), undefined);
  expect(windowsConnectionString({ ...connection, sqlServerAuth: 'windows' })).toContain(
    'Database={master}',
  );
  await service.shutdown();
});
