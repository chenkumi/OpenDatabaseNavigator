import { randomUUID } from 'node:crypto';
import type { Engine, StructurePlan, TableStructure } from '../../shared/types';
import type {
  GeneratedChange,
  Generation,
  GenerationCapabilities,
} from '../../shared/generated-columns';
import type { SqlAdapter } from './adapter';
import { SqlBuilder } from './sql-builder';
import { keyword, sqlTokens } from './object-sql';
import { columnClause, tableClauses, validateFragment } from './structure-sql';
import { propertyString } from './structure-properties';

async function rows(adapter: SqlAdapter, sql: string, params: unknown[] = []) {
  const result = await adapter.query(sql, params, { limit: 10000, timeout: 30000, readOnly: true });
  if (result.hasMore) throw new Error('Generated column catalog exceeds the supported size.');
  return result.rows;
}
export async function generationCapabilities(
  adapter: SqlAdapter,
  engine: Engine,
): Promise<GenerationCapabilities> {
  const result: GenerationCapabilities = {
    modes: [],
    editExpression: false,
    changeStorage: false,
    inferredType: engine === 'sqlserver',
  };
  if (engine === 'postgres') {
    const version = Number(
      (await rows(adapter, "SELECT current_setting('server_version_num') AS version"))[0]?.version,
    );
    result.modes = version >= 180000 ? ['virtual', 'stored'] : version >= 120000 ? ['stored'] : [];
    result.editExpression = version >= 170000;
  } else if (engine === 'mysql') {
    const version = String((await rows(adapter, 'SELECT VERSION() AS version'))[0]?.version ?? '');
    const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.replace(/^5\.5\.5-/, ''));
    const number = parts ? Number(parts[1]) * 10000 + Number(parts[2]) * 100 + Number(parts[3]) : 0;
    if (number >= (/MariaDB/i.test(version) ? 50200 : 50700)) {
      result.modes = ['virtual', 'stored'];
      result.editExpression = true;
    }
  } else if (engine === 'sqlite' || engine === 'sqlserver') {
    result.modes = ['virtual', 'stored'];
    result.editExpression = true;
    result.changeStorage = true;
  }
  return result;
}

// Locate only the top-level AS expression, leaving constraints and attributes intact.
export function generationClause(clause: string, engine: Engine) {
  const tokens = sqlTokens(clause, engine);
  let depth = 0;
  for (let i = 1; i < tokens.length; i++) {
    if (keyword(tokens[i], '(')) depth++;
    else if (keyword(tokens[i], ')')) depth--;
    else if (!depth && keyword(tokens[i], 'AS') && keyword(tokens[i + 1], '(')) {
      const start = keyword(tokens[i - 2], 'GENERATED') ? tokens[i - 2].start : tokens[i].start;
      const expressionStart = tokens[i + 1].end;
      let j = i + 2,
        nested = 1;
      for (; j < tokens.length; j++) {
        if (keyword(tokens[j], '(')) nested++;
        if (keyword(tokens[j], ')') && --nested === 0) break;
      }
      if (nested) throw new Error('Incomplete generated column expression.');
      const storage: Generation['storage'] =
        keyword(tokens[j + 1], 'STORED') || keyword(tokens[j + 1], 'PERSISTENT')
          ? 'stored'
          : 'virtual';
      const end = ['VIRTUAL', 'STORED', 'PERSISTENT'].some((word) => keyword(tokens[j + 1], word))
        ? tokens[j + 1].end
        : tokens[j].end;
      return {
        start,
        end,
        generation: { expression: clause.slice(expressionStart, tokens[j].start), storage },
      };
    }
  }
  return undefined;
}
export async function readGenerationMetadata(adapter: SqlAdapter, detail: TableStructure) {
  detail.generationCapabilities = await generationCapabilities(adapter, detail.engine);
  if (detail.engine === 'sqlite' || detail.engine === 'mysql') {
    if (detail.readOnlyReason) return;
    const parsed = tableClauses(detail.definition, detail.engine, detail.mysqlNoBackslashEscapes);
    for (const column of detail.columns) {
      const index = columnClause(parsed.clauses, column.name, detail.engine);
      const generated =
        index >= 0 ? generationClause(parsed.clauses[index], detail.engine) : undefined;
      if (generated) {
        column.generation = generated.generation;
        column.generated = true;
        column.defaultSql = '';
      }
    }
  } else if (detail.engine === 'postgres') {
    const data = await rows(
      adapter,
      `SELECT a.attname AS name,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS expression
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relname=$2 AND a.attgenerated<>''`,
      [detail.schema, detail.table],
    );
    for (const row of data) {
      const column = detail.columns.find((c) => c.name === row.name);
      if (column) {
        column.generation = {
          expression: String(row.expression),
          storage: row.attgenerated === 'v' ? 'virtual' : 'stored',
        };
        column.defaultSql = '';
      }
    }
  } else if (detail.engine === 'sqlserver') {
    const data = await rows(
      adapter,
      'SELECT name,definition,is_persisted FROM sys.computed_columns WHERE object_id=OBJECT_ID(@p1)',
      [new SqlBuilder(detail.engine).table(detail)],
    );
    for (const row of data) {
      const column = detail.columns.find((c) => c.name === row.name);
      if (column && row.definition != null)
        column.generation = {
          expression: String(row.definition),
          storage: row.is_persisted ? 'stored' : 'virtual',
        };
    }
  }
}
export function generatedDefinition(
  engine: Engine,
  name: string,
  type: string,
  generation: Generation,
  capabilities: GenerationCapabilities,
) {
  if (!capabilities.modes.includes(generation.storage))
    throw new Error('This generated column storage mode is not supported by the server.');
  validateFragment(generation.expression, engine);
  const q = new SqlBuilder(engine).quote(name);
  if (engine === 'sqlserver')
    return `${q} AS (${generation.expression})${generation.storage === 'stored' ? ' PERSISTED' : ''}`;
  validateFragment(type, engine, true);
  return `${q} ${type} GENERATED ALWAYS AS (${generation.expression}) ${generation.storage.toUpperCase()}`;
}
interface Details extends TableStructure {
  dependents: string[];
  sqliteRowid?: string;
}
export async function planGeneratedChange(
  adapter: SqlAdapter,
  detail: Details,
  change: GeneratedChange,
): Promise<StructurePlan> {
  if (detail.kind !== 'table' || detail.readOnlyReason)
    throw new Error(detail.readOnlyReason || 'Generated columns require a table.');
  const caps =
    detail.generationCapabilities ?? (await generationCapabilities(adapter, detail.engine));
  const column =
    change.action === 'generated-edit'
      ? detail.columns.find((c) => c.name === change.column)
      : undefined;
  if (change.action === 'generated-edit' && !column?.generation)
    throw new Error('Select an existing generated column.');
  if (
    column &&
    !caps.editExpression &&
    change.generation.expression !== column.generation!.expression
  )
    throw new Error('This server version cannot alter generation expressions.');
  if (column && !caps.changeStorage && change.generation.storage !== column.generation!.storage)
    throw new Error('This engine cannot switch existing generated column storage modes.');
  if (column?.generation?.storage === 'virtual' && detail.engine === 'postgres')
    throw new Error('PostgreSQL cannot alter an existing virtual generation expression.');
  const name =
    column?.name ?? (change as Extract<GeneratedChange, { action: 'generated-add' }>).name;
  if (!column && detail.columns.some((c) => c.name.toLowerCase() === name.toLowerCase()))
    throw new Error('Choose a new, unique column name.');
  const max = detail.engine === 'postgres' ? 63 : detail.engine === 'mysql' ? 64 : 128;
  if (
    !name ||
    name.includes('\0') ||
    (detail.engine === 'postgres' ? Buffer.byteLength(name, 'utf8') : name.length) > max
  )
    throw new Error('Invalid generated column name.');
  if (column && JSON.stringify(column.generation) === JSON.stringify(change.generation))
    throw new Error('There are no generation changes.');
  const b = new SqlBuilder(detail.engine),
    target = b.table(detail),
    q = (v: string) => b.quote(v);
  const definition = generatedDefinition(
    detail.engine,
    name,
    column?.type ?? (change as Extract<GeneratedChange, { action: 'generated-add' }>).type,
    change.generation,
    caps,
  );
  const plan: StructurePlan = {
    statements: [],
    atomic: detail.engine !== 'mysql',
    destructive: !!column,
  };
  if (detail.engine === 'sqlite') {
    const parsed = tableClauses(detail.definition, detail.engine, detail.mysqlNoBackslashEscapes);
    if (column) {
      const index = columnClause(parsed.clauses, name, detail.engine),
        span = generationClause(parsed.clauses[index], detail.engine);
      if (!span) throw new Error('The generation expression cannot be edited safely.');
      parsed.clauses[index] =
        parsed.clauses[index].slice(0, span.start) +
        `GENERATED ALWAYS AS (${change.generation.expression}) ${change.generation.storage.toUpperCase()}` +
        parsed.clauses[index].slice(span.end);
    } else {
      const constraint = parsed.clauses.findIndex((clause) =>
        ['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK'].some((word) =>
          keyword(sqlTokens(clause, detail.engine)[0], word),
        ),
      );
      parsed.clauses.splice(constraint < 0 ? parsed.clauses.length : constraint, 0, definition);
    }
    const names = detail.columns.filter((c) => !c.generated).map((c) => c.name);
    if (detail.sqliteRowid) names.unshift(detail.sqliteRowid);
    const fields = names.map(q).join(', '),
      scratch = q(`dw_generation_${randomUUID().replaceAll('-', '')}`);
    plan.rebuildTable = detail.table;
    plan.statements = [
      `CREATE TEMP TABLE ${scratch} AS SELECT ${names.map((n) => `${q(n)} AS ${q(n)}`).join(', ')} FROM ${target}`,
      `DROP TABLE ${target}`,
      `${parsed.prefix}${parsed.clauses.join(',\n')}${parsed.suffix}`,
      `INSERT INTO ${target} (${fields}) SELECT ${fields} FROM temp.${scratch}`,
      `DROP TABLE temp.${scratch}`,
      ...detail.dependents,
    ];
  } else if (!column)
    plan.statements = [
      `ALTER TABLE ${target} ADD ${detail.engine === 'sqlserver' ? '' : 'COLUMN '}${definition}`,
    ];
  else if (detail.engine === 'mysql') {
    const parsed = tableClauses(detail.definition, detail.engine, detail.mysqlNoBackslashEscapes);
    const clause = parsed.clauses[columnClause(parsed.clauses, name, detail.engine)],
      span = generationClause(clause, detail.engine);
    if (!span) throw new Error('The generation expression cannot be edited safely.');
    plan.statements = [
      `ALTER TABLE ${target} MODIFY COLUMN ${clause.slice(0, span.start)}GENERATED ALWAYS AS (${change.generation.expression}) ${change.generation.storage.toUpperCase()}${clause.slice(span.end)}`,
    ];
  } else if (detail.engine === 'postgres')
    plan.statements = [
      `ALTER TABLE ${target} ALTER COLUMN ${q(name)} SET EXPRESSION AS (${change.generation.expression})`,
    ];
  else if (detail.engine === 'sqlserver') {
    if (change.generation.expression === column.generation!.expression) {
      plan.statements = [
        `ALTER TABLE ${target} ALTER COLUMN ${q(name)} ${change.generation.storage === 'stored' ? 'ADD' : 'DROP'} PERSISTED`,
      ];
    } else {
      const special = await rows(
        adapter,
        `SELECT 'permission' AS reason FROM sys.database_permissions WHERE class=1 AND major_id=OBJECT_ID(@p1) AND minor_id=COLUMNPROPERTY(OBJECT_ID(@p1),@p2,'ColumnId')
        UNION ALL SELECT 'property' FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID(@p1) AND minor_id=COLUMNPROPERTY(OBJECT_ID(@p1),@p2,'ColumnId') AND name<>N'MS_Description'`,
        [target, name],
      );
      if (special.length)
        throw new Error(
          'This computed column has custom permissions or properties that require manual DDL.',
        );
      plan.statements = [
        `ALTER TABLE ${target} DROP COLUMN ${q(name)}`,
        `ALTER TABLE ${target} ADD ${definition}${!column.nullable && change.generation.storage === 'stored' ? ' NOT NULL' : ''}`,
      ];
      if (column.commentExists) {
        const lit = (s: string) => propertyString(detail, s);
        plan.statements.push(
          `EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=${lit(column.properties?.comment ?? '')}, @level0type=N'SCHEMA', @level0name=${lit(detail.schema)}, @level1type=N'TABLE', @level1name=${lit(detail.table)}, @level2type=N'COLUMN', @level2name=${lit(name)}`,
        );
      }
      plan.notice =
        'SQL Server replaces the computed column in one transaction. Its position moves to the end; dependent constraints or indexes can prevent the change.';
    }
  }
  if (!plan.statements.length)
    throw new Error('Generated column changes are not supported by this engine.');
  return plan;
}
