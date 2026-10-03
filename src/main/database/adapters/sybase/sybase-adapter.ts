import type { Connection, TableRef } from '../../../../shared/types';
import type { SqlAdapter, QueryOptions } from '../../adapter';
import { ResultCollector } from '../network/common';
import { aseColumns, aseTables, aseSchemas, aseDatabases } from './sybase-catalog';
import { readFile } from 'node:fs/promises';
import { nativeRelay } from '../network/native-relay';
import { aseSqlExport } from './sql-export';
import { openAseJdbcSession } from './jdbc-session';

export interface AseQuery {
  on(event: string, callback: (...args: any[]) => void): unknown;
  cancelQuery(callback?: (error?: Error) => void): void;
  pauseQuery(): void;
  resumeQuery?(): void;
}
export interface AseSession {
  boundedReads?: boolean;
  setUseNumericString(value: boolean): void;
  queryRaw(
    query: {
      query_str: string;
      query_timeout: number;
      query_polling: boolean;
      query_max_rows?: number;
      query_mode?: 'script' | 'verify';
    },
    params: unknown[],
  ): AseQuery;
  close(callback: (error?: Error) => void): void;
}
export interface AseDriver {
  open(
    options: { conn_str: string; conn_timeout: number },
    callback: (error: Error | null, session?: AseSession) => void,
  ): void;
}
type Meta = { name: string; sqlType: string };
type Transport = {
  relay: Awaited<ReturnType<typeof nativeRelay>>;
  failure?: Error;
  failOperation?: (error: Error) => void;
};

export function aseConnectionString(connection: Connection, password?: string, relayPort?: number) {
  const quote = (value: string) => {
    if (value.includes('\0')) throw new Error('Invalid ASE connection value.');
    return `{${value.replaceAll('}', '}}')}}`;
  };
  if (connection.tls && !connection.aseTrustedFile?.trim())
    throw new Error('ASE TLS requires a trusted certificates file.');
  return (
    [
      `Driver=${quote(connection.aseDriver || 'Adaptive Server Enterprise')}`,
      `Server=${quote(relayPort === undefined ? connection.host || 'localhost' : '127.0.0.1')}`,
      `Port=${relayPort ?? connection.port ?? 5000}`,
      `Database=${quote(connection.database || 'master')}`,
      `UID=${quote(connection.username || '')}`,
      `PWD=${quote(password || '')}`,
      // SAP ODBC distinguishes the conversion mode from the application's
      // encoding. Native VARCHAR results are decoded as UTF-8 by the bridge.
      'CharSet=ClientDefault',
      `ClientCharset=${process.platform === 'win32' ? '65001' : 'utf8'}`,
      'CodePageType=Other',
      // This session is app-scoped; do not let driver failover leave the
      // monitored endpoint or replay work after a transport failure.
      ...(relayPort !== undefined ? ['HASession=0', 'RetryCount=0'] : []),
      ...(connection.tls && relayPort === undefined
        ? ['Encryption=ssl', `TrustedFile=${quote(connection.aseTrustedFile!)}`]
        : []),
    ].join(';') + ';'
  );
}

/** ASE uses the native ODBC bridge directly, never mssql's SQL Server batches. */
export class SybaseAdapter implements SqlAdapter {
  private anchor?: AseSession;
  private opening?: Promise<void>;
  private generation = 0;
  private active = new Set<AbortController>();
  private driver?: AseDriver;
  private transports = new Map<AseSession, Transport>();
  constructor(
    private connection: Connection,
    private password?: string,
    private loadDriver = async (): Promise<AseDriver> => {
      try {
        return (await import('msnodesqlv8')).default as unknown as AseDriver;
      } catch {
        throw new Error(
          'Sybase ASE requires the msnodesqlv8 native bridge and SAP ASE ODBC driver for this platform.',
        );
      }
    },
    private relayFactory = nativeRelay,
  ) {}

  private safeError(error: unknown) {
    const describe = (value: unknown): string =>
      Array.isArray(value)
        ? value.map(describe).join('; ')
        : value && typeof value === 'object' && 'message' in value
          ? String(value.message)
          : String(value);
    let message = describe(error);
    if (this.password) message = message.replaceAll(this.password, '[REDACTED]');
    message = message.replace(
      /(?:PWD|Password)\s*=\s*(?:\{(?:}}|[^}])*\}|[^;]*)/gi,
      'PWD=[REDACTED]',
    );
    return new Error(message.startsWith('ASE: ') ? message : `ASE: ${message}`);
  }
  private async close(session: AseSession) {
    const transport = this.transports.get(session);
    this.transports.delete(session);
    await transport?.relay.close();
    return new Promise<void>((resolve, reject) =>
      session.close((error) => (error ? reject(this.safeError(error)) : resolve())),
    );
  }
  private async open(timeout: number, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Query cancelled.');
    if (this.connection.charset)
      return openAseJdbcSession(this.connection, this.password, timeout, signal, this.relayFactory);
    const deadline = Date.now() + timeout;
    let transport: Transport | undefined;
    try {
      aseConnectionString(this.connection, this.password);
      this.driver ??= await this.loadDriver();
      if (this.connection.readTimeout || this.connection.writeTimeout) {
        const tls = this.connection.tls
          ? { ca: await readFile(this.connection.aseTrustedFile!) }
          : undefined;
        const relay = await this.relayFactory(
          {
            host: this.connection.host || 'localhost',
            port: this.connection.port ?? 5000,
            connectionTimeout: timeout,
            tls,
          },
          this.connection,
          (error) => {
            if (transport) {
              transport.failure ??= error;
              transport.failOperation?.(error);
            }
          },
        );
        transport = { relay };
      }
      if (signal?.aborted) {
        throw new Error('Query cancelled.');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('ASE connection timed out.');
      return await new Promise<AseSession>((resolve, reject) => {
        let ended = false;
        const finish = (error?: Error, session?: AseSession) => {
          if (ended) {
            if (session) void this.close(session).catch(() => undefined);
            return;
          }
          ended = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          error = transport?.failure ?? error;
          if (error) {
            if (session) void this.close(session).catch(() => undefined);
            reject(error);
          } else {
            try {
              session!.setUseNumericString(true);
              if (transport) {
                this.transports.set(session!, transport);
                transport.relay.pauseRead(true);
              }
              resolve(session!);
            } catch (error) {
              void this.close(session!).catch(() => undefined);
              reject(this.safeError(error));
            }
          }
        };
        const cancel = () => finish(new Error('Query cancelled.'));
        if (transport) transport.failOperation = (error) => finish(this.safeError(error));
        const timer = setTimeout(() => finish(new Error('ASE connection timed out.')), remaining);
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          this.driver!.open(
            {
              conn_str: aseConnectionString(this.connection, this.password, transport?.relay.port),
              conn_timeout: Math.max(1, Math.ceil(remaining / 1000)),
            },
            (error, session) =>
              finish(
                error
                  ? this.safeError(error)
                  : !session
                    ? new Error('ASE driver returned no connection.')
                    : undefined,
                session,
              ),
          );
        } catch (error) {
          finish(this.safeError(error));
        }
        if (signal?.aborted) cancel();
      });
    } catch (error) {
      await transport?.relay.close();
      throw this.safeError(error);
    } finally {
      if (transport) transport.failOperation = undefined;
    }
  }
  async connect() {
    if (this.anchor) return;
    if (this.opening) return this.opening;
    const generation = this.generation;
    const controller = new AbortController();
    this.active.add(controller);
    const attempt = (async () => {
      const session = await this.open(
        this.connection.connectionTimeout ?? 10000,
        controller.signal,
      );
      try {
        const result = await this.run(session, 'SELECT @@version AS version', [], {
          limit: 1,
          timeout: this.connection.connectionTimeout ?? 10000,
          readOnly: true,
          signal: controller.signal,
        });
        if (!/Adaptive Server Enterprise\/16\./i.test(String(result.rows[0]?.version ?? '')))
          throw new Error(
            'This connection supports SAP ASE 16.x, not SQL Anywhere, SAP IQ or Microsoft SQL Server.',
          );
        if (generation !== this.generation) throw new Error('Connection attempt was cancelled.');
        this.anchor = session;
      } catch (error) {
        await this.close(session).catch(() => undefined);
        throw error;
      }
    })();
    this.opening = attempt;
    try {
      await attempt;
    } finally {
      this.active.delete(controller);
      if (this.opening === attempt) this.opening = undefined;
    }
  }
  async disconnect() {
    this.generation++;
    for (const controller of this.active) controller.abort();
    await this.opening?.catch(() => undefined);
    const anchor = this.anchor;
    this.anchor = undefined;
    if (anchor) await this.close(anchor);
  }
  async heartbeat(timeout: number) {
    if (!this.anchor) throw new Error('ASE connection is closed.');
    await this.run(this.anchor, 'SELECT 1', [], { limit: 1, timeout, readOnly: true });
  }
  async exportSql(options: import('../../../../shared/sql-export').SqlExportOptions) {
    const controller = new AbortController();
    this.active.add(controller);
    try {
      await aseSqlExport(this.connection, this.password, {
        ...options,
        signal: AbortSignal.any([options.signal, controller.signal]),
      });
    } finally {
      this.active.delete(controller);
    }
  }
  async query(sql: string, params: unknown[], options: QueryOptions) {
    if (/^\s*EXPLAIN\b/i.test(sql))
      throw new Error('ASE EXPLAIN is not supported in this release.');
    await this.connect();
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    this.active.add(controller);
    const deadline = Date.now() + options.timeout;
    let session: AseSession | undefined;
    try {
      session = await this.open(
        Math.min(this.connection.connectionTimeout ?? 10000, options.timeout),
        controller.signal,
      );
      return await this.run(session, sql, params, {
        ...options,
        timeout: Math.max(1, deadline - Date.now()),
        signal: controller.signal,
      });
    } finally {
      options.signal?.removeEventListener('abort', abort);
      try {
        if (session) await this.close(session);
      } catch {
        // Closing is housekeeping: its failure must not turn a statement that already
        // ran into an error, nor hide the statement's own error.
      } finally {
        this.active.delete(controller);
      }
    }
  }
  async withScriptSession<T>(
    task: (execute: import('../../script-session').ScriptExecute) => Promise<T>,
  ): Promise<T> {
    await this.connect();
    const controller = new AbortController();
    this.active.add(controller);
    let session: AseSession | undefined;
    try {
      session = await this.open(this.connection.connectionTimeout ?? 10000, controller.signal);
      let verificationSignal = controller.signal;
      let verificationTimeout = this.connection.connectionTimeout ?? 10000;
      const result = await task(async (sql, signal, timeout) => {
        if (controller.signal.aborted) throw new Error('Script session is closed.');
        const combined = AbortSignal.any([signal, controller.signal]);
        verificationSignal = combined;
        verificationTimeout = Math.min(timeout, this.connection.connectionTimeout ?? 10000);
        await this.run(session!, sql, [], {
          limit: 0,
          timeout,
          readOnly: false,
          signal: combined,
          sessionMode: 'script',
        });
      });
      await this.verifyEncoding(session, verificationTimeout, verificationSignal);
      return result;
    } finally {
      try {
        if (session) await this.close(session);
      } catch {
        // Closing is housekeeping: its failure must not turn a statement that already
        // ran into an error, nor hide the statement's own error.
      } finally {
        this.active.delete(controller);
      }
    }
  }
  async executeDdl(statements: string[], timeout: number, options?: { rebuildTable?: string }) {
    if (options?.rebuildTable) throw new Error('ASE table rebuild plans are not supported.');
    await this.connect();
    const controller = new AbortController();
    this.active.add(controller);
    const deadline = Date.now() + timeout;
    let session: AseSession | undefined;
    const run = (sql: string) =>
      this.run(session!, sql, [], {
        limit: 0,
        timeout: Math.max(1, deadline - Date.now()),
        readOnly: false,
        signal: controller.signal,
        sessionMode: 'script',
      });
    try {
      session = await this.open(
        Math.min(timeout, this.connection.connectionTimeout ?? 10000),
        controller.signal,
      );
      if (statements.length > 1) await run('BEGIN TRANSACTION');
      try {
        for (const sql of statements) await run(sql);
        await this.verifyEncoding(session, Math.max(1, deadline - Date.now()), controller.signal);
        if (statements.length > 1) await run('COMMIT TRANSACTION');
      } catch (error) {
        if (statements.length > 1)
          await this.run(session, 'ROLLBACK TRANSACTION', [], {
            limit: 0,
            timeout: 5000,
            readOnly: false,
            sessionMode: 'script',
          }).catch(() => undefined);
        throw new Error(
          `ASE DDL failed. Multi-statement changes require the database ddl in tran option; refresh the definition before retrying. ${(error as Error).message}`,
        );
      }
    } finally {
      try {
        if (session) await this.close(session);
      } catch {
        // Closing is housekeeping: its failure must not turn a statement that already
        // ran into an error, nor hide the statement's own error.
      } finally {
        this.active.delete(controller);
      }
    }
  }
  private async verifyEncoding(session: AseSession, timeout: number, signal: AbortSignal) {
    if (this.connection.charset)
      await this.run(session, '', [], {
        limit: 0,
        timeout,
        readOnly: false,
        signal,
        sessionMode: 'verify',
      });
  }
  private run(
    session: AseSession,
    sql: string,
    params: unknown[],
    options: QueryOptions & { sessionMode?: 'script' | 'verify' },
  ) {
    if (options.signal?.aborted) return Promise.reject(new Error('Query cancelled.'));
    const transport = this.transports.get(session);
    if (transport?.failure) return Promise.reject(this.safeError(transport.failure));
    const collector = new ResultCollector(options.limit, undefined, options.offset);
    return new Promise<ReturnType<ResultCollector['finish']>>((resolve, reject) => {
      let query: AseQuery;
      let meta: Meta[] = [],
        row: Record<string, unknown> | undefined;
      let failure: Error | undefined,
        capped = false,
        ended = false,
        cancelling = false;
      const stop = () => {
        if (cancelling || ended) return;
        cancelling = true;
        try {
          query.pauseQuery();
          query.cancelQuery();
        } catch (error) {
          failure ??= this.safeError(error);
        }
      };
      const abort = () => {
        failure ??= new Error('Query cancelled.');
        stop();
      };
      const timer = setTimeout(() => {
        failure ??= new Error('Query timed out.');
        stop();
      }, options.timeout);
      const flush = () => {
        if (!row || failure || capped) {
          row = undefined;
          return;
        }
        try {
          if (!collector.add(row)) {
            capped = true;
            if (options.readOnly && !session.boundedReads) stop();
          }
        } catch (error) {
          failure = this.safeError(error);
          stop();
        }
        row = undefined;
      };
      const finish = () => {
        if (ended) return;
        ended = true;
        flush();
        clearTimeout(timer);
        if (transport) {
          transport.failOperation = undefined;
          transport.relay.pauseRead(true);
        }
        options.signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else resolve(collector.finish());
      };
      try {
        if (transport) {
          transport.failOperation = (error) => {
            failure ??= this.safeError(error);
            // Closing the upstream wakes the native read. A paused worker
            // must resume to observe it and release the statement handle.
            query?.resumeQuery?.();
          };
          transport.relay.pauseRead(false);
        }
        query = session.queryRaw(
          {
            query_str: sql,
            query_timeout: Math.max(1, Math.ceil(options.timeout / 1000)),
            query_polling: true,
            ...(session.boundedReads && options.sessionMode
              ? { query_mode: options.sessionMode }
              : {}),
            ...(session.boundedReads && options.readOnly
              ? { query_max_rows: Math.min(2147483647, (options.offset ?? 0) + options.limit + 1) }
              : {}),
          },
          params,
        );
        options.signal?.addEventListener('abort', abort, { once: true });
        query.on('meta', (columns: Meta[]) => {
          flush();
          if (collector.result.columns.length) {
            failure = new Error('ASE queries returning multiple result sets are not supported.');
            stop();
            return;
          }
          meta = columns;
          if (
            columns.some((column) =>
              ['decimal', 'money', 'smallmoney', 'sql_variant'].includes(column.sqlType),
            )
          ) {
            failure = new Error(
              'ASE ODBC cannot guarantee lossless decoding of this result type. Convert DECIMAL/MONEY/SQL_VARIANT columns to VARCHAR on the server. The statement may already have executed.',
            );
            stop();
            return;
          }
          collector.result.columns = columns.map(
            (column, index) => column.name || `column_${index + 1}`,
          );
          if (new Set(collector.result.columns).size !== columns.length) {
            failure = new Error('Use distinct aliases for duplicate result column names.');
            stop();
          }
        });
        query.on('row', () => {
          flush();
          row = Object.create(null) as Record<string, unknown>;
        });
        query.on('column', (index: number, value: unknown) => {
          if (!row || failure || capped) return;
          if (
            ['numeric', 'bigint'].includes(meta[index]?.sqlType) &&
            value !== null &&
            typeof value !== 'string'
          ) {
            failure = new Error('ASE driver returned an inexact numeric value.');
            stop();
            return;
          }
          row[collector.result.columns[index]] = value;
        });
        query.on('rowcount', (count: number) => {
          flush();
          if (!meta.length && count > 0) collector.result.affectedRows += count;
        });
        query.on('error', (error: unknown) => {
          if (session.boundedReads || !capped || !options.readOnly)
            failure ??= this.safeError(error);
        });
        // Wait for native handles to be released, including cancel/error paths.
        query.on('free', finish);
        if (options.signal?.aborted) abort();
      } catch (error) {
        failure = this.safeError(error);
        finish();
      }
    });
  }
  databases() {
    return aseDatabases(this);
  }
  schemas() {
    return aseSchemas(this);
  }
  tables(schema?: string) {
    return aseTables(this, schema);
  }
  async describe(ref: TableRef) {
    return (await aseColumns(this, ref)).columns;
  }
}
