import { createHash } from 'node:crypto';
import type { Connection } from '../../../shared/types';
import type { DropObjectRef } from '../../../shared/drop-object';
import type { SqlAdapter } from '../../database/adapter';
import { SqlBuilder } from '../../database/sql-builder';
import { describeStructure } from './table-structure-service';
import { readObjectDefinition } from './database-object-service';
import { listDatabaseObjects } from './database-metadata';

export async function planDropObject(
  adapter: SqlAdapter,
  connection: Connection,
  ref: DropObjectRef,
) {
  if (connection.engine === 'redis') throw new Error('Redis does not support SQL objects.');
  const b = new SqlBuilder(connection.engine);
  const target = b.table({ schema: ref.schema, table: ref.objectName });
  let version: string;
  let ownedObjects: string[] = [];
  let dependents: string[] = [];
  let sql = `DROP ${ref.kind.toUpperCase()} ${target}`;
  if (ref.kind === 'table' || ref.kind === 'view') {
    const details = await describeStructure(adapter, connection, { ...ref, table: ref.objectName });
    if (details.kind !== ref.kind) throw new Error('Object kind changed. Refresh the browser.');
    if (details.readOnlyReason) throw new Error(details.readOnlyReason);
    const owned = (
      await Promise.all(
        ['index', 'trigger'].map((kind) =>
          listDatabaseObjects(adapter, connection, kind as 'index' | 'trigger', {
            schema: ref.schema,
            table: ref.objectName,
          }),
        ),
      )
    )
      .flat()
      .filter((item) => item.schema === ref.schema && item.table === ref.objectName)
      .sort((a, c) => a.name.localeCompare(c.name));
    ownedObjects = owned.map((item) => `${item.kind}: ${item.name}`);
    if (connection.engine === 'sqlite' && ref.kind === 'table') {
      // With foreign keys on, DROP TABLE first deletes the table's rows, which fires
      // ON DELETE CASCADE / SET NULL / SET DEFAULT in child tables.
      const children = await adapter.query(
        `SELECT m.name AS child, f.on_delete AS action FROM sqlite_schema m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND lower(f."table") = lower(?) AND lower(m.name) <> lower(?) AND f.on_delete IN ('CASCADE', 'SET NULL', 'SET DEFAULT') ORDER BY m.name`,
        [ref.objectName, ref.objectName],
        { limit: 5000, timeout: 30000, readOnly: true },
      );
      dependents = children.rows.map((row) => `${row.child} (ON DELETE ${row.action})`);
    }
    version = createHash('sha256')
      .update(JSON.stringify([details.version, owned, dependents]))
      .digest('hex');
  } else {
    const details = await readObjectDefinition(adapter, connection, { ...ref, kind: ref.kind });
    if (details.readOnlyReason) throw new Error(details.readOnlyReason);
    version = details.version;
    if (ref.kind === 'index' && connection.engine === 'sybase')
      sql = `DROP INDEX ${b.table(ref)}.${b.quote(ref.objectName)}`;
    if (
      (ref.kind === 'index' && ['mysql', 'sqlserver'].includes(connection.engine)) ||
      (ref.kind === 'trigger' && connection.engine === 'postgres')
    )
      sql = `DROP ${ref.kind.toUpperCase()} ${b.quote(ref.objectName)} ON ${b.table(ref)}`;
  }
  return { engine: connection.engine, statements: [sql], version, ownedObjects, dependents };
}
