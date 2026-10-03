import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * DDL statements actually sent to the database while a command runs. The command
 * bus opens a scope per command and the connection layer fills it, so the audit
 * trail shows the SQL that ran, not only the arguments that asked for it.
 */
export const executedSql = new AsyncLocalStorage<string[]>();
export function recordExecutedSql(statements: unknown) {
  const scope = executedSql.getStore();
  if (scope && Array.isArray(statements))
    for (const statement of statements) if (typeof statement === 'string') scope.push(statement);
}
