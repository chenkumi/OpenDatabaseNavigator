import { sqlTokens } from '../../object-sql';

export function aseLegacyIdentifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value))
    throw new Error('ASE 11.x currently supports only simple ASCII identifiers.');
  return value;
}

// ASE 11.x predates bracket-delimited identifiers. Translate only validated
// simple identifiers, never string literals/comments or arbitrary SQL fragments.
export function aseLegacySql(sql: string) {
  const tokens = sqlTokens(sql, 'sybase');
  for (const token of tokens.reverse()) {
    if (token.quoted && sql[token.start] === '[')
      sql = sql.slice(0, token.start) + aseLegacyIdentifier(token.value) + sql.slice(token.end);
  }
  return sql;
}
