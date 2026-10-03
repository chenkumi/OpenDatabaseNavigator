import sqlParser from 'node-sql-parser';
import type { Engine, Risk } from '../../shared/types';
const parser = new sqlParser.Parser();
const dialects = {
  sqlite: 'Sqlite',
  mysql: 'MySQL',
  postgres: 'Postgresql',
  sqlserver: 'TransactSQL',
  sybase: 'TransactSQL',
  redis: 'MySQL',
};
export interface SqlAnalysis {
  risk: Risk;
  statement: string;
  reason: string;
}
// Classification fails closed. Unknown SQL is never treated as a read operation.
export function analyzeSql(sql: string, engine: Engine): SqlAnalysis {
  const explain = /^\s*EXPLAIN\s+(?:QUERY\s+PLAN\s+)?([\s\S]+)$/i.exec(sql);
  if (explain && !/^EXPLAIN\b/i.test(explain[1])) {
    const inner = analyzeSql(explain[1], engine);
    return inner.risk === 'read'
      ? { risk: 'read', statement: 'explain', reason: 'Explain a verified read-only query.' }
      : {
          risk: 'destructive',
          statement: 'explain',
          reason: 'EXPLAIN accepts only verified read-only SELECT queries.',
        };
  }
  let ast: any;
  try {
    const parsed = parser.astify(sql, { database: dialects[engine] });
    const statements = Array.isArray(parsed) ? parsed : [parsed];
    if (statements.length !== 1)
      throw new Error('Only one SQL statement is permitted per execution.');
    ast = statements[0];
  } catch (error) {
    return {
      risk: 'destructive',
      statement: 'unknown',
      reason: error instanceof Error ? error.message.slice(0, 200) : 'Unsupported SQL',
    };
  }
  const type = ast.type?.toLowerCase();
  if (type === 'select') {
    let unsafe = false;
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      // SELECT INTO, locking reads and data-modifying CTEs are not read-only.
      if (node.into && Object.values(node.into).some(Boolean)) unsafe = true;
      if (node.locking_read || node.for_update) unsafe = true;
      if (['insert', 'update', 'delete', 'replace', 'call'].includes(node.type)) unsafe = true;
      // Database functions can have arbitrary side effects. Only known pure functions pass.
      if (node.type === 'function') {
        const name = (node.name?.name ?? [])
          .map((part: any) => part.value)
          .join('.')
          .toUpperCase();
        if (!PURE_FUNCTIONS.has(name)) unsafe = true;
      }
      Object.values(node).forEach((value) =>
        Array.isArray(value) ? value.forEach(walk) : walk(value),
      );
    };
    walk(ast);
    return unsafe
      ? {
          risk: 'destructive',
          statement: type,
          reason: 'SELECT contains effects or an untrusted function.',
        }
      : { risk: 'read', statement: type, reason: 'Single read-only SELECT.' };
  }
  if (type === 'insert') return { risk: 'insert', statement: type, reason: 'Inserts rows.' };
  if (type === 'update' || type === 'delete')
    return {
      risk: ast.where ? type : 'destructive',
      statement: type,
      reason: ast.where ? 'Modifies matching rows.' : 'Modifies rows without WHERE.',
    };
  if (type === 'drop' || type === 'truncate')
    return { risk: 'destructive', statement: type, reason: 'Destroys database objects or data.' };
  if (['create', 'alter', 'rename'].includes(type))
    return { risk: 'ddl', statement: type, reason: 'Changes database structure.' };
  return {
    risk: 'destructive',
    statement: type ?? 'unknown',
    reason: 'Statement requires explicit destructive-operation approval.',
  };
}
const PURE_FUNCTIONS = new Set([
  'ABS',
  'ROUND',
  'CEIL',
  'CEILING',
  'FLOOR',
  'LOWER',
  'UPPER',
  'LENGTH',
  'CHAR_LENGTH',
  'COALESCE',
  'NULLIF',
  'IFNULL',
  'ISNULL',
  'CONCAT',
  'SUBSTR',
  'SUBSTRING',
  'TRIM',
  'LTRIM',
  'RTRIM',
  'REPLACE',
  'DATE',
  'DATETIME',
  'STRFTIME',
  'DATE_TRUNC',
  'DATE_PART',
  'EXTRACT',
  'NOW',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'CAST',
  'CONVERT',
  'IIF',
]);
