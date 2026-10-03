import { randomUUID } from 'node:crypto';
import type { Engine, StructureColumn, StructurePlan, TableStructure } from '../../shared/types';
import type { PropertyChange, StructurePropertyOptions } from '../../shared/structure-properties';
import type { SqlAdapter } from './adapter';
import { SqlBuilder } from './sql-builder';
import { databaseOptions } from './create-database';
import { columnClause, tableClauses } from './structure-sql';
import { keyword, sqlTokens } from './object-sql';

const queryOptions = { limit: 10000, timeout: 30000, readOnly: true };
async function rows(adapter: SqlAdapter, sql: string, params: unknown[] = []) {
  const result = await adapter.query(sql, params, queryOptions);
  if (result.hasMore) throw new Error('Property catalog exceeds the supported size.');
  return result.rows;
}
export async function structurePropertyOptions(
  adapter: SqlAdapter,
  engine: Engine,
): Promise<StructurePropertyOptions> {
  const mysql = engine === 'mysql';
  const comment = ['mysql', 'postgres', 'sqlserver'].includes(engine);
  const result: StructurePropertyOptions = {
    table: { storageEngine: mysql, charset: mysql, collation: mysql, comment },
    column: {
      charset: mysql,
      collation: ['mysql', 'postgres', 'sqlserver', 'sqlite'].includes(engine),
      binary: mysql,
      comment,
    },
    storageEngines: [],
    charsets: [],
    collations: [],
    defaultCollations: {},
  };
  if (mysql || engine === 'sqlserver')
    Object.assign(result, await databaseOptions(engine, adapter));
  if (mysql) {
    result.storageEngines = (await rows(adapter, 'SHOW ENGINES'))
      .filter((row) => ['YES', 'DEFAULT'].includes(String(row.Support).toUpperCase()))
      .map((row) => String(row.Engine));
    for (const row of await rows(
      adapter,
      'SELECT CHARACTER_SET_NAME AS name, DEFAULT_COLLATE_NAME AS collation FROM information_schema.CHARACTER_SETS',
    ))
      result.defaultCollations[String(row.name)] = String(row.collation);
  } else if (engine === 'postgres') {
    result.collations = (
      await rows(
        adapter,
        `SELECT quote_ident(n.nspname)||'.'||quote_ident(c.collname) AS name
      FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace
      WHERE c.collencoding=-1 OR c.collencoding=(SELECT encoding FROM pg_database WHERE datname=current_database()) ORDER BY n.nspname,c.collname`,
      )
    ).map((row) => ({ name: String(row.name) }));
  } else if (engine === 'sqlite')
    result.collations = (await rows(adapter, 'PRAGMA collation_list')).map((row) => ({
      name: String(row.name),
    }));
  return result;
}

export function replaceColumnOption(
  clause: string,
  engine: Engine,
  property: 'charset' | 'collation' | 'comment',
  replacement: string,
) {
  const tokens = sqlTokens(clause, engine);
  let depth = 0;
  for (let i = 1; i < tokens.length; i++) {
    if (keyword(tokens[i], '(')) {
      depth++;
      continue;
    }
    if (keyword(tokens[i], ')')) {
      depth--;
      continue;
    }
    if (depth) continue;
    const matches =
      property === 'charset'
        ? keyword(tokens[i], 'CHARSET') ||
          (keyword(tokens[i], 'CHARACTER') && keyword(tokens[i + 1], 'SET'))
        : keyword(tokens[i], property === 'collation' ? 'COLLATE' : 'COMMENT');
    if (!matches) continue;
    let end = i + (property === 'charset' && keyword(tokens[i], 'CHARACTER') ? 2 : 1);
    if (keyword(tokens[end], '=')) end++;
    if (!tokens[end]) throw new Error('Incomplete column property declaration.');
    return [
      clause.slice(0, tokens[i].start).trimEnd(),
      replacement,
      clause.slice(tokens[end].end).trimStart(),
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [clause, replacement].filter(Boolean).join(' ');
}

export async function readPropertyMetadata(adapter: SqlAdapter, detail: TableStructure) {
  const b = new SqlBuilder(detail.engine),
    target = b.table(detail);
  let columnRows: Record<string, unknown>[] = [];
  if (detail.engine === 'mysql') {
    const table = (
      await rows(
        adapter,
        `SELECT ENGINE AS storage_engine,TABLE_COLLATION AS collation,TABLE_COMMENT AS comment FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=? AND TABLE_NAME=?`,
        [detail.schema, detail.table],
      )
    )[0];
    const available = await databaseOptions(detail.engine, adapter);
    detail.properties = {
      storageEngine: String(table?.storage_engine ?? ''),
      charset: available.collations.find((item) => item.name === table?.collation)?.charset ?? '',
      collation: String(table?.collation ?? ''),
      comment: String(table?.comment ?? ''),
    };
    detail.mysqlNoBackslashEscapes = String(
      (await rows(adapter, 'SELECT @@sql_mode AS sql_mode'))[0]?.sql_mode ?? '',
    )
      .split(',')
      .includes('NO_BACKSLASH_ESCAPES');
    columnRows = await rows(
      adapter,
      `SELECT COLUMN_NAME AS name,CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,COLUMN_COMMENT AS comment
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`,
      [detail.schema, detail.table],
    );
  } else if (detail.engine === 'postgres') {
    detail.properties = {
      comment: String(
        (
          await rows(
            adapter,
            `SELECT obj_description(c.oid,'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
            [detail.schema, detail.table],
          )
        )[0]?.comment ?? '',
      ),
    };
    columnRows = await rows(
      adapter,
      `SELECT a.attname AS name,col_description(c.oid,a.attnum) AS comment,
      CASE WHEN a.attcollation<>0 THEN quote_ident(cn.nspname)||'.'||quote_ident(co.collname) END AS collation
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
      WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [detail.schema, detail.table],
    );
  } else if (detail.engine === 'sqlserver') {
    const table = (
      await rows(
        adapter,
        `SELECT CONVERT(nvarchar(max),value) AS comment FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID(@p1) AND minor_id=0 AND name=N'MS_Description'`,
        [target],
      )
    )[0];
    detail.properties = { comment: String(table?.comment ?? '') };
    detail.commentExists = !!table;
    columnRows = await rows(
      adapter,
      `SELECT c.name,c.collation_name AS collation,CONVERT(nvarchar(max),e.value) AS comment,e.name AS comment_exists
      FROM sys.columns c LEFT JOIN sys.extended_properties e ON e.class=1 AND e.major_id=c.object_id AND e.minor_id=c.column_id AND e.name=N'MS_Description'
      WHERE c.object_id=OBJECT_ID(@p1) ORDER BY c.column_id`,
      [target],
    );
  } else if (detail.engine === 'sqlite') {
    const clauses = tableClauses(
      detail.definition,
      detail.engine,
      detail.mysqlNoBackslashEscapes,
    ).clauses;
    columnRows = detail.columns.map((column) => {
      const index = columnClause(clauses, column.name, detail.engine);
      const tokens = sqlTokens(clauses[index] ?? '', detail.engine);
      let depth = 0,
        collation = 'BINARY';
      for (let i = 1; i < tokens.length; i++) {
        if (keyword(tokens[i], '(')) depth++;
        else if (keyword(tokens[i], ')')) depth--;
        else if (!depth && keyword(tokens[i], 'COLLATE')) collation = tokens[i + 1].value;
      }
      return { name: column.name, collation };
    });
    detail.properties = {};
  } else {
    detail.properties = {};
  }
  detail.columns = detail.columns.map((column) => {
    const row = columnRows.find((row) => row.name === column.name);
    return {
      ...column,
      properties: {
        ...(row?.charset ? { charset: String(row.charset) } : {}),
        ...(row?.collation ? { collation: String(row.collation) } : {}),
        ...(['mysql', 'postgres', 'sqlserver'].includes(detail.engine)
          ? { comment: String(row?.comment ?? '') }
          : {}),
        ...(detail.engine === 'mysql' && row?.charset
          ? { binary: /_bin$/i.test(String(row.collation)) }
          : {}),
      },
      ...(detail.engine === 'sqlserver' ? { commentExists: !!row?.comment_exists } : {}),
    };
  });
}

export function propertyString(
  detail: Pick<TableStructure, 'engine' | 'mysqlNoBackslashEscapes'>,
  value: string,
) {
  if (value.includes('\0')) throw new Error('NUL is not allowed in SQL text.');
  let escaped = value.replaceAll("'", "''");
  if (
    detail.engine === 'postgres' ||
    (detail.engine === 'mysql' && !detail.mysqlNoBackslashEscapes)
  )
    escaped = escaped.replaceAll('\\', '\\\\');
  return `${detail.engine === 'sqlserver' ? 'N' : detail.engine === 'postgres' ? 'E' : ''}'${escaped}'`;
}

interface Details extends TableStructure {
  defaults: Record<string, string>;
  dependents: string[];
  sqliteRowid?: string;
}
function commentStatements(detail: Details, value: string, column?: StructureColumn) {
  const b = new SqlBuilder(detail.engine),
    q = (v: string) => b.quote(v),
    lit = (v: string) => propertyString(detail, v),
    target = b.table(detail);
  if (detail.engine === 'postgres')
    return [
      `COMMENT ON ${column ? `COLUMN ${target}.${q(column.name)}` : `TABLE ${target}`} IS ${value ? lit(value) : 'NULL'}`,
    ];
  // Extended property values are sql_variant, limited to 7500 bytes (as for index comments).
  if (detail.engine === 'sqlserver' && Buffer.byteLength(value, 'utf16le') > 7500)
    throw new Error('SQL Server comments are limited to 7500 bytes (about 3750 characters).');
  const exists = column ? column.commentExists : detail.commentExists;
  if (!exists && !value) return [];
  const procedure = value
    ? exists
      ? 'sp_updateextendedproperty'
      : 'sp_addextendedproperty'
    : 'sp_dropextendedproperty';
  return [
    `EXEC sys.${procedure} @name=N'MS_Description'${value ? `, @value=${lit(value)}` : ''}, @level0type=N'SCHEMA', @level0name=${lit(detail.schema)}, @level1type=N'TABLE', @level1name=${lit(detail.table)}${column ? `, @level2type=N'COLUMN', @level2name=${lit(column.name)}` : ''}`,
  ];
}

export async function planPropertyChange(
  adapter: SqlAdapter,
  detail: Details,
  change: PropertyChange,
): Promise<StructurePlan> {
  if (detail.kind !== 'table') throw new Error('Table properties require a table.');
  if (detail.readOnlyReason) throw new Error(detail.readOnlyReason);
  const options = await structurePropertyOptions(adapter, detail.engine);
  const column =
    change.action === 'column-properties'
      ? detail.columns.find((column) => column.name === change.column)
      : undefined;
  if (change.action === 'column-properties' && !column) throw new Error('Column no longer exists.');
  const current = column?.properties ?? detail.properties ?? {};
  const properties = { ...change.properties };
  const capabilities = column ? options.column : options.table;
  for (const [key, value] of Object.entries(properties)) {
    if (!(capabilities as unknown as Record<string, boolean>)[key])
      throw new Error(`This engine does not support the ${key} property here.`);
    if (
      value === (current as Record<string, unknown>)[key] &&
      !(
        ['collation', 'binary'].includes(key) &&
        properties.charset &&
        properties.charset !== current.charset
      )
    )
      delete (properties as Record<string, unknown>)[key];
  }
  if (!Object.keys(properties).length) throw new Error('There are no property changes.');
  const charset = properties.charset ?? current.charset;
  let collation = properties.collation;
  const binary = 'binary' in properties ? properties.binary : undefined;
  if (properties.charset && !options.charsets.includes(properties.charset))
    throw new Error('The character set is not available on this server.');
  if (
    column &&
    (properties.charset || properties.collation || binary !== undefined) &&
    !column.properties?.collation
  )
    throw new Error('This column type does not support character properties.');
  if (binary !== undefined) {
    const selected = binary
      ? options.collations.find((c) => c.charset === charset && c.name === `${charset}_bin`)?.name
      : options.defaultCollations[charset ?? ''];
    if (!selected)
      throw new Error('This character set does not provide the requested comparison mode.');
    if (collation && collation !== selected)
      throw new Error('Binary comparison conflicts with the selected collation.');
    collation = selected;
  }
  if (collation) {
    const selected = options.collations.find((item) => item.name === collation);
    if (!selected || (detail.engine === 'mysql' && selected.charset !== charset))
      throw new Error('Choose a collation belonging to the selected character set.');
  }
  if (
    'storageEngine' in properties &&
    properties.storageEngine &&
    !options.storageEngines.includes(properties.storageEngine)
  )
    throw new Error('The storage engine is not available on this server.');
  const b = new SqlBuilder(detail.engine),
    q = (s: string) => b.quote(s),
    target = b.table(detail),
    lit = (v: string) => propertyString(detail, v);
  const plan: StructurePlan = {
    statements: [],
    atomic: !['mysql', 'sybase'].includes(detail.engine),
    destructive: !!(
      properties.charset ||
      collation ||
      ('storageEngine' in properties && properties.storageEngine)
    ),
  };
  if (detail.engine === 'mysql') {
    const clauses: string[] = [];
    if (column) {
      const parsed = tableClauses(detail.definition, detail.engine, detail.mysqlNoBackslashEscapes);
      const index = columnClause(parsed.clauses, column.name, detail.engine);
      if (index < 0) throw new Error('The column definition cannot be edited safely.');
      let clause = parsed.clauses[index];
      if (properties.charset) {
        clause = replaceColumnOption(
          clause,
          detail.engine,
          'charset',
          `CHARACTER SET ${q(properties.charset)}`,
        );
        clause = replaceColumnOption(clause, detail.engine, 'collation', '');
      }
      if (collation)
        clause = replaceColumnOption(clause, detail.engine, 'collation', `COLLATE ${q(collation)}`);
      if (properties.comment !== undefined)
        clause = replaceColumnOption(
          clause,
          detail.engine,
          'comment',
          `COMMENT ${lit(properties.comment)}`,
        );
      clauses.push(`MODIFY COLUMN ${clause}`);
    } else {
      if ('storageEngine' in properties && properties.storageEngine)
        clauses.push(`ENGINE=${q(properties.storageEngine)}`);
      if (properties.charset) clauses.push(`DEFAULT CHARACTER SET ${q(properties.charset)}`);
      if (collation) clauses.push(`DEFAULT COLLATE ${q(collation)}`);
      if (properties.comment !== undefined) clauses.push(`COMMENT=${lit(properties.comment)}`);
      if (properties.charset || collation)
        plan.notice =
          'Table character defaults apply to newly added columns. Change each existing column explicitly to convert its data.';
    }
    plan.statements = [`ALTER TABLE ${target} ${clauses.join(', ')}`];
  } else {
    if (properties.comment !== undefined)
      plan.statements.push(...commentStatements(detail, properties.comment, column));
    if (column && collation) {
      if (detail.engine === 'sqlite') {
        const parsed = tableClauses(
          detail.definition,
          detail.engine,
          detail.mysqlNoBackslashEscapes,
        );
        const index = columnClause(parsed.clauses, column.name, detail.engine);
        if (index < 0) throw new Error('The column definition cannot be edited safely.');
        parsed.clauses[index] = replaceColumnOption(
          parsed.clauses[index],
          detail.engine,
          'collation',
          `COLLATE ${q(collation)}`,
        );
        const names = detail.columns.filter((c) => !c.generated).map((c) => c.name);
        if (detail.sqliteRowid) names.unshift(detail.sqliteRowid);
        const columns = names.map(q).join(', '),
          scratch = q(`dw_properties_${randomUUID().replaceAll('-', '')}`);
        plan.rebuildTable = detail.table;
        plan.statements = [
          `CREATE TEMP TABLE ${scratch} AS SELECT ${names.map((name) => `${q(name)} AS ${q(name)}`).join(', ')} FROM ${target}`,
          `DROP TABLE ${target}`,
          `${parsed.prefix}${parsed.clauses.join(',\n')}${parsed.suffix}`,
          `INSERT INTO ${target} (${columns}) SELECT ${columns} FROM temp.${scratch}`,
          `DROP TABLE temp.${scratch}`,
          ...detail.dependents,
        ];
      } else {
        if (column.generated)
          throw new Error('Change the generated column definition before changing its collation.');
        if (detail.engine === 'postgres')
          plan.statements.push(
            `ALTER TABLE ${target} ALTER COLUMN ${q(column.name)} TYPE ${column.type} COLLATE ${collation}`,
          );
        else {
          if (detail.defaults[column.name])
            plan.statements.push(
              `ALTER TABLE ${target} DROP CONSTRAINT ${q(detail.defaults[column.name])}`,
            );
          plan.statements.push(
            `ALTER TABLE ${target} ALTER COLUMN ${q(column.name)} ${column.type} COLLATE ${collation} ${column.nullable ? 'NULL' : 'NOT NULL'}`,
          );
          if (detail.defaults[column.name])
            plan.statements.push(
              `ALTER TABLE ${target} ADD CONSTRAINT ${q(detail.defaults[column.name])} DEFAULT ${column.defaultSql} FOR ${q(column.name)}`,
            );
        }
      }
    }
  }
  if (!plan.statements.length) throw new Error('There are no property changes.');
  return plan;
}
