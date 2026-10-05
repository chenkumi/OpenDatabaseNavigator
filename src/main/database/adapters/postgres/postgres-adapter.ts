import pg from 'pg';
import type { QueryOptions } from '../../adapter';
import { NetworkSqlAdapter, ResultCollector, assertUniqueColumns } from '../network/common';
import { scriptDeadline, type ScriptExecute } from '../../script-session';
import { postgresSqlExport } from './pg-dump';
import { postgresSocketTimeouts } from './socket-timeouts';
import { postgresEncodingClient } from './text-protocol';
class BoundedReadQuery extends pg.Query {
  handlePortalSuspended(connection: {
    close(value: { type: string; name: string }): void;
    sync(): void;
  }) {
    // Finish a bounded portal with Sync, rather than destroying the transport
    // before trailing ParameterStatus/error messages can be checked.
    connection.close({ type: 'P', name: '' });
    connection.sync();
  }
}
export class PostgresAdapter extends NetworkSqlAdapter {
  async exportSql(options: import('../../../../shared/sql-export').SqlExportOptions) {
    return postgresSqlExport(this.connection, this.password, options);
  }
  private pool?: pg.Pool;
  async withScriptSession<T>(task: (execute: ScriptExecute) => Promise<T>): Promise<T> {
    await this.connect();
    const client = await this.pool!.connect();
    let dead = false;
    const close = () => {
      if (!dead) {
        dead = true;
        client.release(true);
      }
    };
    try {
      return await task((sql, signal, timeout) => {
        if (dead) return Promise.reject(new Error('Script session is closed.'));
        return scriptDeadline(
          signal,
          timeout,
          close,
          () =>
            new Promise<void>((resolve, reject) => {
              const query = new pg.Query({
                text: sql,
                values: [],
                queryMode: 'extended',
              } as pg.QueryConfig);
              query.on('row', () => {});
              query.on('error', reject);
              query.on('end', () => resolve());
              client.query(query);
            }),
        );
      });
    } finally {
      close();
    }
  }
  async connect() {
    if (this.pool) return;
    const pool = new pg.Pool({
      Client: postgresEncodingClient(this.connection.charset || 'UTF8'),
      host: this.connection.host,
      port: this.connection.port ?? 5432,
      user: this.connection.username,
      password: this.password,
      database: this.connection.database || 'postgres',
      ssl: this.connection.tls ? { rejectUnauthorized: true } : false,
      max: 4,
      connectionTimeoutMillis: this.connection.connectionTimeout ?? 10000,
      idleTimeoutMillis: 30000,
      // date and timestamp (without time zone) carry no zone. Keep the server's
      // text instead of a Date in the app's local zone, matching MySQL.
      types: {
        getTypeParser: ((oid: number, format?: string) =>
          oid === 1082 || oid === 1114
            ? (value: string) => value
            : pg.types.getTypeParser(oid, format as 'text')) as never,
      },
    });
    pool.on('error', () => undefined);
    pool.on('connect', (client) => {
      // pg-pool drops its idle error listener while a client is checked out, and pg
      // emits transport failures on the Client; without a listener that is an
      // uncaught exception in the main process. Active queries still get the error.
      client.on('error', () => undefined);
      postgresSocketTimeouts(client, this.connection);
    });
    try {
      const client = await pool.connect();
      client.release();
      this.pool = pool;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  async disconnect() {
    const pool = this.pool;
    this.pool = undefined;
    await pool?.end();
  }
  async executeDdl(statements: string[], timeout: number) {
    await this.connect();
    const client = await this.pool!.connect();
    // A session whose ROLLBACK failed may still hold the transaction; never reuse it.
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeout)]);
      for (const text of statements)
        await client.query({ text, values: [], queryMode: 'extended' } as pg.QueryConfig);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.release(broken);
    }
  }
  async query(sql: string, params: unknown[], options: QueryOptions) {
    await this.connect();
    if (options.signal?.aborted) throw new Error('Query cancelled.');
    const client = await this.pool!.connect();
    const collector = new ResultCollector(options.limit, undefined, options.offset);
    let released = false;
    const release = (destroy = false) => {
      if (!released) {
        released = true;
        client.release(destroy);
      }
    };
    const processId = (client as unknown as { processID?: number }).processID;
    // Destroying the socket does not stop a running server statement, which
    // could still commit. Ask the server to cancel it from another session.
    const cancelServerSide = () => {
      if (processId)
        void this.pool?.query('SELECT pg_cancel_backend($1)', [processId]).catch(() => undefined);
    };
    try {
      if (options.signal?.aborted) throw new Error('Query cancelled.');
      if (options.readOnly) await client.query('BEGIN READ ONLY');
      if (options.signal?.aborted) throw new Error('Query cancelled.');
      const bounded = options.readOnly || options.truncate;
      return await new Promise<ReturnType<ResultCollector['finish']>>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          release(true);
          cancelServerSide();
          reject(error);
        };
        const onAbort = () => fail(new Error('Query cancelled.'));
        const timer = setTimeout(() => fail(new Error('Query timed out.')), options.timeout);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const config: pg.QueryConfig & { queryMode: 'extended'; rows?: number } = {
          text: sql,
          values: params,
          queryMode: 'extended',
          rows: bounded
            ? Math.min(2147483647, (options.offset ?? 0) + options.limit + 1)
            : undefined,
        };
        const query = bounded ? new BoundedReadQuery(config) : new pg.Query(config);
        let collecting = true;
        query.on('row', (row, result) => {
          if (settled) return;
          collector.result.columns = result?.fields.map((field) => field.name) ?? Object.keys(row);
          try {
            assertUniqueColumns(collector.result.columns);
            // Read-only portals fetch at most offset + limit + 1 rows, then
            // complete through ReadyForQuery to validate session parameters.
            if (collecting) collecting = collector.add(row);
          } catch (error) {
            fail(error as Error);
          }
        });
        query.on('error', fail);
        query.on('end', async (result) => {
          if (settled) return;
          try {
            collector.result.columns = result.fields.map((field) => field.name);
            collector.result.affectedRows = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(
              result.command,
            )
              ? (result.rowCount ?? 0)
              : 0;
            if (options.readOnly) await client.query('ROLLBACK');
            if (settled) return;
            settled = true;
            cleanup();
            // Arbitrary SQL may BEGIN or SET. Never return that session to the pool.
            release(!options.readOnly);
            resolve(collector.finish());
          } catch (error) {
            fail(error as Error);
          }
        });
        client.query(query);
      });
    } catch (error) {
      release(true);
      throw error;
    }
  }
}
