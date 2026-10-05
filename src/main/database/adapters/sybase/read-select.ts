import type { SelectInput } from '../../../../shared/types';
import type { SqlAdapter } from '../../adapter';
import { SqlBuilder, type ExactNumericProjection } from '../../sql-builder';
import { aseLegacyIdentifier } from './legacy-sql';

// ASE underlying type IDs, not usertype/name: aliases retain these storage types.
const exactNumericTypes = new Set([106, 108, 60, 122]); // decimal, numeric, money, smallmoney

/** Read only the metadata needed for a lossless browsing projection, not DDL/defaults. */
export async function aseReadSelect(
  adapter: SqlAdapter,
  input: SelectInput,
  limit: number,
  timeout: number,
) {
  await adapter.connect();
  const builder = new SqlBuilder('sybase');
  const legacy = (adapter as SqlAdapter & { aseMajorVersion?: number }).aseMajorVersion === 11;
  const target = legacy
    ? [input.schema, input.table]
        .filter((name): name is string => !!name)
        .map(aseLegacyIdentifier)
        .join('.')
    : builder.table(input);
  const metadata = await adapter.query(
    'SELECT c.name,c.type AS storage_type,c.prec AS col_precision,c.scale AS col_scale FROM dbo.syscolumns c WHERE c.id=object_id(?) ORDER BY c.colid',
    [target],
    { limit: 5000, timeout, readOnly: true },
  );
  if (metadata.hasMore || !metadata.rows.length)
    throw new Error('ASE column metadata is unavailable or exceeds the 5000-row limit.');
  const names = metadata.rows.map((column) => String(column.name));
  if (new Set(names).size !== names.length || names.some((name) => !name || name === 'undefined'))
    throw new Error('ASE column metadata contains invalid or duplicate names.');
  const textColumns = new Map<string, ExactNumericProjection>();
  for (const column of metadata.rows) {
    if (!exactNumericTypes.has(Number(column.storage_type))) continue;
    const money = [60, 122].includes(Number(column.storage_type));
    if (
      !money &&
      (!/^\d{1,2}$/.test(String(column.col_precision)) ||
        !/^\d{1,2}$/.test(String(column.col_scale)))
    )
      throw new Error('ASE numeric precision/scale metadata is missing or invalid.');
    const precision = money ? 38 : Number(column.col_precision);
    const scale = money ? 4 : Number(column.col_scale);
    if (
      !Number.isInteger(precision) ||
      precision < 1 ||
      precision > 38 ||
      !Number.isInteger(scale) ||
      scale < 0 ||
      scale > precision
    )
      throw new Error('ASE numeric precision/scale metadata is invalid.');
    textColumns.set(String(column.name), { kind: money ? 'money' : 'numeric', precision, scale });
  }
  // Do not assume case folding: ASE databases may have case-sensitive identifiers.
  if (
    input.columns?.some((name) => !names.includes(name)) ||
    input.sort?.some((sort) => !names.includes(sort.column))
  )
    throw new Error(
      'ASE selected column is unavailable in the column metadata. Use its exact catalog name.',
    );
  return builder.select({ ...input, columns: input.columns ?? names }, limit, textColumns);
}
