import { sqlTokens } from '../../object-sql';

/** Native SHOW CREATE VIEW syntax; FROM/JOIN scopes exclude column aliases,
 * expressions and CTE bindings from physical view dependencies. */
export function mysqlViewDependencies(sql: string, database: string): Set<string> {
  const tokens = sqlTokens(sql, 'mysql', true);
  const closes = new Map<number, number>(),
    stack: number[] = [],
    parents: (number | undefined)[] = [];
  const is = (i: number, value: string) =>
    !!tokens[i] && !tokens[i].quoted && tokens[i].value.toUpperCase() === value;
  const identifier = (i: number) =>
    !!tokens[i] &&
    (tokens[i].quoted ? sql[tokens[i].start] === '`' : /^[\p{L}\p{N}_$]+$/u.test(tokens[i].value));
  for (let i = 0; i < tokens.length; i++) {
    parents[i] = stack.at(-1);
    if (is(i, '(')) stack.push(i);
    else if (is(i, ')')) {
      const start = stack.pop();
      if (start !== undefined) closes.set(start, i);
    }
  }
  const bindings: { name: string; start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!is(i, 'WITH')) continue;
    let cursor = i + 1;
    const recursive = is(cursor, 'RECURSIVE');
    if (recursive) cursor++;
    const end = parents[i] === undefined ? tokens.length : closes.get(parents[i]!)!;
    while (identifier(cursor)) {
      const name = tokens[cursor++].value;
      if (is(cursor, '(')) cursor = (closes.get(cursor) ?? tokens.length) + 1;
      if (!is(cursor, 'AS') || !is(cursor + 1, '(')) break;
      const body = cursor + 1,
        close = closes.get(body);
      if (close === undefined) break;
      bindings.push({ name, start: recursive ? body : close + 1, end });
      cursor = close + 1;
      if (!is(cursor, ',')) break;
      cursor++;
    }
  }
  const dependencies = new Set<string>();
  type Scope = { select: boolean; from: boolean; expected: boolean };
  const scopes: Scope[] = [{ select: false, from: false, expected: false }];
  for (let i = 0; i < tokens.length; i++) {
    const scope = scopes.at(-1)!;
    if (is(i, '(')) {
      scopes.push({ select: false, from: scope.expected, expected: scope.expected });
      scope.expected = false;
      continue;
    }
    if (is(i, ')')) {
      if (scopes.length > 1) scopes.pop();
      continue;
    }
    if (is(i, 'SELECT')) {
      scope.select = true;
      scope.from = false;
      scope.expected = false;
      continue;
    }
    if (
      (is(i, 'FROM') && scope.select) ||
      ((is(i, 'JOIN') || is(i, 'STRAIGHT_JOIN')) && scope.from)
    ) {
      scope.from = true;
      scope.expected = true;
      continue;
    }
    if (
      [
        'WHERE',
        'GROUP',
        'HAVING',
        'ORDER',
        'LIMIT',
        'UNION',
        'EXCEPT',
        'INTERSECT',
        'WINDOW',
        'QUALIFY',
      ].some((word) => is(i, word))
    ) {
      scope.from = false;
      scope.expected = false;
      continue;
    }
    if (is(i, ',') && scope.from) {
      scope.expected = true;
      continue;
    }
    if (!scope.expected || is(i, 'LATERAL')) continue;
    if (!identifier(i)) continue;
    scope.expected = false;
    let schema: string | undefined,
      name = tokens[i].value;
    if (is(i + 1, '.') && identifier(i + 2)) {
      schema = name;
      name = tokens[i + 2].value;
      i += 2;
    }
    if (schema !== undefined && schema !== database) continue;
    if (
      schema === undefined &&
      bindings.some((b) => b.name.toLowerCase() === name.toLowerCase() && b.start <= i && i < b.end)
    )
      continue;
    // JSON_TABLE and other table functions are not physical view references.
    if (is(i + 1, '(')) continue;
    dependencies.add(name);
  }
  return dependencies;
}
