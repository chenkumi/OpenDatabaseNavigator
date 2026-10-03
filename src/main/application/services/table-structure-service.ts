import { createHash, randomUUID } from 'node:crypto';
import type {
  Connection,
  StructureChange,
  StructureColumn,
  StructurePlan,
  TableRef,
  TableStructure,
} from '../../../shared/types';
import type { SqlAdapter } from '../../database/adapter';
import { SqlBuilder } from '../../database/sql-builder';
import { mysqlIndexSqlMode } from '../../database/index-options';
import { keyword, sameIdentifier, sqlTokens } from '../../database/object-sql';
import {
  columnAttribute,
  columnClause,
  replaceAttribute,
  tableClauses,
  validateFragment,
} from '../../database/structure-sql';
import { assertSingleStatement } from '../../security/single-statement';
import { renameDefinition } from '../../database/rename-definition';
import { aseColumns, aseDefinition } from '../../database/adapters/sybase/sybase-catalog';
import { readTableConstraints } from '../../database/constraint-catalog';
import { readPropertyMetadata, planPropertyChange } from '../../database/structure-properties';
import { planConstraintChange } from '../../database/constraint-plan';
import { readGenerationMetadata, planGeneratedChange } from '../../database/generated-columns';
import { readViewMetadata, planViewOptions } from '../../database/view-options';

interface Details extends TableStructure {
  dependents: string[];
  primaryConstraint?: string;
  defaults: Record<string, string>;
  collations: Record<string, string>;
  prefix: string[];
  sqliteRowid?: string;
  catalog?: unknown;
}
const options = { limit: 5000, timeout: 30000, readOnly: true };
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
export async function describeStructure(
  adapter: SqlAdapter,
  connection: Connection,
  ref: TableRef,
): Promise<Details> {
  const engine = connection.engine;
  const schema =
    ref.schema ??
    (engine === 'sqlite'
      ? 'main'
      : engine === 'postgres'
        ? 'public'
        : engine === 'sqlserver' || engine === 'sybase'
          ? 'dbo'
          : (ref.database ?? connection.database));
  if (engine === 'sqlite' && schema !== 'main')
    throw new Error('SQLite structure editing is limited to the main database.');
  const table = (await adapter.tables(schema)).find((t) => t.name === ref.table);
  if (!table) throw new Error('Table or view no longer exists or is not accessible.');
  const b = new SqlBuilder(engine),
    q = (s: string) => b.quote(s),
    target = b.table({ schema, table: ref.table });
  const result: Details = {
    ...table,
    table: ref.table,
    engine,
    schema,
    columns: [],
    definition: '',
    version: '',
    dependents: [],
    defaults: {},
    collations: {},
    prefix: [],
  };
  if (engine === 'sybase') {
    const metadata = await aseColumns(adapter, { schema, table: ref.table });
    result.columns = metadata.columns;
    result.primaryConstraint = metadata.primaryConstraint;
    result.catalog = metadata;
    result.definition =
      table.kind === 'view' ? await aseDefinition(adapter, { schema, table: ref.table }) : '';
    if (metadata.raw.some((row) => Number(row.domain) || Number(row.status2)))
      result.readOnlyReason =
        'ASE columns with rules, encryption or specialized attributes require engine-specific DDL.';
  } else if (engine === 'sqlite') {
    const rows = (
      await adapter.query(
        "SELECT type, sql FROM sqlite_schema WHERE name=? OR (tbl_name=? AND type IN ('index','trigger')) ORDER BY type,name",
        [ref.table, ref.table],
        options,
      )
    ).rows;
    result.definition = String(rows.find((r) => r.type === table.kind)?.sql ?? '');
    result.dependents = rows
      .filter((r) => ['index', 'trigger'].includes(String(r.type)) && r.sql)
      .map((r) => String(r.sql));
    const columns = (
      await adapter.query(`PRAGMA ${q(schema)}.table_xinfo(${q(ref.table)})`, [], options)
    ).rows;
    result.columns = columns.map((c) => ({
      name: String(c.name),
      type: String(c.type),
      nullable: !Number(c.notnull) && !Number(c.pk),
      primaryKey: Number(c.pk) > 0,
      defaultValue: c.dflt_value,
      defaultSql: c.dflt_value == null ? '' : String(c.dflt_value),
      generated: Number(c.hidden) !== 0,
    }));
    if (!/\bWITHOUT\s+ROWID\b/i.test(result.definition))
      result.sqliteRowid = ['rowid', '_rowid_', 'oid'].find(
        (name) => !result.columns.some((c) => c.name.toLowerCase() === name),
      );
    if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(result.definition))
      result.readOnlyReason = 'Virtual tables must be managed using their module-specific DDL.';
  } else if (engine === 'postgres') {
    const rows = (
      await adapter.query(
        `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS default_sql, a.attidentity, a.attgenerated, CASE WHEN a.attcollation<>0 THEN quote_ident(cn.nspname)||'.'||quote_ident(co.collname) END AS collation FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [schema, ref.table],
        options,
      )
    ).rows;
    const primary = (
      await adapter.query(
        `SELECT con.conname, a.attname FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN LATERAL unnest(con.conkey) WITH ORDINALITY k(num,ord) ON true JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num WHERE n.nspname=$1 AND c.relname=$2 AND con.contype='p' ORDER BY k.ord`,
        [schema, ref.table],
        options,
      )
    ).rows;
    result.primaryConstraint = primary[0]?.conname as string | undefined;
    result.columns = rows.map((c) => ({
      name: String(c.name),
      type: String(c.type),
      nullable: !!c.nullable,
      primaryKey: primary.some((p) => p.attname === c.name),
      defaultValue: c.default_sql,
      defaultSql: c.default_sql == null ? '' : String(c.default_sql),
      generated: !!c.attidentity || !!c.attgenerated,
    }));
    for (const c of rows) if (c.collation) result.collations[String(c.name)] = String(c.collation);
    if (table.kind === 'view') {
      const row = (
        await adapter.query(
          'SELECT pg_get_viewdef(c.oid,true) AS definition,c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2',
          [schema, ref.table],
          options,
        )
      ).rows[0];
      const params = Array.isArray(row?.reloptions) ? (row.reloptions as string[]) : [];
      result.definition = `CREATE VIEW ${target} (${result.columns.map((c) => q(c.name)).join(', ')})${params.length ? ` WITH (${params.join(', ')})` : ''} AS\n${row?.definition ?? ''}`;
    }
  } else if (engine === 'mysql') {
    const create = (
      await adapter.query(`SHOW CREATE ${table.kind.toUpperCase()} ${target}`, [], options)
    ).rows[0];
    result.definition = String(
      create?.[table.kind === 'view' ? 'Create View' : 'Create Table'] ?? '',
    );
    // SHOW CREATE does not escape backslashes under NO_BACKSLASH_ESCAPES, so the
    // definition must be tokenized in that mode before it is parsed.
    result.mysqlNoBackslashEscapes = await mysqlIndexSqlMode(adapter);
    const rows = (
      await adapter.query(
        'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value, COLUMN_KEY AS column_key, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
        [schema, ref.table],
        options,
      )
    ).rows;
    const clauses =
      table.kind === 'table'
        ? tableClauses(result.definition, engine, result.mysqlNoBackslashEscapes).clauses
        : [];
    result.columns = rows.map((c) => {
      const index = columnClause(clauses, String(c.name), engine, result.mysqlNoBackslashEscapes);
      return {
        name: String(c.name),
        type: String(c.type),
        nullable: c.nullable === 'YES',
        primaryKey: c.column_key === 'PRI',
        defaultValue: c.default_value,
        defaultSql:
          index >= 0
            ? columnAttribute(clauses[index], engine, 'default', result.mysqlNoBackslashEscapes)
                .value
            : '',
        generated: /auto_increment|(?:VIRTUAL|STORED) GENERATED/i.test(String(c.extra)),
      };
    });
  } else if (engine === 'sqlserver') {
    const rows = (
      await adapter.query(
        `SELECT c.name, t.name AS type, SCHEMA_NAME(t.schema_id) AS type_schema, t.is_user_defined, c.max_length,c.precision,c.scale,c.is_nullable,c.is_identity,c.is_computed,c.collation_name,dc.name AS default_name,dc.definition AS default_sql FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id WHERE c.object_id=OBJECT_ID(@p1) ORDER BY c.column_id`,
        [target],
        options,
      )
    ).rows;
    const primary = (
      await adapter.query(
        `SELECT kc.name, col.name AS column_name FROM sys.key_constraints kc JOIN sys.index_columns ic ON ic.object_id=kc.parent_object_id AND ic.index_id=kc.unique_index_id JOIN sys.columns col ON col.object_id=ic.object_id AND col.column_id=ic.column_id WHERE kc.parent_object_id=OBJECT_ID(@p1) AND kc.type='PK' ORDER BY ic.key_ordinal`,
        [target],
        options,
      )
    ).rows;
    result.primaryConstraint = primary[0]?.name as string | undefined;
    result.columns = rows.map((c) => {
      let type = String(c.type);
      if (c.is_user_defined) type = `${q(String(c.type_schema))}.${q(type)}`;
      else if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(type))
        type += `(${Number(c.max_length) === -1 ? 'max' : Number(c.max_length) / (type.startsWith('n') ? 2 : 1)})`;
      else if (['decimal', 'numeric'].includes(type)) type += `(${c.precision},${c.scale})`;
      else if (['datetime2', 'datetimeoffset', 'time'].includes(type)) type += `(${c.scale})`;
      if (c.default_name) result.defaults[String(c.name)] = String(c.default_name);
      if (c.collation_name && /^[A-Za-z0-9_]+$/.test(String(c.collation_name)))
        result.collations[String(c.name)] = String(c.collation_name);
      return {
        name: String(c.name),
        type,
        nullable: !!c.is_nullable,
        primaryKey: primary.some((p) => p.column_name === c.name),
        defaultValue: c.default_sql,
        defaultSql: c.default_sql == null ? '' : String(c.default_sql),
        generated:
          !!c.is_identity ||
          !!c.is_computed ||
          ['timestamp', 'rowversion'].includes(String(c.type)),
      };
    });
    if (table.kind === 'view') {
      const row = (
        await adapter.query(
          'SELECT definition,uses_ansi_nulls,uses_quoted_identifier FROM sys.sql_modules WHERE object_id=OBJECT_ID(@p1)',
          [target],
          options,
        )
      ).rows[0];
      result.definition = String(row?.definition ?? '');
      result.prefix = [
        `SET ANSI_NULLS ${row?.uses_ansi_nulls ? 'ON' : 'OFF'}`,
        `SET QUOTED_IDENTIFIER ${row?.uses_quoted_identifier ? 'ON' : 'OFF'}`,
      ];
      const indexed = (
        await adapter.query(
          'SELECT name FROM sys.indexes WHERE object_id=OBJECT_ID(@p1) AND index_id>0',
          [target],
          options,
        )
      ).rows;
      if (indexed.length)
        result.readOnlyReason =
          'Indexed views require an explicit index recreation plan before changing their definition.';
    }
  }
  if (table.kind === 'view' && result.definition && ['sqlserver', 'sybase'].includes(engine))
    result.definition = renameDefinition(result.definition, engine, 'view', target);
  if (table.kind === 'view' && !result.definition)
    result.readOnlyReason = 'The database did not return a complete view definition.';
  if (table.kind === 'table') Object.assign(result, await readTableConstraints(adapter, result));
  if (table.kind === 'table') await readPropertyMetadata(adapter, result);
  if (table.kind === 'table') await readGenerationMetadata(adapter, result);
  if (table.kind === 'view' && result.definition) await readViewMetadata(adapter, result);
  result.version = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return result;
}

function viewPlan(detail: Details, sql: string): string[] {
  const engine = detail.engine,
    b = new SqlBuilder(engine),
    target = b.table(detail);
  assertSingleStatement(sql, engine);
  const tokens = sqlTokens(sql, engine);
  if (!keyword(tokens[0], 'CREATE') && !keyword(tokens[0], 'ALTER'))
    throw new Error('Use a complete CREATE VIEW definition.');
  const i = tokens.findIndex((t) => keyword(t, 'VIEW'));
  if (i < 1 || i > 15) throw new Error('Use a complete CREATE VIEW definition.');
  let end = i + 2;
  const parts = [tokens[i + 1]?.value];
  if (keyword(tokens[end], '.')) {
    parts.push(tokens[end + 1]?.value);
    end += 2;
  }
  if (!sameIdentifier(parts, detail.schema, detail.table))
    throw new Error('Keep the original view name and schema.');
  const body = sql.slice(tokens[end - 1].end);
  // Prevent SQL Server's semicolon-free batches from appending another command.
  const forbidden = new Set(
    'CREATE ALTER DROP TRUNCATE INSERT UPDATE DELETE MERGE EXEC EXECUTE GRANT REVOKE DENY USE SET DECLARE BEGIN COMMIT ROLLBACK DBCC WAITFOR BACKUP RESTORE'.split(
      ' ',
    ),
  );
  if (tokens.slice(end).some((t) => !t.quoted && forbidden.has(t.value.toUpperCase())))
    throw new Error('Only one view definition is permitted.');
  if (engine === 'sqlite')
    return [`DROP VIEW ${target}`, `CREATE VIEW ${target}${body}`, ...detail.dependents];
  if (engine === 'postgres' || engine === 'sybase')
    return [`CREATE OR REPLACE VIEW ${target}${body}`];
  if (engine === 'mysql') {
    const header = sql.slice(tokens[0].end, tokens[i].start).replace(/^\s*OR\s+REPLACE\b/i, '');
    return [`ALTER${header}VIEW ${target}${body}`];
  }
  return [...detail.prefix, `ALTER VIEW ${target}${body}`];
}

export function planStructure(detail: Details, change: StructureChange): StructurePlan {
  if (change.action === 'view-options') return planViewOptions(detail, change.options);
  if (change.action === 'generated-add' || change.action === 'generated-edit')
    throw new Error('Generated column changes require server capabilities.');
  if (change.action === 'table-properties' || change.action === 'column-properties')
    throw new Error('Property changes require server property options.');
  if (detail.readOnlyReason) throw new Error(detail.readOnlyReason);
  if (change.action === 'constraint-upsert' || change.action === 'constraint-drop')
    return planConstraintChange(detail, change);
  if (change.action === 'edit-columns') {
    if (!change.changes.length && change.primaryKey === undefined)
      throw new Error('There are no structure changes.');
    const originalKeys = detail.columns
      .filter((column) => column.primaryKey)
      .map((column) => column.name);
    const primaryKey =
      JSON.stringify(change.primaryKey) === JSON.stringify(originalKeys)
        ? undefined
        : change.primaryKey;
    if (!change.changes.length && primaryKey === undefined)
      throw new Error('There are no structure changes.');
    if (
      primaryKey &&
      (new Set(primaryKey).size !== primaryKey.length ||
        primaryKey.some((name) => !detail.columns.some((column) => column.name === name)))
    )
      throw new Error('Choose existing, distinct primary key columns.');
    const seen = new Set<string>();
    for (const item of change.changes) {
      const key = JSON.stringify([item.column, item.action]);
      if (seen.has(key)) throw new Error('Duplicate column property change.');
      seen.add(key);
    }
    // Keep original column identities through all property edits; rename only at the end.
    const properties = [...change.changes];
    for (const name of primaryKey ?? []) {
      const nullable = properties.find((c) => c.action === 'nullable' && c.column === name);
      if (nullable?.action === 'nullable' && nullable.nullable)
        throw new Error('Primary key columns cannot allow NULL.');
      if (!nullable && detail.columns.find((c) => c.name === name)?.nullable)
        properties.push({ action: 'nullable', column: name, nullable: false });
    }
    const ordered = [
      ...properties.filter((c) => c.action !== 'rename'),
      ...properties.filter((c) => c.action === 'rename'),
    ];
    let projected = { ...detail, columns: detail.columns.map((column) => ({ ...column })) };
    const combined: StructurePlan = {
      statements: [],
      atomic: !['mysql', 'sybase'].includes(detail.engine),
      destructive: primaryKey !== undefined,
    };
    if (primaryKey !== undefined) {
      if (detail.engine !== 'sqlite' && detail.columns.some((c) => c.primaryKey)) {
        combined.statements.push(
          ...planStructure(detail, { action: 'primary-key', columns: [] }).statements,
        );
      }
      projected.columns = projected.columns.map((column) => ({ ...column, primaryKey: false }));
    }
    if (detail.engine === 'sqlserver') {
      const b = new SqlBuilder(detail.engine);
      projected.defaults = { ...detail.defaults };
      for (const item of change.changes) {
        if (item.action !== 'type' || !projected.defaults[item.column]) continue;
        combined.statements.push(
          `ALTER TABLE ${b.table(detail)} DROP CONSTRAINT ${b.quote(projected.defaults[item.column])}`,
        );
        delete projected.defaults[item.column];
        if (!ordered.some((c) => c.action === 'default' && c.column === item.column)) {
          const original = detail.columns.find((c) => c.name === item.column);
          if (original?.defaultSql)
            ordered.unshift({
              action: 'default',
              column: item.column,
              defaultSql: original.defaultSql,
            });
        }
      }
      // Restore defaults after type conversion, before renaming.
      ordered.sort(
        (a, b) =>
          (a.action === 'rename' ? 2 : a.action === 'default' ? 1 : 0) -
          (b.action === 'rename' ? 2 : b.action === 'default' ? 1 : 0),
      );
    }
    const applyKeys = () => {
      if (primaryKey === undefined) return;
      if (detail.engine === 'sqlite') {
        const next = planStructure(projected, { action: 'primary-key', columns: primaryKey });
        combined.rebuildTable = next.rebuildTable;
        combined.statements = next.statements;
        projected.definition = next.statements[2];
      } else if (primaryKey.length) {
        combined.statements.push(
          ...planStructure(projected, { action: 'primary-key', columns: primaryKey }).statements,
        );
      }
    };
    let keysApplied = false;
    for (const item of ordered) {
      if (item.action === 'rename' && !keysApplied) {
        applyKeys();
        keysApplied = true;
      }
      const next = planStructure(projected, item);
      combined.destructive ||= next.destructive;
      if (next.rebuildTable) {
        // Each projected SQLite definition includes all preceding edits. Rebuild just once.
        combined.rebuildTable = next.rebuildTable;
        combined.statements = next.statements;
        projected.definition = next.statements[2];
      } else {
        combined.statements.push(...next.statements);
        if (detail.engine === 'mysql' && item.action !== 'rename') {
          const parsed = tableClauses(
            projected.definition,
            detail.engine,
            detail.mysqlNoBackslashEscapes,
          );
          const index = columnClause(parsed.clauses, item.column, detail.engine);
          const prefix = `ALTER TABLE ${new SqlBuilder(detail.engine).table(detail)} MODIFY COLUMN `;
          parsed.clauses[index] = next.statements[0].slice(prefix.length);
          projected.definition = `${parsed.prefix}${parsed.clauses.join(',\n')}${parsed.suffix}`;
        }
      }
      projected.columns = projected.columns.map((column) => {
        if (column.name !== item.column) return column;
        switch (item.action) {
          case 'rename':
            return { ...column, name: item.name };
          case 'type':
            return { ...column, type: item.type };
          case 'nullable':
            return { ...column, nullable: item.nullable };
          case 'default':
            return { ...column, defaultSql: item.defaultSql };
        }
      });
    }
    if (!keysApplied) applyKeys();
    if (detail.engine === 'mysql') {
      const b = new SqlBuilder(detail.engine);
      const parsed = tableClauses(
        projected.definition,
        detail.engine,
        detail.mysqlNoBackslashEscapes,
      );
      const modified = [
        ...new Set(ordered.filter((item) => item.action !== 'rename').map((item) => item.column)),
      ];
      const clauses = modified.map(
        (name) =>
          `MODIFY COLUMN ${parsed.clauses[columnClause(parsed.clauses, name, detail.engine)]}`,
      );
      if (primaryKey !== undefined) {
        if (detail.columns.some((column) => column.primaryKey)) clauses.unshift('DROP PRIMARY KEY');
        if (primaryKey.length)
          clauses.push(
            `ADD PRIMARY KEY (${primaryKey
              .map((name) => {
                const rename = ordered.find(
                  (item) => item.action === 'rename' && item.column === name,
                );
                return b.quote(rename?.action === 'rename' ? rename.name : name);
              })
              .join(', ')})`,
          );
      }
      for (const item of ordered)
        if (item.action === 'rename')
          clauses.push(`RENAME COLUMN ${b.quote(item.column)} TO ${b.quote(item.name)}`);
      if (!clauses.length) throw new Error('There are no structure changes.');
      combined.statements = [`ALTER TABLE ${b.table(detail)} ${clauses.join(', ')}`];
    }
    return combined;
  }
  const engine = detail.engine,
    b = new SqlBuilder(engine),
    q = (s: string) => b.quote(s),
    target = b.table(detail);
  const plan: StructurePlan = {
    statements: [],
    atomic: !['mysql', 'sybase'].includes(engine),
    destructive:
      change.action === 'drop' || change.action === 'type' || change.action === 'primary-key',
  };
  if (change.action === 'view') {
    if (detail.kind !== 'view') throw new Error('This operation requires a view.');
    plan.statements = viewPlan(detail, change.sql);
    return plan;
  }
  if (detail.kind !== 'table') throw new Error('Edit the view SQL to change its columns.');
  const column =
    'column' in change ? detail.columns.find((c) => c.name === change.column) : undefined;
  if ('column' in change && !column) throw new Error('Column no longer exists.');
  if (column?.generated && !['rename', 'drop'].includes(change.action))
    throw new Error('Generated and identity columns require engine-specific DDL.');
  if (column?.primaryKey && change.action === 'nullable' && change.nullable)
    throw new Error('Remove the column from the primary key before allowing NULL.');
  if ('type' in change) validateFragment(change.type, engine, true);
  if ('defaultSql' in change && change.defaultSql.trim())
    validateFragment(change.defaultSql, engine);
  if ('name' in change && (!change.name || detail.columns.some((c) => c.name === change.name)))
    throw new Error('Choose a new, unique column name.');
  if (change.action === 'add') {
    if (change.primaryKey && change.nullable)
      throw new Error('Primary key columns cannot allow NULL.');
    plan.statements = [
      engine === 'sybase'
        ? `ALTER TABLE ${target} ADD ${q(change.name)} ${change.type}${change.defaultSql.trim() ? ` DEFAULT ${change.defaultSql}` : ''} ${change.nullable ? 'NULL' : 'NOT NULL'}`
        : `ALTER TABLE ${target} ADD ${engine === 'sqlserver' ? '' : 'COLUMN '}${q(change.name)} ${change.type}${change.nullable ? ' NULL' : ' NOT NULL'}${change.defaultSql.trim() ? ` DEFAULT ${change.defaultSql}` : ''}`,
    ];
    if (change.primaryKey) {
      const added: StructureColumn = {
        name: change.name,
        type: change.type,
        nullable: false,
        defaultValue: null,
        defaultSql: change.defaultSql,
        primaryKey: false,
      };
      const projected = { ...detail, columns: [...detail.columns, added] };
      if (engine === 'sqlite') {
        const parsed = tableClauses(detail.definition, engine, detail.mysqlNoBackslashEscapes);
        parsed.clauses.push(
          `${q(change.name)} ${change.type} NOT NULL${change.defaultSql.trim() ? ` DEFAULT ${change.defaultSql}` : ''}`,
        );
        projected.definition = `${parsed.prefix}${parsed.clauses.join(',\n')}${parsed.suffix}`;
      }
      const keys = detail.columns.filter((c) => c.primaryKey).map((c) => c.name);
      const keyPlan = planStructure(projected, {
        action: 'primary-key',
        columns: [...keys, change.name],
      });
      if (engine === 'mysql') {
        plan.statements[0] += `, ${keys.length ? 'DROP PRIMARY KEY, ' : ''}ADD PRIMARY KEY (${[...keys, change.name].map(q).join(', ')})`;
      } else plan.statements.push(...keyPlan.statements);
      plan.rebuildTable = keyPlan.rebuildTable;
      plan.destructive = true;
    }
    return plan;
  }
  if (change.action === 'rename') {
    plan.statements = [
      engine === 'sybase'
        ? `EXEC sp_rename ${literal(`${target}.${q(change.column)}`)}, ${literal(change.name)}, 'column'`
        : engine === 'sqlserver'
          ? `EXEC sys.sp_rename ${literal(`${target}.${q(change.column)}`)}, ${literal(change.name)}, 'COLUMN'`
          : `ALTER TABLE ${target} RENAME COLUMN ${q(change.column)} TO ${q(change.name)}`,
    ];
    return plan;
  }
  if (change.action === 'drop') {
    plan.statements = [
      `ALTER TABLE ${target} DROP ${engine === 'sybase' ? '' : 'COLUMN '}${q(change.column)}`,
    ];
    if (engine === 'sqlserver' && detail.defaults[change.column])
      plan.statements.unshift(
        `ALTER TABLE ${target} DROP CONSTRAINT ${q(detail.defaults[change.column])}`,
      );
    return plan;
  }
  if (change.action === 'primary-key') {
    const originalKeys = detail.columns.filter((column) => column.primaryKey);
    if (
      engine === 'sqlite' &&
      originalKeys.length === 1 &&
      change.columns.length === 1 &&
      change.columns[0] === originalKeys[0].name
    )
      throw new Error('There are no primary key changes.');
    if (
      new Set(change.columns).size !== change.columns.length ||
      change.columns.some((name) => !detail.columns.some((c) => c.name === name))
    )
      throw new Error('Choose existing, distinct primary key columns.');
    if (engine !== 'sqlite') {
      if (
        engine === 'sybase' &&
        detail.columns.some((c) => c.primaryKey) &&
        !detail.primaryConstraint
      )
        throw new Error('ASE primary key constraint name is unavailable.');
      const clauses: string[] = [];
      if (detail.columns.some((c) => c.primaryKey))
        clauses.push(
          engine === 'mysql'
            ? 'DROP PRIMARY KEY'
            : `DROP CONSTRAINT ${q(detail.primaryConstraint!)}`,
        );
      if (change.columns.length)
        clauses.push(`ADD PRIMARY KEY (${change.columns.map(q).join(', ')})`);
      if (!clauses.length) throw new Error('There are no primary key changes.');
      plan.statements =
        engine === 'mysql'
          ? [`ALTER TABLE ${target} ${clauses.join(', ')}`]
          : clauses.map((clause) => `ALTER TABLE ${target} ${clause}`);
      if (!plan.statements.length) throw new Error('There are no primary key changes.');
      return plan;
    }
  }
  if (engine === 'sqlite' || engine === 'mysql') {
    const parsed = tableClauses(detail.definition, engine, detail.mysqlNoBackslashEscapes);
    if (change.action === 'primary-key') {
      parsed.clauses = parsed.clauses
        .filter((clause) => {
          const tokens = sqlTokens(clause, engine);
          return !(
            keyword(tokens[0], 'PRIMARY') ||
            (keyword(tokens[0], 'CONSTRAINT') && keyword(tokens[2], 'PRIMARY'))
          );
        })
        .map((clause) => {
          const tokens = sqlTokens(clause, engine);
          const i = tokens.findIndex((t) => keyword(t, 'PRIMARY'));
          if (i < 0) return clause;
          let end = i + 2;
          if (keyword(tokens[end], 'ASC') || keyword(tokens[end], 'DESC')) end++;
          if (keyword(tokens[end], 'ON') && keyword(tokens[end + 1], 'CONFLICT')) end += 3;
          if (keyword(tokens[end], 'AUTOINCREMENT')) end++;
          const start = keyword(tokens[i - 2], 'CONSTRAINT')
            ? tokens[i - 2].start
            : tokens[i].start;
          return clause.slice(0, start) + clause.slice(tokens[end]?.start ?? clause.length);
        });
      if (change.columns.length)
        parsed.clauses.push(`PRIMARY KEY (${change.columns.map(q).join(', ')})`);
    } else {
      const index = columnClause(parsed.clauses, column!.name, engine);
      if (index < 0) throw new Error('The column definition cannot be edited safely.');
      const value =
        change.action === 'type'
          ? change.type
          : change.action === 'nullable'
            ? change.nullable
              ? engine === 'mysql'
                ? 'NULL'
                : ''
              : 'NOT NULL'
            : change.defaultSql.trim()
              ? `DEFAULT ${change.defaultSql}`
              : '';
      parsed.clauses[index] = replaceAttribute(parsed.clauses[index], engine, change.action, value);
      if (engine === 'mysql') {
        plan.statements = [`ALTER TABLE ${target} MODIFY COLUMN ${parsed.clauses[index]}`];
        return plan;
      }
    }
    const names = detail.columns.filter((c) => !c.generated).map((c) => c.name);
    if (detail.sqliteRowid) names.unshift(detail.sqliteRowid);
    const scratch = q(`dw_structure_${randomUUID().replaceAll('-', '')}`);
    const columns = names.map(q).join(', ');
    plan.rebuildTable = detail.table;
    plan.statements = [
      `CREATE TEMP TABLE ${scratch} AS SELECT ${names.map((name) => `${q(name)} AS ${q(name)}`).join(', ')} FROM ${target}`,
      `DROP TABLE ${target}`,
      `${parsed.prefix}${parsed.clauses.join(',\n')}${parsed.suffix}`,
      `INSERT INTO ${target} (${columns}) SELECT ${columns} FROM temp.${scratch}`,
      `DROP TABLE temp.${scratch}`,
      ...detail.dependents,
    ];
    return plan;
  }
  if (change.action === 'type' || change.action === 'nullable') {
    if (engine === 'sybase') {
      plan.statements = [
        `ALTER TABLE ${target} MODIFY ${q(column!.name)} ${change.action === 'type' ? change.type : column!.type} ${(change.action === 'nullable' ? change.nullable : column!.nullable) ? 'NULL' : 'NOT NULL'}`,
      ];
    } else if (engine === 'postgres') {
      plan.statements = [
        `ALTER TABLE ${target} ALTER COLUMN ${q(column!.name)} ${change.action === 'type' ? `TYPE ${change.type}${detail.collations[column!.name] && /^(?:text|varchar|char|character|citext)\b/i.test(change.type) ? ` COLLATE ${detail.collations[column!.name]}` : ''}` : change.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`,
      ];
    } else {
      const type = change.action === 'type' ? change.type : column!.type;
      const nullable = change.action === 'nullable' ? change.nullable : column!.nullable;
      plan.statements = [
        `ALTER TABLE ${target} ALTER COLUMN ${q(column!.name)} ${type}${detail.collations[column!.name] && /^(?:n?varchar|n?char|n?text)\b/i.test(type) ? ` COLLATE ${detail.collations[column!.name]}` : ''} ${nullable ? 'NULL' : 'NOT NULL'}`,
      ];
    }
  } else if (change.action === 'default') {
    if (engine === 'sybase')
      plan.statements = [
        `ALTER TABLE ${target} REPLACE ${q(change.column)} DEFAULT ${change.defaultSql.trim() || 'NULL'}`,
      ];
    else if (engine === 'postgres')
      plan.statements = [
        `ALTER TABLE ${target} ALTER COLUMN ${q(change.column)} ${change.defaultSql.trim() ? `SET DEFAULT ${change.defaultSql}` : 'DROP DEFAULT'}`,
      ];
    else {
      if (detail.defaults[change.column])
        plan.statements.push(
          `ALTER TABLE ${target} DROP CONSTRAINT ${q(detail.defaults[change.column])}`,
        );
      if (change.defaultSql.trim())
        plan.statements.push(
          `ALTER TABLE ${target} ADD DEFAULT ${change.defaultSql} FOR ${q(change.column)}`,
        );
    }
  }
  if (!plan.statements.length) throw new Error('There are no structure changes.');
  return plan;
}

const locks = new WeakMap<SqlAdapter, Promise<unknown>>();
export async function applyStructure(
  adapter: SqlAdapter,
  connection: Connection,
  ref: TableRef,
  change: StructureChange,
  version: string,
  timeout: number,
) {
  const task = (locks.get(adapter) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const current = await describeStructure(adapter, connection, ref);
      if (current.version !== version)
        throw new Error(
          'The structure changed since it was loaded. Refresh before applying changes.',
        );
      const plan =
        change.action === 'generated-add' || change.action === 'generated-edit'
          ? await planGeneratedChange(adapter, current, change)
          : change.action === 'table-properties' || change.action === 'column-properties'
            ? await planPropertyChange(adapter, current, change)
            : planStructure(current, change);
      if (!adapter.executeDdl)
        throw new Error('Structure editing is not supported by this adapter.');
      await adapter.executeDdl(plan.statements, timeout, {
        rebuildTable: plan.rebuildTable,
        validateViews: true,
        recoveryStatements: plan.recoveryStatements,
      });
      try {
        return await describeStructure(adapter, connection, ref);
      } catch (error) {
        throw new Error(
          `Changes were applied, but reloading the structure failed. Refresh this tab. ${(error as Error).message}`,
        );
      }
    });
  locks.set(adapter, task);
  try {
    return await task;
  } finally {
    if (locks.get(adapter) === task) locks.delete(adapter);
  }
}
