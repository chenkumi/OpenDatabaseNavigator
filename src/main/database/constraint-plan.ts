import { randomUUID } from 'node:crypto';
import {
  constraintDefinitionSchema,
  type ConstraintChange,
  type ConstraintDefinition,
} from '../../shared/constraints';
import type { TableStructure, StructurePlan } from '../../shared/types';
import { SqlBuilder } from './sql-builder';
import { tableClauses, validateFragment } from './structure-sql';

export function constraintSql(detail: TableStructure, input: ConstraintDefinition) {
  const definition = constraintDefinitionSchema.parse(input);
  const length =
    detail.engine === 'postgres'
      ? Buffer.byteLength(definition.name, 'utf8')
      : definition.name.length;
  if (length > (detail.engine === 'postgres' ? 63 : detail.engine === 'mysql' ? 64 : 128))
    throw new Error('Constraint name exceeds the engine limit.');
  const capabilities = detail.constraintCapabilities;
  const b = new SqlBuilder(detail.engine),
    q = (name: string) => b.quote(name);
  if (!capabilities?.[definition.kind === 'check' ? 'check' : 'foreignKey'])
    throw new Error('This server does not support this constraint operation.');
  const prefix = `CONSTRAINT ${q(definition.name)} `;
  if (definition.kind === 'check') {
    validateFragment(definition.expression, detail.engine);
    if (definition.notEnforced && !capabilities.notEnforced)
      throw new Error('This server does not support NOT ENFORCED checks.');
    return `${prefix}CHECK (${definition.expression})${detail.engine === 'mysql' && definition.notEnforced ? ' NOT ENFORCED' : ''}`;
  }
  if (
    definition.columns.length !== definition.referencedColumns.length ||
    (detail.engine === 'sybase' && definition.columns.length > 16) ||
    new Set(definition.columns).size !== definition.columns.length ||
    new Set(definition.referencedColumns).size !== definition.referencedColumns.length
  )
    throw new Error('Choose matching, distinct foreign key column pairs.');
  if (definition.columns.some((name) => !detail.columns.some((column) => column.name === name)))
    throw new Error('Choose existing foreign key columns.');
  if (
    ![definition.onDelete, definition.onUpdate].every((action) =>
      capabilities.actions.includes(action),
    )
  )
    throw new Error('The server does not support this referential action.');
  if (
    [definition.onDelete, definition.onUpdate].includes('SET NULL') &&
    definition.columns.some(
      (name) => !detail.columns.find((column) => column.name === name)?.nullable,
    )
  )
    throw new Error('SET NULL requires nullable foreign key columns.');
  if (detail.engine === 'sqlite' && definition.referencedSchema !== detail.schema)
    throw new Error('SQLite foreign keys must reference the same database.');
  const target =
    detail.engine === 'sqlite'
      ? q(definition.referencedTable)
      : b.table({ schema: definition.referencedSchema, table: definition.referencedTable });
  return (
    `${prefix}FOREIGN KEY (${definition.columns.map(q).join(', ')}) REFERENCES ${target} (${definition.referencedColumns.map(q).join(', ')})` +
    (detail.engine === 'sybase'
      ? ''
      : ` ON DELETE ${definition.onDelete} ON UPDATE ${definition.onUpdate}`)
  );
}

export function planConstraintChange(
  detail: TableStructure & { dependents: string[]; sqliteRowid?: string },
  change: ConstraintChange,
): StructurePlan {
  if (detail.kind !== 'table') throw new Error('Constraints require a table.');
  const existing = change.id
    ? detail.constraints?.find((item) => item.id === change.id)
    : undefined;
  if (change.id && !existing) throw new Error('The constraint no longer exists.');
  if (existing?.readOnlyReason && change.action !== 'constraint-drop')
    throw new Error(existing.readOnlyReason);
  if (
    change.action === 'constraint-upsert' &&
    detail.constraints?.some(
      (item) =>
        item.id !== change.id &&
        item.definition.name.toLowerCase() === change.constraint.name.toLowerCase(),
    )
  )
    throw new Error('Choose a unique constraint name.');
  if (
    change.action === 'constraint-upsert' &&
    existing &&
    existing.definition.kind !== change.constraint.kind
  )
    throw new Error('Keep the original constraint kind.');
  const definition =
    change.action === 'constraint-upsert' ? constraintSql(detail, change.constraint) : undefined;
  const b = new SqlBuilder(detail.engine),
    q = (s: string) => b.quote(s),
    target = b.table(detail);
  const plan: StructurePlan = {
    statements: [],
    atomic: !['mysql', 'sybase'].includes(detail.engine),
    destructive: !!existing,
  };
  if (detail.engine === 'sqlite') {
    const parsed = tableClauses(detail.definition, 'sqlite');
    if (existing) {
      if (!existing.source) throw new Error('The constraint source is unavailable.');
      const source = existing.source;
      if (source.whole) parsed.clauses.splice(source.clause, 1);
      else {
        const clause = parsed.clauses[source.clause];
        parsed.clauses[source.clause] = (
          clause.slice(0, source.start) + clause.slice(source.end)
        ).trim();
      }
    }
    if (definition) parsed.clauses.push(definition);
    const names = detail.columns.filter((column) => !column.generated).map((column) => column.name);
    if (detail.sqliteRowid) names.unshift(detail.sqliteRowid);
    const columns = names.map(q).join(', '),
      scratch = q(`dw_constraints_${randomUUID().replaceAll('-', '')}`);
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
  const clauses: string[] = [];
  if (existing)
    clauses.push(
      `DROP ${
        detail.engine === 'mysql'
          ? existing.definition.kind === 'foreign-key'
            ? 'FOREIGN KEY'
            : detail.constraintCapabilities?.notEnforced
              ? 'CHECK'
              : 'CONSTRAINT'
          : 'CONSTRAINT'
      } ${q(existing.definition.name)}`,
    );
  if (definition) clauses.push(`ADD ${definition}`);
  if (
    detail.engine === 'mysql' &&
    existing?.definition.kind === 'foreign-key' &&
    change.action === 'constraint-upsert' &&
    existing.definition.name.toLowerCase() === change.constraint.name.toLowerCase()
  ) {
    plan.statements = clauses.map((clause) => `ALTER TABLE ${target} ${clause}`);
    plan.recoveryStatements = [
      `ALTER TABLE ${target} ADD ${constraintSql(detail, existing.definition)}`,
    ];
    plan.notice =
      'MySQL/MariaDB replaces a same-name foreign key in separate statements. There is a gap without enforcement; failure attempts to restore the original constraint. Review the recovery SQL before applying.';
  } else if (detail.engine === 'mysql')
    plan.statements = [`ALTER TABLE ${target} ${clauses.join(', ')}`];
  else plan.statements = clauses.map((clause) => `ALTER TABLE ${target} ${clause}`);
  if (
    detail.engine === 'sqlserver' &&
    change.action === 'constraint-upsert' &&
    change.constraint.kind === 'check' &&
    change.constraint.notEnforced
  ) {
    plan.statements[plan.statements.length - 1] =
      `ALTER TABLE ${target} WITH NOCHECK ADD ${definition}`;
    plan.statements.push(`ALTER TABLE ${target} NOCHECK CONSTRAINT ${q(change.constraint.name)}`);
  }
  return plan;
}
