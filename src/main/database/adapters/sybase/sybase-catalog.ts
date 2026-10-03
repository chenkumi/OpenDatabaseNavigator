import type { SqlAdapter } from '../../adapter';
import type {
  DatabaseObject,
  StructureColumn,
  TableInfo,
  TableRef,
} from '../../../../shared/types';
import { SqlBuilder } from '../../sql-builder';

const b = new SqlBuilder('sybase');
export async function aseRows(adapter: SqlAdapter, sql: string, params: unknown[] = []) {
  const result = await adapter.query(sql, params, { limit: 5000, timeout: 30000, readOnly: true });
  if (result.hasMore) throw new Error('ASE metadata exceeds the 5000-row limit.');
  return result.rows;
}
export async function aseDatabases(adapter: SqlAdapter) {
  return (await aseRows(adapter, 'SELECT name FROM master.dbo.sysdatabases ORDER BY name')).map(
    (row) => String(row.name),
  );
}
export async function aseSchemas(adapter: SqlAdapter) {
  return (
    await aseRows(
      adapter,
      "SELECT name FROM dbo.sysusers WHERE uid > 0 AND (suid >= 0 OR name = 'dbo') ORDER BY name",
    )
  ).map((row) => String(row.name));
}
export async function aseTables(adapter: SqlAdapter, schema?: string): Promise<TableInfo[]> {
  const rows = await aseRows(
    adapter,
    "SELECT o.name, u.name AS schema_name, o.type AS kind FROM dbo.sysobjects o JOIN dbo.sysusers u ON u.uid=o.uid WHERE o.type IN ('U','V')" +
      (schema ? ' AND u.name=?' : '') +
      ' ORDER BY u.name,o.name',
    schema ? [schema] : [],
  );
  return rows.map((row) => ({
    name: String(row.name),
    schema: String(row.schema_name),
    kind: row.kind === 'V' ? 'view' : 'table',
  }));
}
export async function aseDefinition(adapter: SqlAdapter, ref: TableRef) {
  const rows = await aseRows(
    adapter,
    'SELECT c.text FROM dbo.syscomments c JOIN dbo.sysobjects o ON o.id=c.id JOIN dbo.sysusers u ON u.uid=o.uid WHERE u.name=? AND o.name=? ORDER BY c.number,c.colid2,c.colid',
    [ref.schema || 'dbo', ref.table],
  );
  if (rows.some((row) => row.text == null))
    throw new Error('ASE did not return a complete object definition.');
  return rows.map((row) => String(row.text)).join('');
}
export function aseDefault(text: string) {
  const expression =
    /^\s*DEFAULT\s+([\s\S]+)$/i.exec(text)?.[1] ??
    /^\s*CREATE\s+DEFAULT\s+[\s\S]+?\s+AS\s+([\s\S]+)$/i.exec(text)?.[1];
  if (!expression && text.trim()) throw new Error('ASE default definition cannot be read safely.');
  return expression?.trim().replace(/;\s*$/, '') ?? '';
}
export async function aseColumns(adapter: SqlAdapter, ref: TableRef) {
  const target = b.table({ schema: ref.schema || 'dbo', table: ref.table });
  const raw = await aseRows(
    adapter,
    `SELECT c.name,t.name AS type,t.usertype,c.length,c.prec,c.scale,c.status,c.status2,c.computedcol,c.cdefault,c.domain
     FROM dbo.syscolumns c JOIN dbo.systypes t ON t.usertype=c.usertype JOIN dbo.sysobjects o ON o.id=c.id
     JOIN dbo.sysusers u ON u.uid=o.uid WHERE u.name=? AND o.name=? ORDER BY c.colid`,
    [ref.schema || 'dbo', ref.table],
  );
  const primary = await aseRows(
    adapter,
    "SELECT i.name,index_col(?,i.indid,v.number) AS column_name,v.number AS position FROM dbo.sysindexes i JOIN master.dbo.spt_values v ON v.type='P' AND v.number BETWEEN 1 AND i.keycnt WHERE i.id=object_id(?) AND (i.status & 2048)=2048 ORDER BY v.number",
    [target, target],
  );
  const defaults = await aseRows(
    adapter,
    'SELECT c.id,c.text FROM dbo.syscomments c WHERE c.id IN (SELECT cdefault FROM dbo.syscolumns WHERE id=object_id(?) AND cdefault<>0) ORDER BY c.id,c.number,c.colid2,c.colid',
    [target],
  );
  const texts = new Map<string, string>();
  for (const row of defaults)
    texts.set(String(row.id), (texts.get(String(row.id)) || '') + String(row.text ?? ''));
  // nchar/nvarchar lengths are stored in bytes; @@ncharsize is the server's bytes per character.
  const ncharSize = raw.some((row) => /^n(?:var)?char$/i.test(String(row.type)))
    ? Number((await aseRows(adapter, 'SELECT @@ncharsize AS size'))[0]?.size) || 1
    : 1;
  const columns: StructureColumn[] = raw.map((row) => {
    let type = String(row.type);
    if (/^(numeric|decimal)$/i.test(type)) type += `(${Number(row.prec)},${Number(row.scale)})`;
    else if (/^n(?:var)?char$/i.test(type))
      type += `(${Math.floor(Number(row.length) / ncharSize)})`;
    else if (/^(?:var)?(?:char|binary)$|^uni(?:char|varchar)$/i.test(type))
      type += `(${Number(row.length) / (/^uni/i.test(type) ? 2 : 1)})`;
    const text = texts.get(String(row.cdefault)) || '';
    if (Number(row.cdefault) && !text)
      throw new Error('ASE did not return a complete default definition.');
    const defaultSql = aseDefault(text);
    return {
      name: String(row.name),
      type,
      nullable: (Number(row.status) & 8) !== 0,
      primaryKey: primary.some((key) => key.column_name === row.name),
      generated:
        !!(Number(row.status) & 128) ||
        !!Number(row.computedcol) ||
        String(row.type) === 'timestamp',
      defaultValue: defaultSql || null,
      defaultSql,
    };
  });
  return {
    columns,
    primaryConstraint: primary[0]?.name as string | undefined,
    raw,
    primary: primary.filter((key) => key.column_name != null),
  };
}
export async function aseObjects(
  adapter: SqlAdapter,
  kind: 'index' | 'trigger',
): Promise<DatabaseObject[]> {
  const rows = await aseRows(
    adapter,
    kind === 'index'
      ? "SELECT i.name,u.name AS schema_name,o.name AS table_name FROM dbo.sysindexes i JOIN dbo.sysobjects o ON o.id=i.id JOIN dbo.sysusers u ON u.uid=o.uid WHERE o.type='U' AND i.indid>0 AND i.indid<255 ORDER BY u.name,o.name,i.name"
      : "SELECT tr.name,u.name AS schema_name,o.name AS table_name FROM dbo.sysobjects tr JOIN dbo.sysobjects o ON tr.deltrig=o.id JOIN dbo.sysusers u ON u.uid=tr.uid WHERE tr.type='TR' ORDER BY u.name,o.name,tr.name",
  );
  return rows.map((row) => ({
    name: String(row.name),
    schema: String(row.schema_name),
    table: String(row.table_name),
    kind,
    definition: kind === 'index' ? 'ASE index' : 'ASE trigger',
  }));
}
export async function aseIndex(
  adapter: SqlAdapter,
  ref: { schema: string; table: string; objectName: string },
) {
  const table = b.table(ref);
  const rows = await aseRows(
    adapter,
    "SELECT i.indid,i.status,i.status2,i.status3,i.segment,i.keycnt,i.fill_factor,i.res_page_gap,i.maxrowsperpage,i.exp_rowsize,i.partitiontype,i.conditionid,index_col(?,i.indid,v.number) AS column_name,index_colorder(?,i.indid,v.number) AS direction,v.number AS position FROM dbo.sysindexes i JOIN master.dbo.spt_values v ON v.type='P' AND v.number BETWEEN 1 AND i.keycnt WHERE i.id=object_id(?) AND i.name=? ORDER BY v.number",
    [table, table, table, ref.objectName],
  );
  const first = rows[0];
  if (!first) throw new Error('ASE index definition is unavailable.');
  const keys = rows
    .filter((row) => row.column_name != null)
    .map(
      (row) => `${b.quote(String(row.column_name))} ${row.direction === 'DESC' ? 'DESC' : 'ASC'}`,
    );
  if (!keys.length) throw new Error('ASE index keys are unavailable.');
  const sql = `CREATE ${Number(first.status) & 2 ? 'UNIQUE ' : ''}${Number(first.indid) === 1 || Number(first.status) & 16 ? 'CLUSTERED' : 'NONCLUSTERED'} INDEX ${b.quote(ref.objectName)} ON ${table} (${keys.join(', ')})`;
  // Only ordinary indexes on the default segment are eligible for rebuilding.
  const special =
    Number(first.status) & ~(2 | 16 | 128) ||
    Number(first.status2) & ~(4 | 512) ||
    Number(first.segment) !== 1 ||
    [
      'status3',
      'fill_factor',
      'res_page_gap',
      'maxrowsperpage',
      'exp_rowsize',
      'partitiontype',
      'conditionid',
    ].some((name) => Number(first[name]));
  return {
    sql,
    raw: rows,
    readOnlyReason: special
      ? 'ASE constraint or specialized indexes require engine-specific DDL.'
      : undefined,
  };
}
