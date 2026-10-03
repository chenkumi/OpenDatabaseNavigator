import { Worker } from 'node:worker_threads';
import type { Column, QueryResult, TableInfo, TableRef } from '../../../../shared/types';
import type { QueryOptions, SqlAdapter } from '../../adapter';
import type { ScriptExecute } from '../../script-session';
import { sqliteScriptSession } from './script-process';
import { sqliteSqlExport } from './export-process';

// A separate thread keeps Electron responsive and permits hard cancellation of
// synchronous SQLite execution, including expensive recursive queries.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const normalize = value => typeof value === 'bigint' ? value.toString() : value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value;
parentPort.on('message', ({ id, action, payload }) => {
  try {
    let result;
    if (action === 'query') {
      const start = performance.now();
      db.exec('PRAGMA query_only = ' + (payload.readOnly ? 'ON' : 'OFF'));
      try {
        const statement = db.prepare(payload.sql);
        statement.setReadBigInts(true);
        const columns = statement.columns().map(column => column.name);
        if (new Set(columns).size !== columns.length) {
          const duplicate = columns.find((name, index) => columns.indexOf(name) !== index);
          throw new Error('Result has duplicate column name "' + duplicate + '". Add column aliases (AS) so every column is unique.');
        }
        const params = payload.params.map(value => typeof value === 'boolean' ? Number(value) : value);
        const rows = [];
        let affectedRows = 0, hasMore = false, skip = payload.offset || 0, bytes = 0;
        if (columns.length) {
          for (const row of statement.iterate(...params)) {
            if (skip > 0) { skip--; continue; }
            if (rows.length === payload.limit) { hasMore = true; break; }
            const normalized = Object.fromEntries(Object.entries(row).map(([key,value]) => [key,normalize(value)]));
            const size = Buffer.byteLength(JSON.stringify(normalized));
            if (size > 8*1024*1024) throw new Error('A result row exceeds the 8 MiB response limit. Select smaller columns or values.');
            if (bytes + size > 8*1024*1024) { hasMore = true; break; }
            bytes += size;
            rows.push(normalized);
          }
        } else affectedRows = Number(statement.run(...params).changes);
        result = { success: true, columns, rows, rowCount: rows.length, affectedRows, hasMore, duration: performance.now() - start };
      } finally { db.exec('PRAGMA query_only = OFF'); }
    } else if (action === 'ddl') {
      const rebuild = payload.rebuildTable;
      if (rebuild) db.exec('PRAGMA foreign_keys=OFF');
      try {
      db.exec('BEGIN IMMEDIATE');
      try {
        let sequence;
        if (rebuild && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {
          const statement = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?');
          statement.setReadBigInts(true);
          sequence = statement.get(rebuild)?.seq;
        }
        for (const sql of payload.statements) db.exec(sql);
        if (rebuild) {
          if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('The structure change violates foreign key constraints.');
          if (sequence !== undefined && db.prepare('SELECT 1 FROM sqlite_sequence WHERE name=?').get(rebuild))
            db.prepare('UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?').run(sequence,rebuild);
        }
        if (payload.validateViews) for (const view of db.prepare("SELECT name FROM sqlite_schema WHERE type='view'").all()) db.prepare('SELECT * FROM ' + quote(view.name) + ' LIMIT 0');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      } finally { if (rebuild) db.exec('PRAGMA foreign_keys=ON'); }
      result = true;
    } else if (action === 'databases') result = db.prepare('PRAGMA database_list').all().map(row => row.name);
    else if (action === 'schemas') result = ['main'];
    else if (action === 'tables') result = db.prepare("SELECT name, type FROM " + quote(payload.schema || 'main') + ".sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ name: row.name, kind: row.type, schema: payload.schema || 'main' }));
    else if (action === 'describe') result = db.prepare('PRAGMA ' + quote(payload.schema || 'main') + '.table_xinfo(' + quote(payload.table) + ')').all().filter(row => row.hidden !== 1).map(row => ({ name: row.name, type: row.type, nullable: !row.notnull && !row.pk, defaultValue: row.dflt_value, primaryKey: !!row.pk, generated: row.hidden === 2 || row.hidden === 3 }));
    else if (action === 'close') { db.close(); result = true; }
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
parentPort.postMessage({ ready: true });
`;
export class SqliteAdapter implements SqlAdapter {
  async exportSql(options: import('../../../../shared/sql-export').SqlExportOptions) {
    return sqliteSqlExport(this.file, options);
  }
  async withScriptSession<T>(task: (execute: ScriptExecute) => Promise<T>): Promise<T> {
    return sqliteScriptSession(this.file, task);
  }
  private worker?: Worker;
  // terminate() cannot interrupt a native SQLite call, so a stopped worker may keep
  // running (and holding locks) until the statement ends. Never start a second
  // thread against the same file while the old one is still stopping.
  private retiring?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  constructor(private file: string) {}
  async connect() {
    if (this.worker) return;
    const worker = new Worker(workerSource, { eval: true, workerData: { file: this.file } });
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', () => {
        worker.off('error', reject);
        resolve();
      });
    });
    this.worker = worker;
  }
  async disconnect() {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
  private async waitForRetiredWorker() {
    const retiring = this.retiring;
    if (!retiring) return;
    let timer: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
      retiring.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    clearTimeout(timer);
    if (!stopped)
      throw new Error('The previous SQLite statement is still stopping. Try again shortly.');
    if (this.retiring === retiring) this.retiring = undefined;
  }
  private request<T>(action: string, payload: unknown, options?: QueryOptions): Promise<T> {
    const run = async (): Promise<T> => {
      if (options?.signal?.aborted) throw new Error('Query cancelled.');
      await this.waitForRetiredWorker();
      await this.connect();
      const worker = this.worker!;
      const id = ++this.sequence;
      return new Promise<T>((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer);
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
          options?.signal?.removeEventListener('abort', onAbort);
        };
        const onMessage = (message: { id: number; error?: string; result: T }) => {
          if (message.id !== id) return;
          clean();
          message.error ? reject(new Error(message.error)) : resolve(message.result);
        };
        const onError = (error: Error) => {
          clean();
          if (this.worker === worker) this.worker = undefined;
          reject(error);
        };
        const onExit = () => onError(new Error('Database worker stopped.'));
        const stop = (reason: string) => {
          clean();
          if (this.worker === worker) this.worker = undefined;
          const stopping = worker.terminate().then(
            () => undefined,
            () => undefined,
          );
          // Only a statement that may write can still hold the file lock. A verified
          // read cannot block the next request, so it must not delay it.
          if (!(options?.readOnly || options?.truncate)) this.retiring = stopping;
          reject(new Error(reason));
        };
        const onAbort = () => stop('Query cancelled.');
        const timer = setTimeout(() => stop('Query timed out.'), options?.timeout ?? 30000);
        worker.on('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        worker.postMessage({ id, action, payload });
      });
    };
    const result = this.serial.then(run, run);
    this.serial = result.catch(() => undefined);
    return result;
  }
  query(sql: string, params: unknown[], options: QueryOptions) {
    return this.request<QueryResult>(
      'query',
      { sql, params, limit: options.limit, offset: options.offset, readOnly: options.readOnly },
      options,
    );
  }
  databases() {
    return this.request<string[]>('databases', {});
  }
  async executeDdl(
    statements: string[],
    timeout: number,
    options?: { rebuildTable?: string; validateViews?: boolean },
  ) {
    await this.request('ddl', { statements, ...options }, { limit: 0, timeout, readOnly: false });
  }
  schemas() {
    return this.request<string[]>('schemas', {});
  }
  tables(schema?: string) {
    return this.request<TableInfo[]>('tables', { schema });
  }
  describe(ref: TableRef) {
    return this.request<Column[]>('describe', ref);
  }
}
