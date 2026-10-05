import type { Engine } from '../../shared/types';
import { keyword, sqlTokens } from './object-sql';

export function tableClauses(sql: string, engine: Engine, noBackslash = false) {
  const tokens = sqlTokens(sql, engine, noBackslash);
  let depth = 0,
    start = 0,
    bodyStart = 0,
    bodyEnd = 0;
  const clauses: string[] = [];
  for (const token of tokens) {
    if (keyword(token, '(')) {
      depth++;
      if (depth === 1) start = bodyStart = token.end;
    } else if ((keyword(token, ',') && depth === 1) || (keyword(token, ')') && depth === 1)) {
      clauses.push(sql.slice(start, token.start).trim());
      start = token.end;
      if (keyword(token, ')')) {
        bodyEnd = token.start;
        break;
      }
    } else if (keyword(token, ')')) depth--;
  }
  if (!bodyEnd) throw new Error('The table definition cannot be edited safely.');
  return { clauses, prefix: sql.slice(0, bodyStart), suffix: sql.slice(bodyEnd) };
}

export function columnClause(clauses: string[], name: string, engine: Engine, noBackslash = false) {
  return clauses.findIndex((clause) => {
    const first = sqlTokens(clause, engine, noBackslash)[0];
    return (
      first?.value === name &&
      (first.quoted ||
        !['PRIMARY', 'FOREIGN', 'UNIQUE', 'CONSTRAINT', 'CHECK'].includes(
          first.value.toUpperCase(),
        ))
    );
  });
}

const attributes = new Set(
  'CONSTRAINT PRIMARY NOT NULL UNIQUE CHECK DEFAULT COLLATE REFERENCES GENERATED AS AUTOINCREMENT AUTO_INCREMENT COMMENT ON VIRTUAL STORED INVISIBLE VISIBLE COLUMN_FORMAT STORAGE SRID'.split(
    ' ',
  ),
);
export function columnAttribute(
  clause: string,
  engine: Engine,
  attribute: 'type' | 'nullable' | 'default',
  noBackslash = false,
) {
  const tokens = sqlTokens(clause, engine, noBackslash);
  let depth = 0;
  const starts: number[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (keyword(t, '(')) depth++;
    else if (keyword(t, ')')) depth--;
    else if (
      !depth &&
      !t.quoted &&
      (attributes.has(t.value.toUpperCase()) ||
        (i > 1 && keyword(t, 'CHARACTER') && keyword(tokens[i + 1], 'SET')))
    )
      starts.push(i);
  }
  if (attribute === 'type')
    return {
      start: tokens[0].end,
      end: tokens[starts[0]]?.start ?? clause.length,
      value: clause.slice(tokens[0].end, tokens[starts[0]]?.start).trim(),
    };
  let i = starts.find((index) =>
    attribute === 'default'
      ? keyword(tokens[index], 'DEFAULT')
      : (keyword(tokens[index], 'NULL') && !keyword(tokens[index - 1], 'DEFAULT')) ||
        (keyword(tokens[index], 'NOT') && keyword(tokens[index + 1], 'NULL')),
  );
  if (i === undefined) return { start: clause.length, end: clause.length, value: '' };
  const begin = tokens[i].start;
  if (attribute === 'nullable') {
    if (keyword(tokens[i], 'NOT')) i++;
    i++;
    if (keyword(tokens[i], 'ON') && keyword(tokens[i + 1], 'CONFLICT')) i += 3;
    // A named nullability constraint must be removed with its name.
    const previous = tokens.findIndex((t) => t.start === begin);
    const start = keyword(tokens[previous - 2], 'CONSTRAINT') ? tokens[previous - 2].start : begin;
    return {
      start,
      end: tokens[i]?.start ?? clause.length,
      value: clause.slice(begin, tokens[i]?.start).trim(),
    };
  }
  const expressionStart = i + 1;
  i++;
  if (keyword(tokens[i], '+') || keyword(tokens[i], '-')) i++;
  if (keyword(tokens[i], '(')) {
    let nested = 0;
    do {
      if (keyword(tokens[i], '(')) nested++;
      if (keyword(tokens[i], ')')) nested--;
      i++;
    } while (i < tokens.length && nested);
  } else {
    if (/^(?:N|[BX]|_[A-Za-z0-9]+)$/i.test(tokens[i]?.value ?? '') && tokens[i + 1]?.quoted) i += 2;
    else i++;
    if (keyword(tokens[i], '(')) {
      let nested = 0;
      do {
        if (keyword(tokens[i], '(')) nested++;
        if (keyword(tokens[i], ')')) nested--;
        i++;
      } while (i < tokens.length && nested);
    }
  }
  const defaultIndex = tokens.findIndex((token) => token.start === begin);
  return {
    start: keyword(tokens[defaultIndex - 2], 'CONSTRAINT') ? tokens[defaultIndex - 2].start : begin,
    end: tokens[i]?.start ?? clause.length,
    value: clause.slice(tokens[expressionStart].start, tokens[i]?.start).trim(),
  };
}

export function replaceAttribute(
  clause: string,
  engine: Engine,
  attribute: 'type' | 'nullable' | 'default',
  value: string,
) {
  const range = columnAttribute(clause, engine, attribute);
  return [clause.slice(0, range.start).trimEnd(), value, clause.slice(range.end).trimStart()]
    .filter(Boolean)
    .join(' ');
}

export function validateFragment(value: string, engine: Engine, type = false) {
  if (!value.trim()) throw new Error('A SQL type or expression is required.');
  if (engine === 'mysql') {
    // Whether a backslash escapes a quote depends on the server's sql_mode. If the
    // two readings disagree, the text could be split into extra actions server-side.
    const bounds = (noBackslash: boolean) =>
      JSON.stringify(
        sqlTokens(value, engine, noBackslash).map((token) => [token.start, token.end]),
      );
    const normal = bounds(false); // invalid text fails here with its usual message
    let other: string | undefined;
    try {
      other = bounds(true);
    } catch {
      /* Unreadable under the other mode: ambiguous. */
    }
    if (normal !== other)
      throw new Error(
        'Backslashes inside quoted values are ambiguous in MySQL. Remove the backslash or avoid quotes in this value.',
      );
  }
  const tokens = sqlTokens(value, engine);
  let previous = 0;
  for (const token of tokens) {
    if (value.slice(previous, token.start).trim())
      throw new Error('SQL comments are not permitted in column types or defaults.');
    previous = token.end;
  }
  if (value.slice(previous).trim())
    throw new Error('SQL comments are not permitted in column types or defaults.');
  const extra =
    'KILL CHECKPOINT PRINT THROW RAISERROR IF WHILE GOTO RETURN BREAK CONTINUE BULK OPEN ENABLE DISABLE';
  let depth = 0;
  const forbidden = new Set(
    'SELECT INSERT UPDATE DELETE MERGE CREATE ALTER DROP TRUNCATE EXEC EXECUTE GRANT REVOKE DENY USE SET DECLARE BEGIN COMMIT ROLLBACK PRAGMA ATTACH DETACH BACKUP RESTORE DBCC WAITFOR SHUTDOWN RECONFIGURE'.split(
      ' ',
    ),
  );
  // T-SQL runs a following statement without a separator, so a default such as
  // `0 KILL 53` would become a second command. IF is a plain function elsewhere.
  if (engine === 'sqlserver' || engine === 'sybase')
    for (const word of extra.trim().split(' ')) forbidden.add(word);
  for (const token of tokens) {
    if (keyword(token, '(')) depth++;
    if (keyword(token, ')') && --depth < 0) throw new Error('Unbalanced SQL expression.');
    if (
      !token.quoted &&
      (token.value === ';' ||
        (token.value === ',' && depth === 0) ||
        (forbidden.has(token.value.toUpperCase()) &&
          !(type && engine === 'mysql' && token === tokens[0] && keyword(token, 'SET'))))
    )
      throw new Error('Only a SQL type or scalar expression is permitted.');
    if (type && !token.quoted && attributes.has(token.value.toUpperCase()))
      throw new Error('Enter only the data type; use the separate column options for constraints.');
  }
  if (depth || !tokens.length) throw new Error('Unbalanced SQL expression.');
}
