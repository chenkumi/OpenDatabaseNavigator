import type { Engine, TableStructure, StructurePlan } from '../../shared/types';
import {
  viewOptionsSchema,
  type ViewCapabilities,
  type ViewOptions,
} from '../../shared/view-options';
import type { SqlAdapter } from './adapter';
import { SqlBuilder } from './sql-builder';
import { keyword, sqlTokens } from './object-sql';

async function rows(adapter: SqlAdapter, sql: string, params: unknown[] = []) {
  const result = await adapter.query(sql, params, { limit: 1000, timeout: 30000, readOnly: true });
  if (result.hasMore) throw new Error('View metadata exceeds the supported size.');
  return result.rows;
}
function account(value: string) {
  const at = value.lastIndexOf('@');
  if (at < 0) throw new Error('The server did not return a complete definer account.');
  return { user: value.slice(0, at), host: value.slice(at + 1) };
}
export async function viewCapabilities(
  adapter: SqlAdapter,
  engine: Engine,
): Promise<ViewCapabilities> {
  const result: ViewCapabilities = {
    algorithms: [],
    definer: false,
    securityModes: [],
    checkOptions: [],
  };
  if (engine === 'mysql') {
    result.algorithms = ['UNDEFINED', 'MERGE', 'TEMPTABLE'];
    result.definer = true;
    result.securityModes = ['DEFINER', 'INVOKER'];
    result.checkOptions = ['NONE', 'LOCAL', 'CASCADED'];
    const user = String(
      (await rows(adapter, 'SELECT CURRENT_USER() AS current_user_account'))[0]
        ?.current_user_account ?? '',
    );
    if (user) result.currentDefiner = account(user);
  } else if (engine === 'postgres') {
    result.checkOptions = ['NONE', 'LOCAL', 'CASCADED'];
    const version = Number(
      (await rows(adapter, "SELECT current_setting('server_version_num') AS version"))[0]?.version,
    );
    if (version >= 150000) result.securityModes = ['DEFINER', 'INVOKER'];
  } else if (engine === 'sqlserver' || engine === 'sybase')
    result.checkOptions = ['NONE', 'CASCADED'];
  return result;
}
export function checkOptionInSql(
  sql: string,
  engine: Engine,
): NonNullable<ViewOptions['checkOption']> {
  const tokens = sqlTokens(sql, engine).filter((t) => !keyword(t, ';'));
  const n = tokens.length;
  if (!keyword(tokens[n - 2], 'CHECK') || !keyword(tokens[n - 1], 'OPTION')) return 'NONE';
  if (keyword(tokens[n - 3], 'LOCAL') && keyword(tokens[n - 4], 'WITH')) return 'LOCAL';
  if (keyword(tokens[n - 3], 'CASCADED') && keyword(tokens[n - 4], 'WITH')) return 'CASCADED';
  return keyword(tokens[n - 3], 'WITH') ? 'CASCADED' : 'NONE';
}
export function replaceCheckOption(
  sql: string,
  engine: Engine,
  value: NonNullable<ViewOptions['checkOption']>,
) {
  const tokens = sqlTokens(sql, engine).filter((t) => !keyword(t, ';'));
  if (!tokens.length) throw new Error('The view definition is empty.');
  const existing = checkOptionInSql(sql, engine);
  const start =
    existing === 'NONE'
      ? tokens.at(-1)!.end
      : tokens[tokens.length - (keyword(tokens.at(-3), 'WITH') ? 3 : 4)].start;
  const core = sql.slice(0, start).trimEnd();
  return (
    core +
    (value === 'NONE'
      ? ''
      : `\nWITH ${engine === 'sqlserver' || engine === 'sybase' ? '' : `${value} `}CHECK OPTION`) +
    sql.slice(tokens.at(-1)!.end)
  );
}
export function validateViewOptions(input: ViewOptions, capabilities: ViewCapabilities) {
  const value = viewOptionsSchema.parse(input);
  if (value.algorithm && !capabilities.algorithms.includes(value.algorithm))
    throw new Error('View algorithms are not supported by this engine.');
  if (value.definer !== undefined && !capabilities.definer)
    throw new Error('Definer accounts are not supported by this engine.');
  if (value.security && !capabilities.securityModes.includes(value.security))
    throw new Error('This server version does not support the selected view security mode.');
  if (value.checkOption && !capabilities.checkOptions.includes(value.checkOption))
    throw new Error('This engine does not support the selected view check option.');
  if (value.algorithm === 'TEMPTABLE' && value.checkOption && value.checkOption !== 'NONE')
    throw new Error('TEMPTABLE views cannot use CHECK OPTION.');
  return value;
}
export function mysqlViewHeader(options: ViewOptions) {
  // Account names also allow an empty user (anonymous account).
  const q = (value: string) => '`' + value.replaceAll('`', '``') + '`';
  return (
    (options.algorithm ? ` ALGORITHM=${options.algorithm}` : '') +
    (options.definer !== undefined
      ? ` DEFINER=${options.definer === null ? 'CURRENT_USER' : `${q(options.definer.user)}@${q(options.definer.host)}`}`
      : '') +
    (options.security ? ` SQL SECURITY ${options.security}` : '')
  );
}
export async function createViewDefinition(
  adapter: SqlAdapter,
  engine: Engine,
  target: string,
  select: string,
  input?: ViewOptions,
) {
  const caps = await viewCapabilities(adapter, engine);
  const options = validateViewOptions(input ?? {}, caps);
  const properties =
    engine === 'postgres' && options.security
      ? ` WITH (security_invoker=${options.security === 'INVOKER' ? 'true' : 'false'})`
      : '';
  let sql = `CREATE${engine === 'mysql' ? mysqlViewHeader(options) : ''} VIEW ${target}${properties} AS\n${select}`;
  if (options.checkOption !== undefined) sql = replaceCheckOption(sql, engine, options.checkOption);
  return sql;
}
export async function readViewMetadata(adapter: SqlAdapter, detail: TableStructure) {
  detail.viewCapabilities = await viewCapabilities(adapter, detail.engine);
  if (detail.engine === 'mysql') {
    const row = (
      await rows(
        adapter,
        'SELECT DEFINER AS definer_account,SECURITY_TYPE AS security_type,CHECK_OPTION AS check_option FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
        [detail.schema, detail.table],
      )
    )[0];
    const tokens = sqlTokens(detail.definition, detail.engine),
      index = tokens.findIndex((t) => keyword(t, 'ALGORITHM'));
    const algorithm = index < 0 ? 'UNDEFINED' : tokens[index + 2]?.value.toUpperCase();
    if (!row?.definer_account || !row.security_type || !row.check_option)
      throw new Error('The database did not return complete view options.');
    detail.viewOptions = viewOptionsSchema.parse({
      algorithm,
      definer: account(String(row.definer_account)),
      security: String(row.security_type).toUpperCase(),
      checkOption: String(row.check_option).toUpperCase(),
    });
  } else if (detail.engine === 'postgres') {
    const row = (
      await rows(
        adapter,
        'SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2',
        [detail.schema, detail.table],
      )
    )[0];
    const properties = Array.isArray(row?.reloptions) ? (row.reloptions as string[]) : [];
    detail.viewOptions = {
      checkOption: (properties
        .find((p) => p.startsWith('check_option='))
        ?.split('=')[1]
        .toUpperCase() ?? 'NONE') as ViewOptions['checkOption'],
      ...(detail.viewCapabilities.securityModes.length
        ? { security: properties.includes('security_invoker=true') ? 'INVOKER' : 'DEFINER' }
        : {}),
    };
  } else if (detail.engine === 'sqlserver' || detail.engine === 'sybase')
    detail.viewOptions = { checkOption: checkOptionInSql(detail.definition, detail.engine) };
  else detail.viewOptions = {};
}
export function planViewOptions(
  detail: TableStructure & { prefix: string[] },
  input: ViewOptions,
): StructurePlan {
  if (detail.kind !== 'view' || detail.readOnlyReason)
    throw new Error(detail.readOnlyReason || 'This operation requires a view.');
  if (!detail.viewCapabilities) throw new Error('View capabilities are unavailable.');
  const options = validateViewOptions(input, detail.viewCapabilities);
  const merged = validateViewOptions(
    { ...detail.viewOptions, ...options },
    detail.viewCapabilities,
  );
  const changed = Object.keys(options).some(
    (key) =>
      JSON.stringify(options[key as keyof ViewOptions]) !==
      JSON.stringify(detail.viewOptions?.[key as keyof ViewOptions]),
  );
  if (!changed) throw new Error('There are no view option changes.');
  const b = new SqlBuilder(detail.engine),
    target = b.table(detail);
  const plan: StructurePlan = {
    statements: [],
    atomic: !['mysql', 'sybase'].includes(detail.engine),
    destructive: false,
  };
  if (detail.engine === 'postgres') {
    if (options.security)
      plan.statements.push(
        `ALTER VIEW ${target} SET (security_invoker=${options.security === 'INVOKER' ? 'true' : 'false'})`,
      );
    if (options.checkOption)
      plan.statements.push(
        `ALTER VIEW ${target} ${options.checkOption === 'NONE' ? 'RESET (check_option)' : `SET (check_option=${options.checkOption.toLowerCase()})`}`,
      );
  } else {
    const tokens = sqlTokens(detail.definition, detail.engine),
      view = tokens.findIndex((t) => keyword(t, 'VIEW'));
    if (view < 0) throw new Error('The view definition cannot be edited safely.');
    let end = view + 1;
    if (!tokens[end]) throw new Error('The view definition cannot be edited safely.');
    while (keyword(tokens[end + 1], '.')) end += 2;
    const body = `VIEW ${target}${detail.definition.slice(tokens[end].end)}`;
    let sql =
      detail.engine === 'mysql'
        ? `ALTER${mysqlViewHeader(merged)} ${body}`
        : `${detail.engine === 'sybase' ? 'CREATE OR REPLACE' : 'ALTER'} ${body}`;
    if (options.checkOption !== undefined)
      sql = replaceCheckOption(sql, detail.engine, options.checkOption);
    plan.statements = [...detail.prefix, sql];
  }
  return plan;
}
