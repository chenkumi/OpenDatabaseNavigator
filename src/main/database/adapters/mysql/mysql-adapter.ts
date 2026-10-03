import mysql from 'mysql2';
import type { QueryOptions } from '../../adapter';
import { NetworkSqlAdapter, ResultCollector, assertUniqueColumns } from '../network/common';
import { scriptDeadline, type ScriptExecute } from '../../script-session';
import { mysqlSqlExport } from './sql-export';
import { mysqlConnectionOptions } from './connection-options';
import { mysqlSocketTimeouts } from './socket-timeouts';
export class MysqlAdapter extends NetworkSqlAdapter {
  async exportSql(options: import('../../../../shared/sql-export').SqlExportOptions) {
    return mysqlSqlExport(this.connection, this.password, options);
  }
  private pool?: mysql.Pool;
  async withScriptSession<T>(task: (execute: ScriptExecute) => Promise<T>): Promise<T> {
    // SQL files are decoded to Unicode by the file reader. A dedicated UTF-8
    // session prevents a connection's legacy charset from replacing characters.
    const client = mysql.createConnection(
      mysqlConnectionOptions(this.connection, this.password, 'utf8mb4'),
    );
    mysqlSocketTimeouts(client, this.connection);
    let dead = false;
    client.on('error', () => {
      dead = true;
    });
    try {
      await new Promise<void>((resolve, reject) =>
        client.connect((error) => (error ? reject(error) : resolve())),
      );
      return await task((sql, signal, timeout) => {
        if (dead) return Promise.reject(new Error('Script session is closed.'));
        return scriptDeadline(
          signal,
          timeout,
          () => {
            dead = true;
            client.destroy();
          },
          () =>
            new Promise<void>((resolve, reject) => {
              const query = client.query(sql);
              query.on('result', () => {});
              query.on('error', (error) => {
                if ((error as { fatal?: boolean }).fatal) dead = true;
                reject(error);
              });
              query.on('end', () => resolve());
            }),
        );
      });
    } finally {
      client.destroy();
    }
  }
  async connect() {
    if (this.pool) return;
    const pool = mysql.createPool({
      ...mysqlConnectionOptions(this.connection, this.password),
      connectionLimit: 4,
    });
    pool.on('connection', (client) => mysqlSocketTimeouts(client, this.connection));
    try {
      await pool.promise().query('SELECT 1');
      this.pool = pool;
    } catch (error) {
      await pool.promise().end();
      throw error;
    }
  }
  async disconnect() {
    const pool = this.pool;
    this.pool = undefined;
    await pool?.promise().end();
  }
  async replaceObject(statements: string[], restore: string[], timeout: number) {
    await this.connect();
    const client = await this.pool!.promise().getConnection();
    let dropped = false;
    try {
      for (const sql of statements) {
        await client.query({ sql, timeout });
        if (/^DROP TRIGGER\b/i.test(sql)) dropped = true;
      }
    } catch (error) {
      if (dropped && restore.length) {
        try {
          for (const sql of restore) await client.query({ sql, timeout });
        } catch (recovery) {
          throw new Error(
            `Trigger replacement failed: ${(error as Error).message}. Restoration also failed: ${(recovery as Error).message}. The original trigger definition remains in the editor; restore it before resuming writes.`,
          );
        }
        throw new Error(
          `Trigger replacement failed; the original trigger was restored. ${(error as Error).message}`,
        );
      }
      throw error;
    } finally {
      // SET SESSION changes must never leak into another caller's connection.
      client.destroy();
    }
  }
  async executeDdl(
    statements: string[],
    timeout: number,
    options?: { recoveryStatements?: string[] },
  ) {
    if (options?.recoveryStatements?.length) {
      // Only the internal version-checked constraint planner supplies this recovery path.
      await this.connect();
      const client = await this.pool!.promise().getConnection();
      let dropped = false;
      try {
        for (const sql of statements) {
          await client.query({ sql, timeout });
          dropped = true;
        }
      } catch (error) {
        if (!dropped) throw error;
        try {
          for (const sql of options.recoveryStatements) await client.query({ sql, timeout });
        } catch (recovery) {
          throw new Error(
            `Constraint replacement failed: ${(error as Error).message}. Restoration also failed: ${(recovery as Error).message}. Use the recovery SQL from the preview to restore the original constraint before resuming writes.`,
          );
        }
        throw new Error(
          `Constraint replacement failed; the original constraint was restored. ${(error as Error).message}`,
        );
      } finally {
        client.destroy();
      }
      return;
    }
    if (statements.length !== 1)
      throw new Error('MySQL structure changes require one atomic DDL statement.');
    await this.query(statements[0], [], { timeout, readOnly: false, limit: 0 });
  }
  async query(sql: string, params: unknown[], options: QueryOptions) {
    await this.connect();
    if (options.signal?.aborted) throw new Error('Query cancelled.');
    const client = await new Promise<mysql.PoolConnection>((resolve, reject) =>
      this.pool!.getConnection((error, client) => (error ? reject(error) : resolve(client))),
    );
    const collector = new ResultCollector(options.limit, undefined, options.offset);
    const threadId = client.threadId;
    // Closing the socket does not stop a running statement: it could still commit,
    // or keep a CPU busy long after nobody wants its rows. Kill it from another session.
    const killStatement = () => {
      if (Number.isSafeInteger(threadId))
        this.pool?.query(`KILL QUERY ${threadId}`, () => undefined);
    };
    return new Promise<ReturnType<ResultCollector['finish']>>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        client.destroy();
        killStatement();
        reject(error);
      };
      const onAbort = () => fail(new Error('Query cancelled.'));
      const timer = setTimeout(() => fail(new Error('Query timed out.')), options.timeout);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const execute = () => {
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        const query = client.query(sql, params);
        query.on('fields', (fields?: mysql.FieldPacket[]) => {
          collector.result.columns = fields?.map((field) => field.name) ?? [];
          try {
            assertUniqueColumns(collector.result.columns);
          } catch (error) {
            fail(error as Error);
          }
        });
        query.on('result', (row: mysql.RowDataPacket | mysql.ResultSetHeader) => {
          if (settled) return;
          if (!collector.result.columns.length && 'affectedRows' in row) {
            collector.result.affectedRows += Number(row.affectedRows);
            return;
          }
          try {
            if (
              !collector.add(row as mysql.RowDataPacket) &&
              (options.readOnly || options.truncate)
            ) {
              settled = true;
              cleanup();
              client.destroy();
              killStatement();
              resolve(collector.finish());
            }
          } catch (error) {
            fail(error as Error);
          }
        });
        query.on('error', fail);
        query.on('end', () => {
          if (settled) return;
          const finish = (error?: Error | null) => {
            if (error) {
              fail(error);
              return;
            }
            if (settled) return;
            settled = true;
            cleanup();
            // Arbitrary SQL may execute USE, SET or BEGIN. Never return that
            // session to another tab/scope; a query is a stateless operation.
            if (options.readOnly) client.release();
            else client.destroy();
            resolve(collector.finish());
          };
          if (options.readOnly) client.query('ROLLBACK', finish);
          else finish();
        });
      };
      if (options.readOnly)
        client.query('START TRANSACTION READ ONLY', (error) => (error ? fail(error) : execute()));
      else execute();
    });
  }
}
