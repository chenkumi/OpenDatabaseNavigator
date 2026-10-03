import type { Engine } from '../../shared/types';
import { SQL_FILE_LIMIT, type ScriptUnit } from '../../shared/sql-script';
import { sqlTokens } from './object-sql';

/** Client-side delimiters only. SQL semantics are left to the selected server. */
export function splitSqlScript(
  source: string,
  engine: Engine,
  mysqlNoBackslashEscapes = false,
  mysqlAnsiQuotes = false,
): ScriptUnit[] {
  if (engine === 'redis') throw new Error('SQL files are not supported for Redis.');
  if (Buffer.byteLength(source, 'utf8') > SQL_FILE_LIMIT)
    throw new Error('SQL files are limited to 16 MiB.');
  // Newlines inside SQL literals are data. Do not normalize CRLF globally.
  const sql = source.replace(/^\uFEFF/, '');
  const batches: ScriptUnit[] = [];
  let i = 0,
    start = 0,
    line = 1,
    startLine = 1,
    delimiter = ';',
    content = false,
    words: string[] = [],
    depth = 0;
  const tsql = engine === 'sqlserver' || engine === 'sybase';
  let sqliteTrigger = false,
    sqliteAfterSemi = false,
    sqliteEnd = false;
  const initialMode = { noBackslash: mysqlNoBackslashEscapes, ansi: mysqlAnsiQuotes };
  const savedModes = new Map<string, typeof initialMode>();
  const push = (end: number, repeat = 1) => {
    if (content) {
      const text = sql.slice(start, end).trim();
      if (words[0] === 'COPY' && words.includes('STDIN') && engine === 'postgres')
        throw new Error(
          `Line ${startLine}: COPY FROM STDIN requires a native dump tool; use INSERT statements in SQL files.`,
        );
      if (
        engine === 'postgres' &&
        ['SET', 'RESET'].includes(words[0]) &&
        (/\bstandard_conforming_strings\b/i.test(text) || words[1] === 'ALL')
      ) {
        const tokens = sqlTokens(text, 'postgres');
        if (
          words[0] === 'RESET' ||
          !['ON', 'TRUE', '1'].includes(tokens.at(-1)?.value.toUpperCase() ?? '')
        )
          throw new Error(
            `Line ${startLine}: SQL files require standard_conforming_strings=on; use E strings for backslash escapes.`,
          );
      }
      for (let n = 0; n < repeat; n++) batches.push({ sql: text, line: startLine });
      if (batches.length > 50000)
        throw new Error('SQL files are limited to 50000 statements/batches.');
      if (engine === 'mysql') {
        const tokens = sqlTokens(text, 'mysql', mysqlNoBackslashEscapes, mysqlAnsiQuotes);
        if (tokens[0]?.value.toUpperCase() === 'SET' && !tokens[0].quoted) {
          let from = 1,
            parens = 0;
          for (let t = 1; t <= tokens.length; t++) {
            if (!tokens[t]?.quoted && tokens[t]?.value === '(') parens++;
            if (!tokens[t]?.quoted && tokens[t]?.value === ')') parens--;
            if (t < tokens.length && (tokens[t].quoted || tokens[t].value !== ',' || parens))
              continue;
            const assignment = tokens.slice(from, t),
              equal = assignment.findIndex((v) => !v.quoted && v.value === '=');
            from = t + 1;
            if (equal < 0) continue;
            const lhs = assignment
                .slice(0, equal)
                .map((v) => v.value)
                .join('')
                .toUpperCase(),
              rhs = assignment.slice(equal + 1);
            const right = rhs
              .map((v) => v.value)
              .join('')
              .toUpperCase();
            if (/^@[A-Z_][A-Z_0-9]*$/.test(lhs) && /^@@(?:SESSION\.)?SQL_MODE$/.test(right))
              savedModes.set(lhs, { noBackslash: mysqlNoBackslashEscapes, ansi: mysqlAnsiQuotes });
            if (!/^(?:SESSION|LOCAL|@@(?:SESSION\.)?)?SQL_MODE$/.test(lhs)) continue;
            let mode: typeof initialMode | undefined;
            if (
              rhs.length === 1 &&
              rhs[0].quoted &&
              text[rhs[0].start] !== '`' &&
              /^[A-Z0-9_,]*$/.test(right)
            )
              mode = {
                noBackslash: right.split(',').includes('NO_BACKSLASH_ESCAPES'),
                ansi: right.split(',').includes('ANSI_QUOTES') || right.split(',').includes('ANSI'),
              };
            else if (right === 'DEFAULT') mode = initialMode;
            else mode = savedModes.get(right);
            if (!mode)
              throw new Error(
                `Line ${startLine}: use a literal SQL_MODE or restore a previously saved @@SQL_MODE; dynamic mode expressions cannot be split reliably.`,
              );
            mysqlNoBackslashEscapes = mode.noBackslash;
            mysqlAnsiQuotes = mode.ansi;
          }
        }
      }
    }
    content = false;
    words = [];
    depth = 0;
    sqliteTrigger = false;
    sqliteAfterSemi = false;
    sqliteEnd = false;
  };
  while (i < sql.length) {
    if (i === 0 || sql[i - 1] === '\n') {
      const end = sql.indexOf('\n', i),
        lineEnd = end < 0 ? sql.length : end;
      const text = sql.slice(i, lineEnd);
      if (
        /^\s*(?:\\|\.(?:read|shell|system)\b|:(?:r|setvar|connect)\b|!!)/i.test(text) ||
        (!content && /^\s*SOURCE\s/i.test(text))
      )
        throw new Error(`Line ${line}: client file/shell commands are not supported in SQL files.`);
      const go = tsql ? /^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i.exec(text) : null;
      const delimMatch = engine === 'mysql' ? /^\s*DELIMITER\s+(\S+)\s*$/i.exec(text) : null;
      const delim = delimMatch && (!content || !/\w/.test(delimMatch[1])) ? delimMatch : null;
      if (go || delim) {
        if (go) {
          const repeat = Number(go[1] || 1);
          if (repeat < 1 || repeat > 1000)
            throw new Error(`Line ${line}: GO count must be 1–1000.`);
          push(i, repeat);
        } else {
          if (content)
            throw new Error(`Line ${line}: DELIMITER must follow a completed statement.`);
          if (delim![1].length > 32 || /[\w'"`\\]/.test(delim![1]))
            throw new Error(`Line ${line}: unsupported delimiter.`);
          delimiter = delim![1];
        }
        i = lineEnd;
        start = i;
        startLine = line;
        continue;
      }
    }
    const c = sql[i];
    if (/\s/.test(c)) {
      if (c === '\n') line++;
      i++;
      continue;
    }
    if (
      (sql.startsWith('--', i) && (engine !== 'mysql' || /\s/.test(sql[i + 2] || ' '))) ||
      (engine === 'mysql' && c === '#')
    ) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      if (engine === 'mysql' && (sql[i + 2] === '!' || sql.slice(i + 2, i + 4) === 'M!')) {
        if (!content) startLine = line;
        content = true;
      }
      let nesting = 1;
      i += 2;
      while (i < sql.length && nesting) {
        if (sql.startsWith('/*', i) && ['postgres', 'sqlserver', 'sybase'].includes(engine)) {
          nesting++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          nesting--;
          i += 2;
        } else {
          if (sql[i] === '\n') line++;
          i++;
        }
      }
      if (nesting) throw new Error(`Line ${line}: unterminated block comment.`);
      continue;
    }
    if (!tsql && sql.startsWith(delimiter, i) && depth === 0) {
      if (sqliteTrigger && !sqliteEnd) {
        sqliteAfterSemi = true;
        i++;
        continue;
      }
      push(i);
      i += delimiter.length;
      start = i;
      startLine = line;
      continue;
    }
    if (!content) startLine = line;
    content = true;
    if (c === '$' && engine === 'postgres') {
      const tag = /^(\$[a-zA-Z_][\w]*\$|\$\$)/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error(`Line ${line}: unterminated dollar quote.`);
        line += (sql.slice(i, end + tag.length).match(/\n/g) || []).length;
        i = end + tag.length;
        continue;
      }
    }
    if (["'", '"', '`'].includes(c) || (c === '[' && (tsql || engine === 'sqlite'))) {
      sqliteAfterSemi = false;
      sqliteEnd = false;
      const close = c === '[' ? ']' : c;
      const escapes =
        (engine === 'mysql' &&
          c !== '`' &&
          !(c === '"' && mysqlAnsiQuotes) &&
          !mysqlNoBackslashEscapes) ||
        (engine === 'postgres' && /[eE]/.test(sql[i - 1] || '') && !/[\w]/.test(sql[i - 2] || ''));
      let closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\n') line++;
        if (escapes && sql[i] === '\\') {
          if (sql[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new Error(`Line ${line}: unterminated quoted value.`);
      continue;
    }
    const word = (
      engine === 'postgres' ? /^[A-Za-z_][A-Za-z_0-9$]*/ : /^[A-Za-z_][A-Za-z_0-9]*/
    ).exec(sql.slice(i))?.[0];
    if (word) {
      const upper = word.toUpperCase();
      words.push(upper);
      sqliteTrigger ||=
        engine === 'sqlite' && words[0] === 'CREATE' && words.slice(0, 4).includes('TRIGGER');
      sqliteEnd = sqliteAfterSemi && upper === 'END';
      sqliteAfterSemi = false;
      if (engine === 'postgres' && upper === 'ATOMIC' && words.at(-2) === 'BEGIN') depth++;
      else if (engine === 'postgres' && depth > 0 && upper === 'CASE') depth++;
      if (engine === 'postgres' && upper === 'END' && depth > 0) depth--;
      i += word.length;
      continue;
    }
    sqliteAfterSemi = false;
    sqliteEnd = false;
    i++;
  }
  if (depth || (sqliteTrigger && !sqliteEnd))
    throw new Error(`Line ${startLine}: incomplete compound statement.`);
  push(sql.length);
  if (!batches.length) throw new Error('The SQL file contains no statements.');
  return batches;
}
