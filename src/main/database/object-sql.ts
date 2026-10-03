import type { Engine } from '../../shared/types';

export interface SqlToken {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
}
// Token positions let us replace only the immutable object header, leaving SQL
// bodies, comments, expressions and quoted semicolons exactly as authored.
export function sqlTokens(
  sql: string,
  engine: Engine,
  mysqlNoBackslashEscapes = false,
  mysqlAnsiQuotes = false,
): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i) || (engine === 'mysql' && sql[i] === '#')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      // SHOW CREATE uses version comments for options such as INVISIBLE and
      // WITH PARSER. Tokenize their payload too, so clause checks cannot be
      // bypassed by hiding another ALTER action inside an executable comment.
      const version =
        engine === 'mysql' ? /^\/\*(?:!|M!)(?:\d{5,6})?\s*/.exec(sql.slice(i))?.[0] : undefined;
      if (version) {
        const start = i + version.length;
        const end = sql.indexOf('*/', start);
        if (end < 0) throw new Error('Unterminated SQL comment.');
        tokens.push(
          ...sqlTokens(sql.slice(start, end), engine, mysqlNoBackslashEscapes, mysqlAnsiQuotes).map(
            (token) => ({
              ...token,
              start: token.start + start,
              end: token.end + start,
            }),
          ),
        );
        i = end + 2;
        continue;
      }
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment.');
      continue;
    }
    const start = i,
      char = sql[i];
    // PostgreSQL E'...' strings treat backslash as an escape, unlike plain strings.
    const pgEscapeString =
      engine === 'postgres' && char === "'" && /(?<![\p{L}\p{N}_$])[eE]$/u.test(sql.slice(0, i));
    if (["'", '"', '`', '['].includes(char)) {
      const close = char === '[' ? ']' : char;
      let value = '',
        closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            value += close;
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else if (
          sql[i] === '\\' &&
          engine === 'mysql' &&
          char !== '`' &&
          !(char === '"' && mysqlAnsiQuotes) &&
          !mysqlNoBackslashEscapes
        ) {
          value += sql[i + 1] ?? '';
          i += 2;
        } else value += sql[i++];
      }
      if (!closed) throw new Error('Unterminated SQL quote.');
      tokens.push({ value, start, end: i, quoted: true });
      continue;
    }
    if (char === '$' && engine === 'postgres') {
      const tag = /^(\$[\w]*\$)/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error('Unterminated SQL body.');
        i = end + tag.length;
        tokens.push({ value: sql.slice(start, i), start, end: i, quoted: true });
        continue;
      }
    }
    const word = /^[\p{L}\p{N}_$]+/u.exec(sql.slice(i))?.[0];
    i += word?.length ?? 1;
    tokens.push({ value: word ?? char, start, end: i, quoted: false });
  }
  return tokens;
}
export const keyword = (token: SqlToken | undefined, word: string) =>
  !!token && !token.quoted && token.value.toUpperCase() === word;

export function objectHeader(sql: string, engine: Engine, kind: 'index' | 'trigger') {
  const tokens = sqlTokens(sql, engine);
  let i = 0;
  const take = (word: string) => keyword(tokens[i], word) && (++i, true);
  if (!take('CREATE')) throw new Error('Use a CREATE definition.');
  if (kind === 'index') {
    take('UNIQUE');
    take('CLUSTERED') || take('NONCLUSTERED');
  } else if (take('DEFINER')) {
    if (!take('=')) throw new Error('Invalid DEFINER.');
    i++;
    if (take('@')) i++;
  }
  if (!take(kind.toUpperCase())) throw new Error(`Expected CREATE ${kind.toUpperCase()}.`);
  const nameStart = tokens[i]?.start;
  const readName = () => {
    if (!tokens[i]) throw new Error('Missing object identifier.');
    const parts = [tokens[i++].value];
    if (take('.')) parts.push(tokens[i++].value);
    return parts;
  };
  const name = readName();
  const nameEnd = tokens[i - 1].end;
  if (kind === 'index' && take('USING')) i++;
  while (i < tokens.length && !keyword(tokens[i], 'ON')) i++;
  if (!take('ON')) throw new Error('Missing target table.');
  const tableStart = tokens[i]?.start;
  const table = readName();
  return {
    tokens,
    name,
    table,
    nameStart: nameStart!,
    nameEnd,
    tableStart,
    tableEnd: tokens[i - 1].end,
  };
}

export function sameIdentifier(parts: string[], schema: string, name: string) {
  return parts.length === 1
    ? parts[0] === name
    : parts.length === 2 && parts[0] === schema && parts[1] === name;
}

export function assertSqliteTrigger(sql: string) {
  const tokens = sqlTokens(sql, 'sqlite');
  let depth = 0,
    started = false,
    ended = false;
  for (const token of tokens) {
    if (ended && !keyword(token, ';')) throw new Error('Only one trigger definition is permitted.');
    if (keyword(token, 'BEGIN') || keyword(token, 'CASE')) {
      started = true;
      depth++;
    }
    if (keyword(token, 'END')) {
      depth--;
      if (!depth) ended = true;
    }
  }
  if (!started || !ended || depth)
    throw new Error('A complete BEGIN / END trigger body is required.');
}

export function mysqlIndexClause(createTable: string, name: string, noBackslash = false) {
  const tokens = sqlTokens(createTable, 'mysql', noBackslash);
  let depth = 0,
    start = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (keyword(t, '(')) {
      depth++;
      if (depth === 1) start = i + 1;
    }
    if ((keyword(t, ',') && depth === 1) || (keyword(t, ')') && depth === 1)) {
      const segment = tokens.slice(start, i);
      const key = segment.findIndex((item) => keyword(item, 'KEY') || keyword(item, 'INDEX'));
      if (key >= 0 && segment[key + 1]?.value === name && !keyword(segment[0], 'CONSTRAINT'))
        return createTable.slice(segment[0].start, t.start).trim();
      start = i + 1;
    }
    if (keyword(t, ')')) depth--;
  }
  throw new Error('Index definition not found in SHOW CREATE TABLE.');
}
