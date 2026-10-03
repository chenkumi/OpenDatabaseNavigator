import { spawn, type ChildProcess } from 'node:child_process';
import type { Column, QueryResult, TableInfo, TableRef } from '../../../../shared/types';
import type { QueryOptions, SqlAdapter } from '../../adapter';
import type { ScriptExecute } from '../../script-session';
import { sqliteScriptSession } from './script-process';
import { sqliteSqlExport } from './export-process';

// A JS worker cannot interrupt SQLite inside a native call. A dedicated process
// keeps Electron responsive and can be killed before another session takes locks.
const processSource = String.raw`
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const normalize = value => typeof value === 'bigint' ? value.toString() : value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value;
process.on('disconnect', () => process.exit(0));
process.on('message', ({ id, action, payload }) => {
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
    process.send({ id, result });
  } catch (error) { process.send({ id, error: error.message }); }
});
process.send({ ready: true });
`;
export class SqliteAdapter implements SqlAdapter {
  async exportSql(options: import('../../../../shared/sql-export').SqlExportOptions) {
    return sqliteSqlExport(this.file, options);
  }
  async withScriptSession<T>(task: (execute: ScriptExecute) => Promise<T>): Promise<T> {
    return sqliteScriptSession(this.file, task);
  }
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private retiring?: Promise<void>;
  private exits = new WeakMap<ChildProcess, Promise<void>>();
  private serial: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  constructor(private file: string) {}
  async connect() {
    if (this.starting) return this.starting;
    if (this.child) return;
    const starting = this.startProcess();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }
  private async startProcess() {
    await this.retiring;
    const child = spawn(process.execPath, ['-e', processSource, this.file], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
    });
    this.child = child;
    this.exits.set(child, new Promise<void>((resolve) => {
      const exited = () => {
        if (this.child === child) this.child = undefined;
        resolve();
      };
      child.once('exit', exited);
      child.on('error', () => {
        // Only a failed spawn has no exit event. IPC errors on a live process
        // must not let its replacement race a still-held SQLite lock.
        if (!child.pid) exited();
      });
    }));
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        child.off('message', ready);
        child.off('error', fail);
        child.off('exit', exit);
      };
      const fail = (error: Error) => {
        clean();
        this.stopProcess(child);
        reject(error);
      };
      const exit = () => fail(new Error('SQLite process stopped during startup.'));
      const ready = (message: any) => {
        if (!message?.ready) return;
        clean();
        resolve();
      };
      const timer = setTimeout(() => fail(new Error('SQLite process startup timed out.')), 10_000);
      child.on('message', ready);
      child.once('error', fail);
      child.once('exit', exit);
    });
  }
  private stopProcess(child: ChildProcess) {
    if (this.child === child) this.child = undefined;
    // SIGKILL also interrupts a synchronous native call. Always wait for exit,
    // including reads, before opening a replacement connection to the same file.
    const stopping = this.exits.get(child)!;
    this.retiring = stopping;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    return stopping;
  }
  async disconnect() {
    const child = this.child;
    if (child) await this.stopProcess(child);
    await this.starting?.catch(() => {});
    // connect() may still have been awaiting the previous process's exit when
    // disconnect() started, and only have spawned its child in the meantime.
    if (this.child) await this.stopProcess(this.child);
    await this.retiring;
  }
  private request<T>(action: string, payload: unknown, options?: QueryOptions): Promise<T> {
    const run = async (): Promise<T> => {
      if (options?.signal?.aborted) throw new Error('Query cancelled.');
      await this.connect();
      if (options?.signal?.aborted) throw new Error('Query cancelled.');
      const child = this.child;
      if (!child?.connected) throw new Error('Database process stopped.');
      const id = ++this.sequence;
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const clean = () => {
          settled = true;
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('error', onError);
          child.off('exit', onExit);
          options?.signal?.removeEventListener('abort', onAbort);
        };
        const onMessage = (message: any) => {
          if (message?.id !== id) return;
          clean();
          message.error ? reject(new Error(message.error)) : resolve(message.result);
        };
        const onError = (error: Error) => {
          if (settled) return;
          clean();
          this.stopProcess(child);
          reject(error);
        };
        const onExit = () => onError(new Error('Database process stopped.'));
        const stop = (reason: string) => {
          clean();
          this.stopProcess(child);
          reject(new Error(reason));
        };
        const onAbort = () => stop('Query cancelled.');
        const timer = setTimeout(() => stop('Query timed out.'), options?.timeout ?? 30000);
        child.on('message', onMessage);
        child.once('error', onError);
        child.once('exit', onExit);
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        child.send({ id, action, payload }, (error) => {
          if (error) onError(error);
        });
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
