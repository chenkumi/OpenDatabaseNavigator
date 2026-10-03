import mssql from 'mssql';
import { installExactDecimals } from './exact-decimal';
import type { QueryOptions } from '../../adapter';
import { NetworkSqlAdapter, ResultCollector } from '../network/common';
import type { Connection, QueryResult } from '../../../../shared/types';
import { scriptDeadline, type ScriptExecute } from '../../script-session';
import { sqlServerSqlExport } from './sql-export';
import { sqlServerSocketTimeouts } from './socket-timeouts';
import { windowsConnectionString } from './transport';
import { installOdbcTimeouts } from './odbc-timeouts';
export { windowsConnectionString } from './transport';
export function bindSqlServerParameters(sql: string, count: number) {
  // ODBC reserves @P1, @P2, ... for positional bindings. SQL Server treats
  // those names case-insensitively, so mssql's DECLARE must use another prefix.
  return sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|\[(?:\]\]|[^\]])*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|(?<![@\w])@p(\d+)\b/gi,
    (token, index: string | undefined) =>
      index && Number(index) >= 1 && Number(index) <= count ? `@dw_param_${Number(index)}` : token,
  );
}
export class SqlServerAdapter extends NetworkSqlAdapter {
  async exportSql(options: import('../../../../shared/sql-export').SqlExportOptions) {
    return sqlServerSqlExport(this.connection, this.password, options);
  }
  async withScriptSession<T>(task: (execute: ScriptExecute) => Promise<T>): Promise<T> {
    const session = new SqlServerAdapter(this.connection, this.password, 1);
    let dead = false;
    try {
      await session.connect();
      return await task(async (sql, signal, timeout) => {
        if (dead) throw new Error('Script session is closed.');
        const Request = session.driver.Request as unknown as new (
          pool: mssql.ConnectionPool,
          overrides: { requestTimeout: number },
        ) => mssql.Request;
        const request = new Request(session.pool!, { requestTimeout: timeout });
        request.stream = true;
        let failure: Error | undefined;
        request.on('row', () => {});
        request.on('error', (error) => {
          failure ??= error;
        });
        await scriptDeadline(
          signal,
          timeout,
          () => {
            dead = true;
            request.cancel();
          },
          async () => {
            await request.batch(sql);
          },
        );
        if (failure) throw failure;
      });
    } finally {
      await session.disconnect();
    }
  }
  private pool?: mssql.ConnectionPool;
  private connecting?: Promise<void>;
  private generation = 0;
  private driver: typeof mssql = mssql;
  constructor(
    connection: Connection,
    password?: string,
    private poolSize = 4,
  ) {
    super(connection, password);
  }
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.pool) return;
    const generation = this.generation;
    const pending = this.openPool(generation);
    this.connecting = pending;
    try {
      await pending;
    } finally {
      if (this.connecting === pending) this.connecting = undefined;
    }
  }
  private async openPool(generation: number) {
    installExactDecimals();
    const integrated = this.connection.sqlServerAuth === 'windows';
    if (integrated) {
      if (process.platform !== 'win32')
        throw new Error('Windows authentication is only available on Windows.');
      try {
        this.driver = (await import('mssql/msnodesqlv8.js')).default;
      } catch {
        throw new Error(
          'Windows authentication requires the msnodesqlv8 native driver and Microsoft ODBC Driver 18 for SQL Server. Reinstall the Windows application or rebuild its native dependencies.',
        );
      }
    }
    const pool = new this.driver.ConnectionPool({
      server: this.connection.host ?? 'localhost',
      port: this.connection.port ?? 1433,
      ...(integrated
        ? {
            driver: 'ODBC Driver 18 for SQL Server',
            connectionString: windowsConnectionString(this.connection),
          }
        : { user: this.connection.username, password: this.password }),
      database: this.connection.database || 'master',
      connectionTimeout: this.connection.connectionTimeout ?? 10000,
      requestTimeout: 30000,
      pool: { max: this.poolSize, min: 0, idleTimeoutMillis: 30000 },
      ...(!integrated
        ? {
            beforeConnect: (client: unknown) =>
              sqlServerSocketTimeouts(client as import('tedious').Connection, this.connection),
          }
        : {}),
      options: {
        encrypt: this.connection.tls,
        trustServerCertificate: false,
        ...(integrated ? { trustedConnection: true } : {}),
      },
    });
    pool.on('error', () => undefined);
    if (integrated) installOdbcTimeouts(pool, this.connection);
    try {
      await pool.connect();
      if (this.generation !== generation) throw new Error('Connection attempt was cancelled.');
      this.pool = pool;
    } catch (error) {
      await pool.close();
      throw error;
    }
  }
  async disconnect() {
    this.generation++;
    const pool = this.pool;
    this.pool = undefined;
    await pool?.close();
    await this.connecting?.catch(() => {});
  }
  async executeDdl(statements: string[], timeout: number) {
    // Trigger module SET options belong to this edit, never the shared pool.
    const session = new SqlServerAdapter(this.connection, this.password, 1);
    try {
      await session.executeDdlSession(statements, timeout);
    } finally {
      await session.disconnect();
    }
  }
  private async executeDdlSession(statements: string[], timeout: number) {
    await this.connect();
    const transaction = new this.driver.Transaction(this.pool!);
    await transaction.begin();
    try {
      for (const sql of statements) {
        const request = new this.driver.Request(transaction);
        const timer = setTimeout(() => request.cancel(), timeout);
        try {
          await request.batch(sql);
        } finally {
          clearTimeout(timer);
        }
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }
  async query(sql: string, params: unknown[], options: QueryOptions): Promise<QueryResult> {
    const explain = /^\s*EXPLAIN\s+/i.exec(sql);
    if (explain) {
      // SHOWPLAN must be set in its own batch. A private one-connection pool
      // prevents plan mode from leaking to normal queries or other callers.
      const session = new SqlServerAdapter(this.connection, this.password, 1);
      try {
        await session.connect();
        await new session.driver.Request(session.pool!).query('SET SHOWPLAN_XML ON');
        return await session.query(sql.slice(explain[0].length), params, options);
      } finally {
        await session.disconnect();
      }
    }
    await this.connect();
    if (options.signal?.aborted) throw new Error('Query cancelled.');
    // mssql 12 documents the second constructor argument; its DefinitelyTyped
    // declarations have not yet exposed that overload.
    const Request = this.driver.Request as unknown as new (
      pool: mssql.ConnectionPool,
      overrides: { requestTimeout: number },
    ) => mssql.Request;
    const request = new Request(this.pool!, { requestTimeout: options.timeout });
    request.stream = true;
    sql = bindSqlServerParameters(sql, params.length);
    params.forEach((value, index) => request.input(`dw_param_${index + 1}`, value));
    const collector = new ResultCollector(options.limit, undefined, options.offset);
    let failure: Error | undefined;
    let capped = false;
    const cancel = () => {
      // msnodesqlv8 permits cancellation of paused streams; the mssql bridge
      // does not enable its native polling mode itself.
      if (this.connection.sqlServerAuth === 'windows') request.pause();
      request.cancel();
    };
    const abort = (message: string) => {
      failure = new Error(message);
      cancel();
    };
    const onAbort = () => abort('Query cancelled.');
    const timer = setTimeout(() => abort('Query timed out.'), options.timeout);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    request.on('recordset', (columns: mssql.IColumnMetadata) => {
      // msnodesqlv8 5.5 reads SQL_DECIMAL through SQL_C_DOUBLE even with
      // numeric_string enabled. The native rounding cannot be repaired here.
      // SQL_VARIANT does not expose its underlying type to this bridge.
      if (
        this.connection.sqlServerAuth === 'windows' &&
        Object.values(columns).some(
          (column) => column.type === this.driver.Decimal || column.type === this.driver.Variant,
        )
      ) {
        abort(
          'Windows SQL Server driver cannot return DECIMAL or SQL_VARIANT losslessly. Cast these result columns to NVARCHAR on the server, or use SQL Server password authentication. The statement may already have executed; do not retry writes blindly.',
        );
        return;
      }
      collector.result.columns = Object.keys(columns);
    });
    request.on('row', (row) => {
      if (failure || capped) return;
      try {
        if (!collector.add(row) && (options.readOnly || options.truncate)) {
          capped = true;
          cancel();
        }
      } catch (error) {
        failure = error as Error;
        cancel();
      }
    });
    request.on('rowsaffected', (count) => {
      collector.result.affectedRows += count;
    });
    request.on('error', (error) => {
      if (!capped && !failure) {
        failure = error;
        if (this.connection.sqlServerAuth === 'windows') cancel();
      }
    });
    try {
      await request.query(sql);
    } catch (error) {
      if (!capped || (error as { code?: string }).code !== 'ECANCEL') failure ??= error as Error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (failure) throw failure;
    return collector.finish();
  }
}
