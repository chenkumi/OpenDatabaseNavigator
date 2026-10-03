import type { Connection, DatabaseObject } from '../../../shared/types';
import type { SqlAdapter } from '../../database/adapter';
import { aseObjects } from '../../database/adapters/sybase/sybase-catalog';

export interface ObjectFilter {
  schema?: string;
  table?: string;
  /** Compared case-insensitively so name-collision checks cannot be missed. */
  name?: string;
}
// Column expressions per engine and kind, used to narrow the query on the server
// instead of listing every index of the database and filtering in JavaScript.
const filterColumns = {
  sqlite: { schema: undefined, table: 'tbl_name', name: 'name' },
  'postgres:index': { schema: 'schemaname', table: 'tablename', name: 'indexname' },
  'postgres:trigger': { schema: 'n.nspname', table: 'c.relname', name: 't.tgname' },
  'mysql:index': { schema: 'TABLE_SCHEMA', table: 'TABLE_NAME', name: 'INDEX_NAME' },
  'mysql:trigger': { schema: 'TRIGGER_SCHEMA', table: 'EVENT_OBJECT_TABLE', name: 'TRIGGER_NAME' },
  'sqlserver:index': { schema: 's.name', table: 'o.name', name: 'i.name' },
  'sqlserver:trigger': { schema: 's.name', table: 'o.name', name: 't.name' },
} as const;
function narrow(
  sql: string,
  params: unknown[],
  connection: Connection,
  kind: 'index' | 'trigger',
  filter: ObjectFilter,
) {
  const columns =
    connection.engine === 'sqlite'
      ? filterColumns.sqlite
      : filterColumns[`${connection.engine}:${kind}` as keyof typeof filterColumns];
  const marker = (index: number) =>
    connection.engine === 'postgres'
      ? `$${index}`
      : connection.engine === 'sqlserver'
        ? `@p${index}`
        : '?';
  const predicates: string[] = [];
  const add = (column: string | undefined, value: string | undefined, lower = false) => {
    if (!column || value === undefined) return;
    params.push(value);
    predicates.push(
      lower
        ? `LOWER(${column}) = LOWER(${marker(params.length)})`
        : `${column} = ${marker(params.length)}`,
    );
  };
  add(columns?.schema, filter.schema);
  add(columns?.table, filter.table);
  add(columns?.name, filter.name, true);
  if (!predicates.length) return sql;
  // Search only after WHERE: MySQL's GROUP_CONCAT(... ORDER BY ...) comes earlier.
  const where = sql.indexOf(' WHERE ');
  if (where < 0) throw new Error('Metadata query cannot be narrowed.');
  const at = [' GROUP BY ', ' ORDER BY ']
    .map((word) => sql.indexOf(word, where))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (at === undefined) throw new Error('Metadata query cannot be narrowed.');
  return `${sql.slice(0, at)} AND ${predicates.join(' AND ')}${sql.slice(at)}`;
}

export async function listDatabaseObjects(
  adapter: SqlAdapter,
  connection: Connection,
  kind: 'index' | 'trigger',
  filter: ObjectFilter = {},
): Promise<DatabaseObject[]> {
  if (connection.engine === 'sybase') return aseObjects(adapter, kind);
  let sql: string;
  let params: unknown[] = [];
  if (connection.engine === 'sqlite') {
    sql =
      "SELECT name, 'main' AS schema_name, tbl_name AS table_name, sql AS definition FROM main.sqlite_schema WHERE type = ? ORDER BY name";
    params = [kind];
  } else if (connection.engine === 'postgres') {
    sql =
      kind === 'index'
        ? "SELECT indexname AS name, schemaname AS schema_name, tablename AS table_name, indexdef AS definition FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname, tablename, indexname"
        : "SELECT t.tgname AS name, n.nspname AS schema_name, c.relname AS table_name, pg_get_triggerdef(t.oid, true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY n.nspname,c.relname,t.tgname";
  } else if (connection.engine === 'mysql') {
    sql =
      kind === 'index'
        ? "SELECT INDEX_NAME AS name, TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, CONCAT(INDEX_TYPE, IF(NON_UNIQUE=0, ' UNIQUE', ''), ' (', GROUP_CONCAT(COALESCE(COLUMN_NAME,'expression') ORDER BY SEQ_IN_INDEX SEPARATOR ', '), ')') AS definition FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() GROUP BY INDEX_NAME,TABLE_SCHEMA,TABLE_NAME,INDEX_TYPE,NON_UNIQUE ORDER BY TABLE_NAME,INDEX_NAME"
        : "SELECT TRIGGER_NAME AS name, TRIGGER_SCHEMA AS schema_name, EVENT_OBJECT_TABLE AS table_name, CONCAT(ACTION_TIMING,' ',EVENT_MANIPULATION,': ',ACTION_STATEMENT) AS definition FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME";
  } else if (connection.engine === 'sqlserver') {
    sql =
      kind === 'index'
        ? "SELECT i.name, s.name AS schema_name, o.name AS table_name, i.type_desc AS definition FROM sys.indexes i JOIN sys.objects o ON o.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE i.name IS NOT NULL AND o.is_ms_shipped=0 AND o.type IN ('U','V') ORDER BY s.name,o.name,i.name"
        : "SELECT t.name, COALESCE(s.name,'') AS schema_name, COALESCE(o.name,'') AS table_name, OBJECT_DEFINITION(t.object_id) AS definition FROM sys.triggers t LEFT JOIN sys.objects o ON o.object_id=t.parent_id LEFT JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE t.is_ms_shipped=0 ORDER BY s.name,o.name,t.name";
  } else throw new Error('This engine does not support SQL index/trigger metadata.');
  sql = narrow(sql, params, connection, kind, filter);
  const result = await adapter.query(sql, params, { limit: 5000, timeout: 30000, readOnly: true });
  if (result.hasMore)
    throw new Error('Metadata exceeds the 5000-object limit. Narrow the schema or table scope.');
  return result.rows.map((row) => ({
    name: String(row.name),
    schema: String(row.schema_name ?? ''),
    table: String(row.table_name ?? ''),
    kind,
    definition: row.definition == null ? undefined : String(row.definition),
  }));
}
