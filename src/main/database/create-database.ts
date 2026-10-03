import type { Engine } from '../../shared/types';
import { SqlBuilder } from './sql-builder';
import {
  databaseCreateOptionsSchema,
  type DatabaseCreateOptions,
  type DatabaseOptions,
} from '../../shared/database-options';
import type { SqlAdapter } from './adapter';

export function createDatabaseSql(engine: Engine, name: string, input: DatabaseCreateOptions = {}) {
  const options = databaseCreateOptionsSchema.strict().parse(input);
  if (!['postgres', 'mysql', 'sqlserver', 'sybase'].includes(engine))
    throw new Error(
      'This engine does not support CREATE DATABASE. SQLite uses database files; Redis databases are configured by the server.',
    );
  if (!name.trim() || name !== name.trim() || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error(
      'Enter a database name without leading/trailing whitespace or control characters.',
    );
  const length = engine === 'postgres' ? Buffer.byteLength(name, 'utf8') : name.length;
  const max = engine === 'postgres' ? 63 : engine === 'mysql' ? 64 : 128;
  if (length > max) throw new Error(`Database name exceeds the engine limit (${max}).`);
  if (options.charset && !['mysql', 'postgres'].includes(engine))
    throw new Error(
      'Database character set selection is supported for MySQL / MariaDB and PostgreSQL.',
    );
  if (options.collation && !['mysql', 'sqlserver'].includes(engine))
    throw new Error(
      'Database collation selection is currently supported only for MySQL / MariaDB and SQL Server.',
    );
  const builder = new SqlBuilder(engine);
  const pg = options.localeProvider || options.locale || options.lcCtype;
  if (pg && engine !== 'postgres')
    throw new Error('Locale settings are supported only for PostgreSQL.');
  if (engine === 'postgres') {
    const literal = (value: string) =>
      "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
    return (
      `CREATE DATABASE ${builder.quote(name)}` +
      (options.charset || pg ? ' TEMPLATE template0' : '') +
      (options.charset ? ` ENCODING ${literal(options.charset)}` : '') +
      (options.localeProvider ? ` LOCALE_PROVIDER ${options.localeProvider}` : '') +
      (options.locale
        ? ` ${options.localeProvider === 'icu' ? 'ICU_LOCALE' : options.localeProvider === 'builtin' ? 'BUILTIN_LOCALE' : 'LOCALE'} ${literal(options.locale)}`
        : '') +
      (options.lcCtype ? ` LC_CTYPE ${literal(options.lcCtype)}` : '')
    );
  }
  return (
    `CREATE DATABASE ${builder.quote(name)}` +
    (options.charset ? ` CHARACTER SET ${builder.quote(options.charset)}` : '') +
    (options.collation
      ? ` COLLATE ${engine === 'mysql' ? builder.quote(options.collation) : options.collation}`
      : '')
  );
}

/** Internal catalog read; callers enter through the authorized command bus. */
export async function databaseOptions(
  engine: Engine,
  adapter: SqlAdapter,
): Promise<DatabaseOptions> {
  if (engine === 'postgres') {
    const query = async (sql: string) => {
      const r = await adapter.query(sql, [], { limit: 10000, timeout: 10000, readOnly: true });
      if (r.hasMore) throw new Error('The server locale list exceeds the supported catalog size.');
      return r.rows;
    };
    const version = Number(
      (await query("SELECT current_setting('server_version_num') AS version"))[0]?.version,
    );
    const charsets = (
      await query('SELECT pg_encoding_to_char(id) AS name FROM generate_series(0,34) AS id')
    )
      .map((r) => String(r.name))
      .filter(Boolean);
    const catalog = await query(
      "SELECT collprovider,collcollate,collencoding,COALESCE(to_jsonb(c)->>'colllocale',to_jsonb(c)->>'colliculocale') AS locale FROM pg_collation c WHERE collprovider IN ('c','i','b') AND COALESCE((to_jsonb(c)->>'collisdeterministic')::boolean,true) ORDER BY collname",
    );
    const providers: NonNullable<DatabaseOptions['postgres']>['providers'] =
      version >= 150000 ? ['libc'] : [];
    if (version >= 150000 && catalog.some((r) => r.collprovider === 'i')) providers.push('icu');
    if (version >= 170000) providers.push('builtin');
    const locales: NonNullable<DatabaseOptions['postgres']>['locales'] = [];
    for (const row of catalog) {
      const provider =
        row.collprovider === 'c' ? 'libc' : row.collprovider === 'i' ? 'icu' : 'builtin';
      const name = String(provider === 'libc' ? (row.collcollate ?? '') : (row.locale ?? ''));
      if (
        name &&
        (provider === 'libc' || providers.includes(provider)) &&
        !locales.some((l) => l.provider === provider && l.name === name)
      )
        locales.push({ provider, name });
    }
    for (const name of ['C', 'POSIX'])
      if (!locales.some((l) => l.provider === 'libc' && l.name === name))
        locales.push({ provider: 'libc', name });
    if (version >= 170000)
      for (const name of ['C', 'C.UTF-8'])
        if (!locales.some((l) => l.provider === 'builtin' && l.name === name))
          locales.push({ provider: 'builtin', name });
    return { charsets, collations: [], postgres: { version, providers, locales } };
  }
  if (engine !== 'mysql' && engine !== 'sqlserver') return { charsets: [], collations: [] };
  const result = await adapter.query(
    engine === 'mysql'
      ? 'SELECT * FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY ORDER BY COLLATION_NAME, CHARACTER_SET_NAME'
      : 'SELECT name FROM sys.fn_helpcollations() ORDER BY name',
    [],
    { limit: 10000, timeout: 10000, readOnly: true },
  );
  if (result.hasMore)
    throw new Error('The server collation list exceeds the supported catalog size.');
  const collations = result.rows.map((row) => ({
    name: String(engine === 'mysql' ? (row.FULL_COLLATION_NAME ?? row.COLLATION_NAME) : row.name),
    ...(engine === 'mysql' ? { charset: String(row.CHARACTER_SET_NAME) } : {}),
  }));
  return {
    charsets: [
      ...new Set(collations.flatMap((item) => (item.charset ? [item.charset] : []))),
    ].sort(),
    collations,
  };
}

export function validateDatabaseOptions(
  options: DatabaseCreateOptions,
  available: DatabaseOptions,
) {
  if (options.localeProvider || options.locale || options.lcCtype) {
    const pg = available.postgres;
    if (!pg) throw new Error('Locale settings are supported only for PostgreSQL.');
    if (options.localeProvider && !pg.providers.includes(options.localeProvider))
      throw new Error('The selected locale provider is not available on this server.');
    if (
      options.localeProvider === 'builtin' &&
      (!options.locale ||
        !pg.locales.some((l) => l.provider === 'builtin' && l.name === options.locale))
    )
      throw new Error('Select a supported built-in locale.');
    if (options.localeProvider === 'icu' && !options.locale)
      throw new Error('Enter an ICU locale.');
    if (options.localeProvider === 'icu' && options.charset && options.charset !== 'UTF8')
      throw new Error('ICU databases require UTF8 encoding.');
  }
  if (options.charset && !available.charsets.includes(options.charset))
    throw new Error('The selected character set is not available on this server.');
  if (options.collation) {
    const collation = available.collations.find((item) => item.name === options.collation);
    if (!collation) throw new Error('The selected collation is not available on this server.');
    if (options.charset && collation.charset !== options.charset)
      throw new Error('The selected collation does not belong to the selected character set.');
  }
}
