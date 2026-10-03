import type { Column, Connection, QueryResult, TableInfo, TableRef } from '../../shared/types';
export interface QueryOptions {
  limit: number;
  offset?: number;
  timeout: number;
  readOnly: boolean;
  /**
   * The statement is verified to be a pure read, so the adapter may stop it once the
   * limit is reached even though the session is not read-only.
   */
  truncate?: boolean;
  signal?: AbortSignal;
}
export interface SqlAdapter {
  exportSql?(options: import('../../shared/sql-export').SqlExportOptions): Promise<void>;
  withScriptSession?<T>(
    task: (execute: import('./script-session').ScriptExecute) => Promise<T>,
  ): Promise<T>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Probe an existing session without reconnecting (for non-pooled adapters). */
  heartbeat?(timeout: number): Promise<void>;
  query(sql: string, params: unknown[], options: QueryOptions): Promise<QueryResult>;
  /** Internal object-edit plans only; all statements run on one session. */
  executeDdl?(
    statements: string[],
    timeout: number,
    options?: { rebuildTable?: string; validateViews?: boolean; recoveryStatements?: string[] },
  ): Promise<void>;
  databases(): Promise<string[]>;
  schemas(): Promise<string[]>;
  tables(schema?: string): Promise<TableInfo[]>;
  describe(ref: TableRef): Promise<Column[]>;
}
export type SqlAdapterFactory = (connection: Connection, password?: string) => SqlAdapter;
