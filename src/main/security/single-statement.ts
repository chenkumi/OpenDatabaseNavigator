import type { Engine } from '../../shared/types';

// Enforce the same execution boundary across drivers, including SQL Server
// batches. Quoted identifiers/literals and PostgreSQL dollar bodies may contain ;.
export function assertSingleStatement(
  sql: string,
  engine: Engine,
  mysqlNoBackslashEscapes = false,
) {
  let ended = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (/\s/.test(char)) continue;
    if (sql.startsWith('--', i) || (engine === 'mysql' && char === '#')) {
      const end = sql.indexOf('\n', i);
      if (end < 0) return;
      i = end;
      continue;
    }
    if (sql.startsWith('/*', i)) {
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
      i--;
      continue;
    }
    if (char === ';') {
      ended = true;
      continue;
    }
    if (ended)
      throw new Error(
        'Only one SQL statement is permitted per execution. Select a single statement in the editor.',
      );
    if (char === '$' && engine === 'postgres') {
      const tag = /^(\$[a-zA-Z_][a-zA-Z_0-9]*\$|\$\$)/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) return;
        i = end + tag.length - 1;
        continue;
      }
    }
    if (
      ["'", '"', '`'].includes(char) ||
      (char === '[' && ['sqlserver', 'sybase'].includes(engine))
    ) {
      const close = char === '[' ? ']' : char;
      const escapes =
        (engine === 'mysql' && char !== '`' && !mysqlNoBackslashEscapes) ||
        (engine === 'postgres' && /[eE]/.test(sql[i - 1] ?? '') && !/[\w]/.test(sql[i - 2] ?? ''));
      for (i++; i < sql.length; i++) {
        if (escapes && sql[i] === '\\') i++;
        else if (sql[i] === close) {
          if (sql[i + 1] === close) i++;
          else break;
        }
      }
    }
  }
}
