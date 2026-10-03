import type {
  ConstraintCapabilities,
  ReferenceAction,
  TableConstraint,
} from '../../shared/constraints';
import { referenceActions } from '../../shared/constraints';
import type { Engine, TableStructure } from '../../shared/types';
import type { SqlAdapter } from './adapter';
import { keyword, sqlTokens, type SqlToken } from './object-sql';
import { tableClauses } from './structure-sql';
import { SqlBuilder } from './sql-builder';

const options = { limit: 10000, timeout: 30000, readOnly: true };
function closeParen(tokens: SqlToken[], start: number) {
  if (!keyword(tokens[start], '(')) throw new Error('Incomplete constraint definition.');
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (keyword(tokens[i], '(')) depth++;
    else if (keyword(tokens[i], ')') && --depth === 0) return i;
  }
  throw new Error('Incomplete constraint definition.');
}

/** Parse source ranges as well as names so unnamed/inline SQLite constraints remain editable. */
export function parseTableConstraints(
  sql: string,
  engine: Engine,
  schema: string,
): TableConstraint[] {
  const result: TableConstraint[] = [];
  tableClauses(sql, engine).clauses.forEach((clause, clauseIndex) => {
    const tokens = sqlTokens(clause, engine);
    const tableStart = keyword(tokens[0], 'CONSTRAINT') ? 2 : 0;
    const whole = keyword(tokens[tableStart], 'FOREIGN') || keyword(tokens[tableStart], 'CHECK');
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (keyword(token, '(')) {
        depth++;
        continue;
      }
      if (keyword(token, ')')) {
        depth--;
        continue;
      }
      if (depth || (!keyword(token, 'CHECK') && !keyword(token, 'REFERENCES'))) continue;
      const start = whole
        ? 0
        : keyword(tokens[i - 2], 'CONSTRAINT')
          ? tokens[i - 2].start
          : token.start;
      const name = whole
        ? keyword(tokens[0], 'CONSTRAINT')
          ? tokens[1].value
          : ''
        : keyword(tokens[i - 2], 'CONSTRAINT')
          ? tokens[i - 1].value
          : '';
      let endIndex: number;
      const id = `${clauseIndex}:${start}`;
      if (keyword(token, 'CHECK')) {
        endIndex = closeParen(tokens, i + 1);
        const notEnforced =
          keyword(tokens[endIndex + 1], 'NOT') && keyword(tokens[endIndex + 2], 'ENFORCED');
        const expression = clause.slice(tokens[i + 1].end, tokens[endIndex].start);
        if (notEnforced) endIndex += 2;
        else if (keyword(tokens[endIndex + 1], 'ENFORCED')) endIndex++;
        result.push({
          id,
          definition: { kind: 'check', name, expression, notEnforced },
          source: { clause: clauseIndex, start, end: tokens[endIndex].end, whole },
        });
      } else {
        const localOpen = tableStart + 2;
        const columns = whole
          ? tokens
              .slice(localOpen + 1, closeParen(tokens, localOpen))
              .filter((t) => !keyword(t, ','))
              .map((t) => t.value)
          : [tokens[0].value];
        let referencedSchema = schema,
          referencedTable = tokens[i + 1].value;
        let cursor = i + 2;
        if (keyword(tokens[cursor], '.')) {
          referencedSchema = referencedTable;
          referencedTable = tokens[cursor + 1].value;
          cursor += 2;
        }
        let referencedColumns: string[] = [];
        if (keyword(tokens[cursor], '(')) {
          const close = closeParen(tokens, cursor);
          referencedColumns = tokens
            .slice(cursor + 1, close)
            .filter((t) => !keyword(t, ','))
            .map((t) => t.value);
          cursor = close + 1;
        }
        let onDelete: ReferenceAction = 'NO ACTION',
          onUpdate: ReferenceAction = 'NO ACTION';
        let special = false;
        while (cursor < tokens.length) {
          if (
            keyword(tokens[cursor], 'ON') &&
            (keyword(tokens[cursor + 1], 'DELETE') || keyword(tokens[cursor + 1], 'UPDATE'))
          ) {
            const event = tokens[cursor + 1].value.toUpperCase();
            const action = tokens[cursor + 2].value.toUpperCase();
            const value =
              action === 'NO' || action === 'SET'
                ? `${action} ${tokens[cursor + 3].value.toUpperCase()}`
                : action;
            if (!referenceActions.includes(value as ReferenceAction))
              throw new Error('Unknown foreign key action.');
            if (event === 'DELETE') onDelete = value as ReferenceAction;
            else onUpdate = value as ReferenceAction;
            cursor += action === 'NO' || action === 'SET' ? 4 : 3;
          } else if (keyword(tokens[cursor], 'MATCH')) {
            special = true;
            cursor += 2;
          } else if (
            keyword(tokens[cursor], 'DEFERRABLE') ||
            (keyword(tokens[cursor], 'NOT') && keyword(tokens[cursor + 1], 'DEFERRABLE'))
          ) {
            special = true;
            cursor += keyword(tokens[cursor], 'NOT') ? 2 : 1;
            if (keyword(tokens[cursor], 'INITIALLY')) cursor += 2;
          } else break;
        }
        endIndex = cursor - 1;
        result.push({
          id,
          definition: {
            kind: 'foreign-key',
            name,
            columns,
            referencedSchema,
            referencedTable,
            referencedColumns,
            onDelete,
            onUpdate,
          },
          ...(special
            ? {
                readOnlyReason:
                  'MATCH or deferred constraints require their full SQL definition to preserve semantics.',
              }
            : {}),
          source: { clause: clauseIndex, start, end: tokens[endIndex].end, whole },
        });
      }
      i = endIndex;
    }
  });
  return result;
}

export async function readTableConstraints(adapter: SqlAdapter, detail: TableStructure) {
  const { engine, schema, table } = detail;
  const capabilities: ConstraintCapabilities = {
    foreignKey: engine !== 'redis',
    check: engine !== 'redis',
    notEnforced: engine === 'sqlserver',
    actions:
      engine === 'sybase'
        ? ['NO ACTION']
        : engine === 'sqlserver'
          ? referenceActions.filter((a) => a !== 'RESTRICT')
          : engine === 'mysql'
            ? referenceActions.filter((a) => a !== 'SET DEFAULT')
            : [...referenceActions],
  };
  const query = async (sql: string, params: unknown[] = []) => {
    const result = await adapter.query(sql, params, options);
    if (result.hasMore) throw new Error('Constraint catalog exceeds the supported size.');
    return result.rows;
  };
  let constraints: TableConstraint[] = [];
  if (engine === 'sqlite' || engine === 'mysql') {
    constraints = parseTableConstraints(detail.definition, engine, schema);
    if (engine === 'mysql') {
      const version = String((await query('SELECT VERSION() AS version'))[0]?.version ?? '');
      const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.replace(/^5\.5\.5-/, ''));
      const code = parts ? Number(parts[1]) * 10000 + Number(parts[2]) * 100 + Number(parts[3]) : 0;
      const maria = /MariaDB/i.test(version);
      capabilities.check = maria ? code >= 100201 : code >= 80016;
      capabilities.notEnforced = !maria && capabilities.check;
      capabilities.foreignKey = /\bENGINE\s*=\s*(?:InnoDB|NDB(?:CLUSTER)?)\b/i.test(
        tableClauses(detail.definition, engine, detail.mysqlNoBackslashEscapes).suffix,
      );
      constraints = constraints.map((c) => ({ ...c, id: c.definition.name || c.id }));
    }
  } else if (engine === 'postgres') {
    const rows = await query(
      `SELECT con.conname AS name, con.contype AS kind, pg_get_expr(con.conbin, con.conrelid) AS expression,
      rn.nspname AS ref_schema, rc.relname AS ref_table, con.confdeltype AS on_delete, con.confupdtype AS on_update,
      con.condeferrable, con.convalidated, con.confmatchtype, con.connoinherit AS no_inherit,
      to_jsonb(con)->>'confdelsetcols' AS delete_set_columns, k.ord, a.attname AS column_name, ra.attname AS ref_column
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_class rc ON rc.oid=con.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rc.relnamespace
      LEFT JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY k(local_num,ref_num,ord) ON con.contype='f'
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.local_num
      LEFT JOIN pg_attribute ra ON ra.attrelid=rc.oid AND ra.attnum=k.ref_num
      WHERE n.nspname=$1 AND c.relname=$2 AND con.contype IN ('f','c') ORDER BY con.conname,k.ord`,
      [schema, table],
    );
    const actions: Record<string, ReferenceAction> = {
      a: 'NO ACTION',
      r: 'RESTRICT',
      c: 'CASCADE',
      n: 'SET NULL',
      d: 'SET DEFAULT',
    };
    const grouped = new Map<string, TableConstraint>();
    for (const row of rows) {
      const name = String(row.name);
      let constraint = grouped.get(name);
      if (!constraint) {
        constraint = {
          id: name,
          definition:
            row.kind === 'c'
              ? { kind: 'check', name, expression: String(row.expression), notEnforced: false }
              : {
                  kind: 'foreign-key',
                  name,
                  columns: [],
                  referencedSchema: String(row.ref_schema),
                  referencedTable: String(row.ref_table),
                  referencedColumns: [],
                  onDelete: actions[String(row.on_delete)],
                  onUpdate: actions[String(row.on_update)],
                },
        };
        if (
          row.condeferrable ||
          !row.convalidated ||
          (row.kind === 'c' && row.no_inherit) ||
          row.delete_set_columns != null ||
          (row.kind === 'f' && row.confmatchtype !== 's')
        )
          constraint.readOnlyReason =
            'Deferred, NOT VALID, NO INHERIT, SET NULL (columns) or MATCH constraints require their full SQL definition to preserve semantics.';
        grouped.set(name, constraint);
      }
      if (constraint.definition.kind === 'foreign-key') {
        constraint.definition.columns.push(String(row.column_name));
        constraint.definition.referencedColumns.push(String(row.ref_column));
      }
    }
    constraints = [...grouped.values()];
  } else if (engine === 'sybase') {
    const target = new SqlBuilder(engine).table(detail);
    const pairs = Array.from(
      { length: 16 },
      (_, i) =>
        `col_name(r.tableid,r.fokey${i + 1}) AS local${i + 1}, col_name(r.reftabid,r.refkey${i + 1}) AS remote${i + 1}`,
    ).join(',');
    for (const row of await query(
      `SELECT o.name,r.keycnt,r.pmrydbname,rt.name AS ref_table,user_name(rt.uid) AS ref_schema,${pairs}
      FROM dbo.sysreferences r JOIN dbo.sysobjects o ON o.id=r.constrid
      LEFT JOIN dbo.sysobjects rt ON rt.id=r.reftabid AND (r.pmrydbname IS NULL OR r.pmrydbname=db_name())
      WHERE r.tableid=object_id(?) ORDER BY o.name`,
      [target],
    )) {
      const crossDatabase = row.pmrydbname != null && !row.ref_table;
      constraints.push({
        id: String(row.name),
        definition: {
          kind: 'foreign-key',
          name: String(row.name),
          columns: Array.from({ length: Number(row.keycnt) }, (_, i) =>
            String(row[`local${i + 1}`]),
          ),
          referencedSchema: String(row.ref_schema ?? row.pmrydbname ?? ''),
          referencedTable: String(row.ref_table ?? ''),
          referencedColumns: Array.from({ length: Number(row.keycnt) }, (_, i) =>
            String(row[`remote${i + 1}`]),
          ),
          onDelete: 'NO ACTION',
          onUpdate: 'NO ACTION',
        },
        ...(crossDatabase
          ? { readOnlyReason: 'Cross-database ASE constraints require their full SQL definition.' }
          : {}),
      });
    }
    const checks = new Map<string, string>();
    for (const row of await query(
      `SELECT o.name,c.text FROM dbo.sysconstraints sc JOIN dbo.sysobjects o ON o.id=sc.constrid
      LEFT JOIN dbo.syscomments c ON c.id=sc.constrid WHERE sc.tableid=object_id(?) AND (sc.status & 128)=128
      ORDER BY o.name,c.number,c.colid2,c.colid`,
      [target],
    )) {
      if (row.text == null) throw new Error('ASE did not return a complete check definition.');
      checks.set(String(row.name), (checks.get(String(row.name)) ?? '') + String(row.text));
    }
    for (const [name, text] of checks)
      constraints.push({
        id: name,
        definition: {
          kind: 'check',
          name,
          expression: text
            .trim()
            .replace(/^CHECK\s*/i, '')
            .replace(/;\s*$/, ''),
          notEnforced: false,
        },
      });
  } else if (engine === 'sqlserver') {
    const target = new SqlBuilder(engine).table(detail);
    const rows = await query(
      `SELECT f.name, SCHEMA_NAME(t.schema_id) AS ref_schema,t.name AS ref_table,
      c.name AS column_name,rc.name AS ref_column,f.delete_referential_action_desc AS on_delete,
      f.update_referential_action_desc AS on_update,f.is_disabled,f.is_not_trusted,f.is_not_for_replication
      FROM sys.foreign_keys f JOIN sys.foreign_key_columns k ON k.constraint_object_id=f.object_id
      JOIN sys.tables t ON t.object_id=f.referenced_object_id JOIN sys.columns c ON c.object_id=k.parent_object_id AND c.column_id=k.parent_column_id
      JOIN sys.columns rc ON rc.object_id=k.referenced_object_id AND rc.column_id=k.referenced_column_id
      WHERE f.parent_object_id=OBJECT_ID(@p1) ORDER BY f.name,k.constraint_column_id`,
      [target],
    );
    const grouped = new Map<string, TableConstraint>();
    for (const row of rows) {
      const name = String(row.name);
      let constraint = grouped.get(name);
      if (!constraint) {
        constraint = {
          id: name,
          definition: {
            kind: 'foreign-key',
            name,
            columns: [],
            referencedSchema: String(row.ref_schema),
            referencedTable: String(row.ref_table),
            referencedColumns: [],
            onDelete: String(row.on_delete).replaceAll('_', ' ') as ReferenceAction,
            onUpdate: String(row.on_update).replaceAll('_', ' ') as ReferenceAction,
          },
        };
        if (row.is_disabled || row.is_not_trusted || row.is_not_for_replication)
          constraint.readOnlyReason =
            'Disabled, untrusted or replication constraints require their full SQL definition to preserve semantics.';
        grouped.set(name, constraint);
      }
      if (constraint.definition.kind === 'foreign-key') {
        constraint.definition.columns.push(String(row.column_name));
        constraint.definition.referencedColumns.push(String(row.ref_column));
      }
    }
    constraints = [...grouped.values()];
    for (const row of await query(
      'SELECT name,definition,is_disabled,is_not_for_replication FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(@p1) ORDER BY name',
      [target],
    ))
      constraints.push({
        id: String(row.name),
        definition: {
          kind: 'check',
          name: String(row.name),
          expression: String(row.definition),
          notEnforced: !!row.is_disabled,
        },
        ...(row.is_not_for_replication
          ? {
              readOnlyReason:
                'Replication constraints require their full SQL definition to preserve semantics.',
            }
          : {}),
      });
  }
  return { constraints, constraintCapabilities: capabilities };
}
