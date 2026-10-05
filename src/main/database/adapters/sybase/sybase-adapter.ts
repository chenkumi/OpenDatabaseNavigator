import type { Connection, TableRef } from '../../../../shared/types';
import type { SqlAdapter, QueryOptions } from '../../adapter';
import { ResultCollector } from '../network/common';
import { aseColumns, aseTables, aseSchemas, aseDatabases } from './sybase-catalog';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { nativeRelay } from '../network/native-relay';
import { SYBASE_READ_ONLY_REASON } from '../../../../shared/engine-capabilities';
import { assertAseReadOnly } from '../../../security/ase-readonly';
import { openAseJdbcSession } from './jdbc-session';
import { aseLegacySql } from './legacy-sql';

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
// Resolve this optional CommonJS native driver only when ASE ODBC is used.
// Its absence must not prevent building or using the other database engines.
const requireNativeDriver = createRequire(import.meta.url);

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
  // Older SAP drivers interpret braces on ordinary values literally.
  const value = (text: string) =>
    text === text.trim() && !/[;{}\u0000-\u001f\u007f]/.test(text) ? text : quote(text);
  return (
    [
      `Driver=${quote(connection.aseDriver || 'Adaptive Server Enterprise')}`,
      `Server=${value(relayPort === undefined ? connection.host || 'localhost' : '127.0.0.1')}`,
      `Port=${relayPort ?? connection.port ?? 5000}`,
      `Database=${value(connection.database || 'master')}`,
      `UID=${value(connection.username || '')}`,
      `PWD=${value(password || '')}`,
      // Do not request the Windows locale (Big5) from a legacy server.
      'CharSet=ServerDefault',
      'Language=us_english',
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
  aseMajorVersion?: number;
  private anchor?: AseSession;
  private opening?: Promise<void>;
  private generation = 0;
  private active = new Set<AbortController>();
  private operations = new Map<AbortController, Promise<void>>();
  private disconnecting?: Promise<void>;
  private beginOperation() {
    const controller = new AbortController();
    let complete!: () => void;
    this.operations.set(
      controller,
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    this.active.add(controller);
    return {
      controller,
      finish: () => {
        this.active.delete(controller);
        this.operations.delete(controller);
        complete();
      },
    };
  }
  private driver?: AseDriver;
  private transports = new Map<AseSession, Transport>();
  private closing = new WeakMap<AseSession, Promise<void>>();
  private pendingCloses = new Set<Promise<void>>();
  constructor(
    private connection: Connection,
    private password?: string,
    private loadDriver = async (): Promise<AseDriver> => {
      try {
        return requireNativeDriver('msnodesqlv8') as AseDriver;
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
  private close(session: AseSession): Promise<void> {
    const existing = this.closing.get(session);
    if (existing) return existing;
    const task = (async () => {
      if (this.anchor === session) {
        this.anchor = undefined;
        this.generation++;
      }
      const transport = this.transports.get(session);
      this.transports.delete(session);
      // Destroy actual I/O before asking the native queue to close a session.
      await transport?.relay.close();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('ASE session close cleanup timed out.')),
          1000,
        );
        try {
          session.close((error) => {
            clearTimeout(timer);
            if (error) reject(this.safeError(error));
            else resolve();
          });
        } catch (error) {
          clearTimeout(timer);
          reject(this.safeError(error));
        }
      });
    })();
    this.closing.set(session, task);
    this.pendingCloses.add(task);
    const settled = () => this.pendingCloses.delete(task);
    void task.then(settled, settled);
    return task;
  }
  private async open(timeout: number, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Query cancelled.');
    if (this.connection.charset)
      return openAseJdbcSession(this.connection, this.password, timeout, signal, this.relayFactory);
    const deadline = Date.now() + timeout;
    let transport: Transport | undefined;
    let ownedSession: AseSession | undefined;
    try {
      aseConnectionString(this.connection, this.password);
      this.driver ??= await this.loadDriver();
      // Plain native sessions also need a controllable socket boundary when
      // cancellation never releases its statement. Keep native TLS without I/O
      // deadlines on its existing certificate-verification path.
      if (this.connection.readTimeout || this.connection.writeTimeout || !this.connection.tls) {
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
              if (ownedSession && this.anchor === ownedSession)
                void this.close(ownedSession).catch(() => undefined);
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
              ownedSession = session;
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
    if (this.disconnecting) throw new Error('ASE connection is disconnecting.');
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
        const major = Number(
          /Adaptive Server Enterprise\/(\d+)\./i.exec(String(result.rows[0]?.version ?? ''))?.[1],
        );
        if (![11, 16].includes(major))
          throw new Error(
            'This read-only connection supports ASE 11.x and experimental ASE 16.x only.',
          );
        this.aseMajorVersion = major;
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
    if (this.disconnecting) return this.disconnecting;
    this.generation++;
    for (const controller of this.active) controller.abort();
    const operations = [...this.operations.values()];
    const task = (async () => {
      await this.opening?.catch(() => undefined);
      await Promise.all(operations);
      const anchor = this.anchor;
      this.anchor = undefined;
      if (anchor) void this.close(anchor).catch(() => undefined);
      // Idle transport failures can already have detached their anchor while
      // its native close is still pending. Include that background cleanup.
      const closed = await Promise.allSettled([...this.pendingCloses]);
      const failed = closed.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    this.disconnecting = task;
    try {
      await task;
    } finally {
      if (this.disconnecting === task) this.disconnecting = undefined;
    }
  }
  async heartbeat(timeout: number) {
    if (!this.anchor || this.disconnecting) throw new Error('ASE connection is closed.');
    const operation = this.beginOperation();
    const { controller } = operation;
    try {
      await this.run(this.anchor, 'SELECT 1', [], {
        limit: 1,
        timeout,
        readOnly: true,
        signal: controller.signal,
      });
    } finally {
      operation.finish();
    }
  }
  async exportSql(
    _options: import('../../../../shared/sql-export').SqlExportOptions,
  ): Promise<void> {
    throw new Error(SYBASE_READ_ONLY_REASON);
  }
  async query(sql: string, params: unknown[], options: QueryOptions) {
    if (!options.readOnly) throw new Error(SYBASE_READ_ONLY_REASON);
    assertAseReadOnly(sql);
    if (/^\s*EXPLAIN\b/i.test(sql))
      throw new Error('ASE EXPLAIN is not supported in this release.');
    if (this.disconnecting) throw new Error('ASE connection is disconnecting.');
    const generation = this.generation;
    const operation = this.beginOperation();
    const { controller } = operation;
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const deadline = Date.now() + options.timeout;
    let session: AseSession | undefined;
    try {
      if (controller.signal.aborted) throw new Error('Query cancelled.');
      await this.connect();
      if (controller.signal.aborted || generation !== this.generation)
        throw new Error('Query cancelled.');
      if (this.aseMajorVersion === 11) {
        sql = aseLegacySql(sql);
        assertAseReadOnly(sql);
      }
      session = await this.open(
        Math.min(this.connection.connectionTimeout ?? 10000, options.timeout),
        controller.signal,
      );
      if (controller.signal.aborted || generation !== this.generation)
        throw new Error('Query cancelled.');
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
        operation.finish();
      }
    }
  }
  async withScriptSession<T>(
    _task: (execute: import('../../script-session').ScriptExecute) => Promise<T>,
  ): Promise<T> {
    throw new Error(SYBASE_READ_ONLY_REASON);
  }
  async executeDdl(_statements: string[], _timeout: number): Promise<void> {
    throw new Error(SYBASE_READ_ONLY_REASON);
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
        cancelling = false,
        forcingClose = false;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (cancelling || ended) return;
        cancelling = true;
        cancelTimer = setTimeout(() => {
          // Cancellation may not emit free on SAP ODBC. Confirm closure of
          // the dedicated session instead; never return data just because
          // we requested cancellation or closed the relay socket.
          forcingClose = true;
          void this.close(session).then(finish, (error) => {
            failure ??= this.safeError(error);
            finish();
          });
        }, 1000);
        try {
          // Follow msnodesqlv8's stream cancellation contract: stop dispatching
          // rows now, but let the current native row/batch callback unwind before
          // cancel/free touches its handle (not synchronously inside 'row').
          query.pauseQuery();
          setImmediate(() => {
            if (ended) return;
            try {
              query.cancelQuery((error) => {
                // A capped read intentionally cancels; its ODBC cancellation
                // diagnostic is not a data error. Still require free or fail cleanup.
                if (error && !ended && !capped) failure ??= this.safeError(error);
              });
            } catch (error) {
              failure ??= this.safeError(error);
            }
          });
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
        clearTimeout(cancelTimer);
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
            stop();
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
          if (ended) return;
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
          if (ended) return;
          flush();
          row = Object.create(null) as Record<string, unknown>;
        });
        query.on('column', (index: number, value: unknown) => {
          if (ended || !row || failure || capped) return;
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
          if (ended) return;
          flush();
          if (!meta.length && count > 0) collector.result.affectedRows += count;
        });
        query.on('error', (error: unknown) => {
          if (ended) return;
          if (session.boundedReads || !capped || !options.readOnly)
            failure ??= this.safeError(error);
        });
        // During forced close, free alone is not confirmation that session.close
        // succeeded: wait for its callback before returning a capped page.
        query.on('free', () => {
          if (!forcingClose) finish();
        });
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
