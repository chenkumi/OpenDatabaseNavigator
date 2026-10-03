import type { Engine } from '../../shared/types';
import { keyword, sqlTokens } from './object-sql';

/** Change only the declared name, never references, strings, comments or body SQL. */
export function renameDefinition(
  sql: string,
  engine: Engine,
  kind: 'view' | 'index' | 'trigger',
  quotedName: string,
) {
  const tokens = sqlTokens(sql, engine);
  if (!keyword(tokens[0], 'CREATE') && !keyword(tokens[0], 'ALTER'))
    throw new Error('Complete object definition is required for renaming.');
  const at = tokens.findIndex((token) => keyword(token, kind.toUpperCase()));
  if (at < 1 || at > 15) throw new Error('Object definition header could not be read safely.');
  let start = at + 1;
  const conditional =
    keyword(tokens[start], 'IF') &&
    keyword(tokens[start + 1], 'NOT') &&
    keyword(tokens[start + 2], 'EXISTS');
  if (conditional) start += 3;
  let end = start;
  if (keyword(tokens[end + 1], '.')) end += 2;
  if (!tokens[start] || !tokens[end]) throw new Error('Object definition has no name.');
  // A rename must fail on a conflicting destination, including concurrent creation.
  return (
    sql.slice(0, tokens[conditional ? at + 1 : start].start) +
    quotedName +
    sql.slice(tokens[end].end)
  );
}
