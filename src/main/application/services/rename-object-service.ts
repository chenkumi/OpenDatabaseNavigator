import { createHash } from 'node:crypto';
import type { Connection } from '../../../shared/types';
import type { RenameObjectInput } from '../../../shared/rename-object';
import type { SqlAdapter } from '../../database/adapter';
import { SqlBuilder } from '../../database/sql-builder';
import { renameDefinition } from '../../database/rename-definition';
import { objectHeader, sqlTokens } from '../../database/object-sql';
import { planDropObject } from './drop-object-service';
import { readObjectDefinition } from './database-object-service';
import { listDatabaseObjects } from './database-metadata';

const options = { limit: 5000, timeout: 30000, readOnly: true };
const literal = (name: string) => "'" + name.replaceAll("'", "''") + "'";
export async function planRenameObject(
  adapter: SqlAdapter,
  connection: Connection,
  input: RenameObjectInput,
) {
  const { engine } = connection;
  if (engine === 'redis') throw new Error('Redis does not support SQL objects.');
  if (input.newName.toLowerCase() === input.objectName.toLowerCase())
    throw new Error('Enter a different object name. Case-only renames are not supported.');
  const max =
    engine === 'postgres' ? 63 : engine === 'mysql' ? 64 : engine === 'sybase' ? 253 : 128;
  if (
    (['postgres', 'sybase'].includes(engine)
      ? Buffer.byteLength(input.newName, 'utf8')
      : [...input.newName].length) > max
  )
    throw new Error(`Object name exceeds the database limit (${max}).`);
  if (engine === 'sqlite' && (input.schema !== 'main' || /^sqlite_/i.test(input.newName)))
    throw new Error('SQLite renaming requires main and a non-system object name.');
  const b = new SqlBuilder(engine),
    q = (name: string) => b.quote(name);
  const old = b.table({ schema: input.schema, table: input.objectName });
  const next = b.table({ schema: input.schema, table: input.newName });
  const table = b.table(input);
  const base = await planDropObject(adapter, connection, input);
  // Avoid replacement even when the server allows CREATE ... IF NOT EXISTS.
  const objects = [
    ...(await adapter.tables(input.schema)).map((item) => ({ ...item, table: '' })),
    ...(await listDatabaseObjects(adapter, connection, 'index', {
      schema: input.schema,
      name: input.newName,
    })),
    ...(await listDatabaseObjects(adapter, connection, 'trigger', {
      schema: input.schema,
      name: input.newName,
    })),
  ];
  if (
    objects.some(
      (item) =>
        item.schema === input.schema &&
        item.name.toLowerCase() === input.newName.toLowerCase() &&
        // MySQL/SQL Server/ASE index names and PostgreSQL trigger names are table scoped.
        ((!(input.kind === 'index' && ['mysql', 'sqlserver', 'sybase'].includes(engine)) &&
          !(input.kind === 'trigger' && engine === 'postgres')) ||
          item.table === input.table),
    )
  )
    throw new Error('An object with that name already exists.');
  let statements: string[] = [],
    restore: string[] = [];
  let notice =
    'References in queries, views, routines and application code may need updating. Review dependent objects after renaming.';
  if (engine === 'postgres') {
    statements = [
      input.kind === 'trigger'
        ? `ALTER TRIGGER ${q(input.objectName)} ON ${table} RENAME TO ${q(input.newName)}`
        : `ALTER ${input.kind.toUpperCase()} ${old} RENAME TO ${q(input.newName)}`,
    ];
  } else if (engine === 'sqlserver' || engine === 'sybase') {
    statements = [
      `EXEC ${engine === 'sqlserver' ? 'sys.' : ''}sp_rename ${literal(input.kind === 'index' ? `${table}.${q(input.objectName)}` : old)}, ${literal(input.newName)}${engine === 'sqlserver' ? `, '${input.kind === 'index' ? 'INDEX' : 'OBJECT'}'` : input.kind === 'index' ? ", 'index'" : ''}`,
    ];
  } else if (engine === 'mysql') {
    if (input.kind === 'table' || input.kind === 'view') {
      statements = [`RENAME TABLE ${old} TO ${next}`];
      notice += ' MySQL/MariaDB object-specific grants do not move to the new name.';
    } else if (input.kind === 'index')
      statements = [
        `ALTER TABLE ${table} RENAME INDEX ${q(input.objectName)} TO ${q(input.newName)}`,
      ];
    else {
      const detail = await readObjectDefinition(adapter, connection, { ...input, kind: 'trigger' });
      statements = [
        ...detail.prefix,
        `DROP TRIGGER ${old}`,
        renameDefinition(detail.editableSql, engine, 'trigger', next),
      ];
      restore = detail.restore;
      notice =
        'MySQL/MariaDB renames triggers by rebuilding them. There is a gap without the trigger; failure attempts to restore the original definition. SQL mode, definer and firing order are retained.';
    }
  } else if (engine === 'sqlite') {
    if (input.kind === 'table') statements = [`ALTER TABLE ${old} RENAME TO ${q(input.newName)}`];
    else {
      const result = await adapter.query(
        'SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name',
        [],
        options,
      );
      if (result.hasMore)
        throw new Error('Too many SQLite definitions to verify dependencies safely.');
      const rows = result.rows;
      const source = rows.find((row) => row.type === input.kind && row.name === input.objectName);
      if (!source) throw new Error('Complete object definition is required for renaming.');
      const ownTriggers =
        input.kind === 'view'
          ? rows.filter((row) => row.type === 'trigger' && row.tbl_name === input.objectName)
          : [];
      const mentions = (sql: string) =>
        sqlTokens(sql, engine).some(
          (token) => token.value.toLowerCase() === input.objectName.toLowerCase(),
        );
      if (input.kind === 'view' || input.kind === 'index') {
        // No token-wide substitution: it would corrupt column names, aliases and literals.
        const dependent = rows.find(
          (row) => row !== source && !ownTriggers.includes(row) && mentions(String(row.sql)),
        );
        if (dependent)
          throw new Error(
            `SQLite object is referenced by ${dependent.type} ${dependent.name}. Update or remove dependencies before renaming.`,
          );
      }
      const create = renameDefinition(String(source.sql), engine, input.kind, next);
      statements = [`DROP ${input.kind.toUpperCase()} ${old}`, create];
      for (const trigger of ownTriggers) {
        const sql = String(trigger.sql),
          header = objectHeader(sql, engine, 'trigger');
        if (mentions(sql.slice(header.tableEnd)))
          throw new Error(
            `SQLite trigger ${trigger.name} references the old view in its body. Update dependencies before renaming.`,
          );
        statements.push(
          sql.slice(0, header.tableStart) + q(input.newName) + sql.slice(header.tableEnd),
        );
      }
      notice =
        'SQLite rebuilds this object in one transaction, preserving its definition. Dependent view references must be resolved before renaming.';
      base.version = createHash('sha256')
        .update(JSON.stringify([base.version, rows]))
        .digest('hex');
    }
  }
  if (!statements.length) throw new Error('Renaming is not supported for this object.');
  return {
    ...base,
    statements,
    restore,
    notice,
    atomic: engine === 'sqlite' || engine === 'postgres' || engine === 'sqlserver',
    version: createHash('sha256')
      .update(JSON.stringify([base.version, input.newName, statements]))
      .digest('hex'),
  };
}

export async function executeRename(
  adapter: SqlAdapter,
  plan: Awaited<ReturnType<typeof planRenameObject>>,
  timeout: number,
) {
  if (plan.restore.length) {
    if (!('replaceObject' in adapter))
      throw new Error('Trigger replacement is not supported by this adapter.');
    await (
      adapter as SqlAdapter & {
        replaceObject(sql: string[], restore: string[], timeout: number): Promise<void>;
      }
    ).replaceObject(plan.statements, plan.restore, timeout);
  } else {
    if (!adapter.executeDdl) throw new Error('DDL execution is not supported by this adapter.');
    await adapter.executeDdl(plan.statements, timeout, { validateViews: true });
  }
}
