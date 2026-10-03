import type {
  Column,
  Connection,
  QueryResult,
  TableInfo,
  TableRef,
} from '../../../../shared/types';
import type { QueryOptions, SqlAdapter } from '../../adapter';

export function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return value;
}
/** Rows are keyed by column name, so duplicate names would silently overwrite values. */
export function assertUniqueColumns(columns: string[]) {
  const seen = new Set<string>();
  for (const name of columns) {
    if (seen.has(name))
      throw new Error(
        `Result has duplicate column name "${name}". Add column aliases (AS) so every column is unique.`,
      );
    seen.add(name);
  }
}
export class ResultCollector {
  readonly result: QueryResult = {
    success: true,
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows: 0,
    duration: 0,
    hasMore: false,
  };
  private started = performance.now();
  private bytes = 0;
  constructor(
    private limit: number,
    private maxBytes = 8 * 1024 * 1024,
    private skip = 0,
  ) {}
  add(row: Record<string, unknown>) {
    if (this.skip > 0) {
      this.skip--;
      return true;
    }
    if (this.result.rows.length >= this.limit) {
      this.result.hasMore = true;
      return false;
    }
    const normalized = normalize(row) as Record<string, unknown>;
    const size = Buffer.byteLength(JSON.stringify(normalized));
    if (size > this.maxBytes)
      throw new Error(
        'A result row exceeds the 8 MiB response limit. Select smaller columns or values.',
      );
    if (this.bytes + size > this.maxBytes) {
      this.result.hasMore = true;
      return false;
    }
    this.bytes += size;
    this.result.rows.push(normalized);
    return true;
  }
  finish() {
    this.result.rowCount = this.result.rows.length;
    this.result.duration = performance.now() - this.started;
    return this.result;
  }
}
export abstract class NetworkSqlAdapter implements SqlAdapter {
  constructor(
    protected connection: Connection,
    protected password?: string,
  ) {}
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract query(sql: string, params: unknown[], options: QueryOptions): Promise<QueryResult>;
  protected async metadata(sql: string, params: unknown[] = []) {
    const result = await this.query(sql, params, { limit: 5000, timeout: 30000, readOnly: true });
    if (result.hasMore) throw new Error('Metadata exceeds 5000 objects. Narrow the schema scope.');
    return result.rows;
  }
  async databases(): Promise<string[]> {
    const sql =
      this.connection.engine === 'postgres'
        ? 'SELECT datname AS name FROM pg_database WHERE datallowconn ORDER BY datname'
        : this.connection.engine === 'mysql'
          ? 'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
          : 'SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name';
    return (await this.metadata(sql)).map((row) => String(row.name));
  }
  async schemas(): Promise<string[]> {
    if (this.connection.engine === 'mysql') return [this.connection.database];
    const sql =
      "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'pg_catalog') AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp_%' ORDER BY schema_name";
    return (await this.metadata(sql)).map((row) => String(row.name));
  }
  async tables(schema?: string): Promise<TableInfo[]> {
    const scope =
      schema ??
      (this.connection.engine === 'mysql'
        ? this.connection.database
        : this.connection.engine === 'postgres'
          ? 'public'
          : 'dbo');
    const bind =
      this.connection.engine === 'postgres'
        ? '$1'
        : this.connection.engine === 'mysql'
          ? '?'
          : '@p1';
    const rows = await this.metadata(
      `SELECT table_name AS name, table_schema AS schema_name, table_type AS kind FROM information_schema.tables WHERE table_schema = ${bind} ORDER BY table_name`,
      [scope],
    );
    return rows.map((row) => ({
      name: String(row.name),
      schema: String(row.schema_name),
      kind: row.kind === 'VIEW' ? 'view' : 'table',
    }));
  }
  async describe(ref: TableRef): Promise<Column[]> {
    const engine = this.connection.engine;
    const schema =
      ref.schema ??
      (engine === 'mysql' ? this.connection.database : engine === 'postgres' ? 'public' : 'dbo');
    const p = (index: number) =>
      engine === 'postgres' ? `$${index}` : engine === 'mysql' ? '?' : `@p${index}`;
    const generated =
      engine === 'postgres'
        ? "CASE WHEN c.is_generated='ALWAYS' THEN 1 ELSE 0 END"
        : engine === 'mysql'
          ? "CASE WHEN c.EXTRA LIKE '%VIRTUAL GENERATED%' OR c.EXTRA LIKE '%STORED GENERATED%' THEN 1 ELSE 0 END"
          : "COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.table_schema)+'.'+QUOTENAME(c.table_name)),c.column_name,'IsComputed')";
    const rows = await this.metadata(
      `SELECT ${generated} AS is_generated_column, c.column_name AS name, c.data_type AS data_type, c.is_nullable AS nullable, c.column_default AS default_value,
      CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k ON tc.constraint_name = k.constraint_name AND tc.constraint_schema = k.constraint_schema AND tc.table_name = k.table_name WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND k.column_name = c.column_name) THEN 1 ELSE 0 END AS primary_key
      FROM information_schema.columns c WHERE c.table_schema = ${p(1)} AND c.table_name = ${p(2)} ORDER BY c.ordinal_position`,
      [schema, ref.table],
    );
    return rows.map((row) => ({
      name: String(row.name),
      type: String(row.data_type),
      nullable: row.nullable === 'YES',
      defaultValue: row.default_value,
      primaryKey: Number(row.primary_key) === 1,
      generated: !!Number(row.is_generated_column),
    }));
  }
}
