import { createHash } from 'node:crypto';
import type { Engine } from '../../shared/types';
import {
  databasePropertyChangeSchema,
  type DatabaseProperties,
  type DatabasePropertyChange,
} from '../../shared/database-options';
import type { SqlAdapter } from './adapter';
import { databaseOptions, validateDatabaseOptions } from './create-database';
import { SqlBuilder } from './sql-builder';

export async function readDatabaseProperties(
  adapter: SqlAdapter,
  engine: Engine,
  database: string,
): Promise<DatabaseProperties> {
  const read = async (sql: string, params: unknown[] = []) =>
    (await adapter.query(sql, params, { limit: 1, timeout: 10000, readOnly: true })).rows[0];
  const base = { engine, database, editable: { charset: false, collation: false }, notice: '' };
  let properties: Omit<DatabaseProperties, 'version'>;
  if (engine === 'mysql') {
    const row = await read(
      'SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database],
    );
    if (!row) throw new Error('Database not found or not visible to this account.');
    properties = {
      ...base,
      charset: String(row.charset),
      collation: String(row.collation),
      editable: { charset: true, collation: true },
      notice:
        'Changes affect defaults for new tables only. Existing columns and data are not converted.',
    };
  } else if (engine === 'sqlserver') {
    const row = await read(
      "SELECT collation_name AS collation, COLLATIONPROPERTY(collation_name, 'CodePage') AS codepage FROM sys.databases WHERE name = @p1",
      [database],
    );
    if (!row) throw new Error('Database not found or not visible to this account.');
    const system = ['master', 'model', 'msdb', 'tempdb'].includes(database.toLowerCase());
    properties = {
      ...base,
      charset: `Code page ${row.codepage}`,
      collation: String(row.collation),
      editable: { charset: false, collation: !system },
      notice: system
        ? 'System database collation follows server configuration and is read-only here.'
        : 'Changing collation releases this app’s connections to this database. Other clients may prevent the change. Existing column collations are not converted.',
    };
  } else if (engine === 'postgres') {
    const row = await read(
      "SELECT pg_encoding_to_char(encoding) AS charset, datcollate AS collation, datctype AS ctype, to_jsonb(d)->>'datlocprovider' AS provider, COALESCE(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale') AS locale FROM pg_database d WHERE datname = $1",
      [database],
    );
    if (!row) throw new Error('Database not found or not visible to this account.');
    properties = {
      ...base,
      charset: String(row.charset),
      collation: String(row.collation),
      lcCtype: String(row.ctype),
      localeProvider: row.provider === 'i' ? 'icu' : row.provider === 'b' ? 'builtin' : 'libc',
      locale: String(row.locale || row.collation),
      notice: 'PostgreSQL encoding and locale cannot be changed after creation.',
    };
  } else if (engine === 'sqlite') {
    const row = await read('PRAGMA encoding');
    properties = {
      ...base,
      charset: String(row?.encoding),
      notice: 'SQLite encoding is fixed once tables exist. Collations are configured per column.',
    };
  } else if (engine === 'sybase') {
    properties = {
      ...base,
      notice:
        'ASE character set and sort order are server-wide settings, not per-database properties.',
    };
  } else throw new Error('Database properties are not supported by this engine.');
  return {
    ...properties,
    version: createHash('sha256').update(JSON.stringify(properties)).digest('hex'),
  };
}

export async function planDatabaseProperties(
  adapter: SqlAdapter,
  engine: Engine,
  database: string,
  input: DatabasePropertyChange,
  version: string,
) {
  const changes = databasePropertyChangeSchema.parse(input);
  const current = await readDatabaseProperties(adapter, engine, database);
  if (current.version !== version)
    throw new Error('Database properties changed. Refresh before applying your changes.');
  if (
    (changes.charset && !current.editable.charset) ||
    (changes.collation && !current.editable.collation)
  )
    throw new Error('This database property is read-only for this engine.');
  if (!changes.charset && !changes.collation) throw new Error('No database property changes.');
  await validateDatabaseOptions(changes, await databaseOptions(engine, adapter));
  const builder = new SqlBuilder(engine);
  return {
    sql:
      `ALTER DATABASE ${builder.quote(database)}` +
      (changes.charset ? ` CHARACTER SET ${builder.quote(changes.charset)}` : '') +
      (changes.collation
        ? ` COLLATE ${engine === 'mysql' ? builder.quote(changes.collation) : changes.collation}`
        : ''),
    version: current.version,
    notice: current.notice,
  };
}
