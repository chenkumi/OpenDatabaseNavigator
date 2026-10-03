import type { DatabaseObjectDefinition, Engine, TableRef } from '../../shared/types';
import {
  indexOptionsSchema,
  type IndexCapabilities,
  type IndexOptions,
} from '../../shared/index-options';
import type { SqlAdapter } from './adapter';
import { SqlBuilder } from './sql-builder';
import { sqlTokens, keyword, objectHeader } from './object-sql';

async function rows(adapter: SqlAdapter, sql: string, params: unknown[] = []) {
  const r = await adapter.query(sql, params, { limit: 5000, timeout: 30000, readOnly: true });
  if (r.hasMore) throw new Error('Index metadata exceeds the supported size.');
  return r.rows;
}
export async function indexCapabilities(
  adapter: SqlAdapter,
  engine: Engine,
  ref: TableRef,
): Promise<IndexCapabilities> {
  const result: IndexCapabilities = {
    defaultMethod:
      engine === 'postgres'
        ? 'btree'
        : ['sqlserver', 'sybase'].includes(engine)
          ? 'NONCLUSTERED'
          : 'BTREE',
    types: ['NORMAL', 'UNIQUE'],
    methods: [],
    comment: ['mysql', 'postgres', 'sqlserver'].includes(engine),
  };
  if (engine === 'postgres')
    result.methods = (
      await rows(
        adapter,
        "SELECT amname,pg_indexam_has_property(oid,'can_unique') AS can_unique,pg_indexam_has_property(oid,'can_order') AS can_order FROM pg_am WHERE amtype='i' ORDER BY amname",
      )
    ).map((r) => ({ name: String(r.amname), unique: !!r.can_unique, ordered: !!r.can_order }));
  else if (engine === 'mysql') {
    const row = (
      await rows(
        adapter,
        'SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
        [ref.schema, ref.table],
      )
    )[0];
    if (!row?.engine) throw new Error('Select an existing target table.');
    const storage = String(row.engine).toUpperCase();
    result.methods = [{ name: 'BTREE', unique: true, ordered: true }];
    if (storage === 'MEMORY') {
      result.defaultMethod = 'HASH';
      result.methods.push({ name: 'HASH', unique: true, ordered: false });
    }
    if (['INNODB', 'MYISAM', 'ARIA'].includes(storage)) result.types.push('FULLTEXT', 'SPATIAL');
  } else if (engine === 'sqlserver' || engine === 'sybase')
    result.methods = ['NONCLUSTERED', 'CLUSTERED'].map((name) => ({
      name,
      unique: true,
      ordered: true,
    }));
  else if (engine === 'sqlite') result.methods = [{ name: 'BTREE', unique: true, ordered: true }];
  else result.types = [];
  return result;
}
export function validateIndexOptions(input: IndexOptions, caps: IndexCapabilities, engine: Engine) {
  const value = indexOptionsSchema.parse(input);
  if (value.type && !caps.types.includes(value.type))
    throw new Error('This index type is not supported for the target table.');
  const special = value.type === 'FULLTEXT' || value.type === 'SPATIAL';
  const method = caps.methods.find((m) => m.name === value.method);
  if (value.method && (special || !method))
    throw new Error('This index method is not supported for the selected type and table.');
  if (value.type === 'UNIQUE' && method && !method.unique)
    throw new Error('This index method does not support uniqueness.');
  if (value.comment !== undefined && !caps.comment)
    throw new Error('This engine does not support index comments.');
  if (
    value.comment &&
    ((engine === 'mysql' && [...value.comment].length > 1024) ||
      (engine === 'sqlserver' && Buffer.byteLength(value.comment, 'utf16le') > 7500))
  )
    throw new Error('The index comment exceeds the database limit.');
  return value;
}
export async function mysqlIndexSqlMode(adapter: SqlAdapter) {
  return String((await rows(adapter, 'SELECT @@SESSION.sql_mode AS sql_mode'))[0]?.sql_mode ?? '')
    .split(',')
    .includes('NO_BACKSLASH_ESCAPES');
}
function literal(value: string, engine: Engine, noBackslash = false) {
  let text = value.replaceAll("'", "''");
  if (engine === 'postgres' || (engine === 'mysql' && !noBackslash))
    text = text.replaceAll('\\', '\\\\');
  return `${engine === 'postgres' ? 'E' : engine === 'sqlserver' ? 'N' : ''}'${text}'`;
}
export async function readIndexMetadata(adapter: SqlAdapter, detail: DatabaseObjectDefinition) {
  detail.indexCapabilities = await indexCapabilities(adapter, detail.engine, detail);
  const tokens = sqlTokens(detail.editableSql, detail.engine, detail.mysqlNoBackslashEscapes);
  detail.indexOptions = {
    type: tokens.some((t) => keyword(t, 'UNIQUE')) ? 'UNIQUE' : 'NORMAL',
    method:
      detail.engine === 'postgres'
        ? 'btree'
        : detail.engine === 'sqlserver' || detail.engine === 'sybase'
          ? tokens.some((t) => keyword(t, 'CLUSTERED'))
            ? 'CLUSTERED'
            : 'NONCLUSTERED'
          : 'BTREE',
  };
  if (detail.engine === 'mysql') {
    const row = (
      await rows(
        adapter,
        'SELECT NON_UNIQUE AS non_unique,INDEX_TYPE AS index_type,INDEX_COMMENT AS comment FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=? ORDER BY SEQ_IN_INDEX',
        [detail.schema, detail.table, detail.name],
      )
    )[0];
    if (!row) throw new Error('Index metadata is unavailable.');
    const type = String(row.index_type).toUpperCase();
    detail.indexOptions = {
      type:
        type === 'FULLTEXT' || type === 'SPATIAL' || type === 'RTREE'
          ? type === 'FULLTEXT'
            ? 'FULLTEXT'
            : 'SPATIAL'
          : Number(row.non_unique)
            ? 'NORMAL'
            : 'UNIQUE',
      method: ['BTREE', 'HASH'].includes(type) ? type : '',
      comment: String(row.comment ?? ''),
    };
    detail.mysqlNoBackslashEscapes ??= await mysqlIndexSqlMode(adapter);
  } else if (detail.engine === 'postgres') {
    const row = (
      await rows(
        adapter,
        'SELECT i.indisunique,a.amname,obj_description(c.oid) AS comment FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_am a ON a.oid=c.relam WHERE n.nspname=$1 AND c.relname=$2',
        [detail.schema, detail.name],
      )
    )[0];
    if (!row) throw new Error('Index metadata is unavailable.');
    detail.indexOptions = {
      type: row.indisunique ? 'UNIQUE' : 'NORMAL',
      method: String(row.amname),
      comment: String(row.comment ?? ''),
    };
  } else if (detail.engine === 'sqlserver') {
    const row = (
      await rows(
        adapter,
        "SELECT i.is_unique,i.type_desc,CONVERT(nvarchar(max),e.value) AS comment FROM sys.indexes i LEFT JOIN sys.extended_properties e ON e.class=7 AND e.major_id=i.object_id AND e.minor_id=i.index_id AND e.name=N'MS_Description' WHERE i.object_id=OBJECT_ID(@p1) AND i.name=@p2",
        [new SqlBuilder('sqlserver').table(detail), detail.name],
      )
    )[0];
    if (!row) throw new Error('Index metadata is unavailable.');
    detail.indexOptions = {
      type: row.is_unique ? 'UNIQUE' : 'NORMAL',
      method: String(row.type_desc),
      comment: String(row.comment ?? ''),
    };
  }
}

// Change only header/options; key expressions, predicates, INCLUDE, storage and parser clauses remain intact.
export function rewriteIndexSql(
  sql: string,
  engine: Engine,
  patch: IndexOptions,
  noBackslash = false,
) {
  let tokens = sqlTokens(sql, engine, noBackslash);
  const index = tokens.findIndex(
    (t) => keyword(t, 'INDEX') || (engine === 'mysql' && keyword(t, 'KEY')),
  );
  if (index < 0) throw new Error('The index definition cannot be edited safely.');
  if (
    patch.type !== undefined ||
    (patch.method !== undefined && ['sqlserver', 'sybase'].includes(engine))
  ) {
    const type =
      patch.type ??
      (tokens.slice(0, index).some((t) => keyword(t, 'UNIQUE')) ? 'UNIQUE' : 'NORMAL');
    const method =
      patch.method ??
      (tokens.slice(0, index).some((t) => keyword(t, 'CLUSTERED')) ? 'CLUSTERED' : 'NONCLUSTERED');
    const header = `${type === 'NORMAL' ? '' : type + ' '}${['sqlserver', 'sybase'].includes(engine) ? method + ' ' : ''}`;
    sql =
      (engine === 'mysql' ? '' : sql.slice(0, tokens[0].end) + ' ') +
      header +
      sql.slice(tokens[index].start);
  }
  if (engine === 'postgres' && patch.method) {
    const h = objectHeader(sql, engine, 'index'),
      using = h.tokens.findIndex((t) => t.start >= h.tableEnd && keyword(t, 'USING'));
    sql =
      using < 0
        ? sql.slice(0, h.tableEnd) +
          ` USING ${new SqlBuilder(engine).quote(patch.method)}` +
          sql.slice(h.tableEnd)
        : sql.slice(0, h.tokens[using + 1].start) +
          new SqlBuilder(engine).quote(patch.method) +
          sql.slice(h.tokens[using + 1].end);
  }
  if (engine === 'mysql') {
    for (const field of ['method', 'comment'] as const) {
      if (patch[field] === undefined) continue;
      tokens = sqlTokens(sql, engine, noBackslash);
      let depth = 0;
      const at = tokens.findIndex((t) => {
        if (keyword(t, '(')) depth++;
        if (keyword(t, ')')) depth--;
        return depth === 0 && keyword(t, field === 'method' ? 'USING' : 'COMMENT');
      });
      const replacement =
        field === 'method'
          ? patch.method
            ? `USING ${patch.method}`
            : ''
          : `COMMENT ${literal(patch.comment!, 'mysql', noBackslash)}`;
      if (at >= 0)
        sql = sql.slice(0, tokens[at].start) + replacement + sql.slice(tokens[at + 1].end);
      else if (replacement) {
        const last = tokens.at(-1)!;
        const end = keyword(last, ';') ? last.start : last.end;
        sql = sql.slice(0, end) + ' ' + replacement + sql.slice(end);
      }
    }
  }
  return sql;
}
export function indexCommentStatements(
  engine: Engine,
  ref: TableRef & { name: string },
  comment: string,
) {
  const b = new SqlBuilder(engine),
    lit = (s: string) => literal(s, engine);
  if (engine === 'postgres')
    return [
      `COMMENT ON INDEX ${b.table({ schema: ref.schema, table: ref.name })} IS ${comment ? lit(comment) : 'NULL'}`,
    ];
  if (engine !== 'sqlserver') return [];
  const levels = `@name=N'MS_Description', @level0type=N'SCHEMA', @level0name=${lit(ref.schema!)}, @level1type=N'TABLE', @level1name=${lit(ref.table)}, @level2type=N'INDEX', @level2name=${lit(ref.name)}`;
  const exists = `EXISTS(SELECT 1 FROM sys.extended_properties e JOIN sys.indexes i ON i.object_id=e.major_id AND i.index_id=e.minor_id WHERE e.class=7 AND e.name=N'MS_Description' AND i.object_id=OBJECT_ID(${lit(b.table(ref))}) AND i.name=${lit(ref.name)})`;
  return [
    comment
      ? `IF ${exists} EXEC sys.sp_updateextendedproperty ${levels}, @value=${lit(comment)}; ELSE EXEC sys.sp_addextendedproperty ${levels}, @value=${lit(comment)}`
      : `IF ${exists} EXEC sys.sp_dropextendedproperty ${levels}`,
  ];
}
export async function createIndexStatements(
  adapter: SqlAdapter,
  engine: Engine,
  ref: TableRef & { name: string },
  columns: { name: string; descending: boolean }[],
  input: IndexOptions,
) {
  const caps = await indexCapabilities(adapter, engine, ref),
    options = validateIndexOptions(input, caps, engine);
  const special = ['FULLTEXT', 'SPATIAL'].includes(options.type ?? '');
  const method = options.method || (special ? '' : caps.defaultMethod);
  validateIndexOptions({ ...options, method }, caps, engine);
  const ordered = !special && caps.methods.find((m) => m.name === method)?.ordered;
  if (!ordered && columns.some((c) => c.descending))
    throw new Error('The selected index method does not support descending keys.');
  const b = new SqlBuilder(engine),
    q = (s: string) => b.quote(s);
  let sql = `CREATE ${!options.type || options.type === 'NORMAL' ? '' : options.type + ' '}${['sqlserver', 'sybase'].includes(engine) ? method + ' ' : ''}INDEX ${engine === 'sqlite' ? b.table({ schema: ref.schema, table: ref.name }) : q(ref.name)} ON ${engine === 'sqlite' ? q(ref.table) : b.table(ref)}${engine === 'postgres' ? ` USING ${q(method)}` : ''} (${columns.map((c) => q(c.name) + (ordered ? (c.descending ? ' DESC' : ' ASC') : '')).join(', ')})`;
  if (engine === 'mysql') {
    if (method) sql += ` USING ${method}`;
    if (options.comment !== undefined)
      sql += ` COMMENT ${literal(options.comment, engine, await mysqlIndexSqlMode(adapter))}`;
  }
  return [
    sql,
    ...(options.comment !== undefined ? indexCommentStatements(engine, ref, options.comment) : []),
  ];
}
