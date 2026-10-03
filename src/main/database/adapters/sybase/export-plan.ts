import { splitSqlScript } from '../../sql-script-parser';
import { sqlTokens, keyword } from '../../object-sql';

export function aseDdlSignature(sql: string) {
  return JSON.stringify(
    splitSqlScript(sql, 'sybase').map((batch) =>
      sqlTokens(batch.sql, 'sybase').map(({ value, quoted }) => [value, quoted]),
    ),
  );
}

/** ddlgen -FRI,TR removes foreign keys and triggers. Prove that its result is
 * an unchanged subsequence of the complete native script before inserting data.
 * Unknown/native inline rewrites fail instead of guessing how to rewrite DDL. */
export function aseDataRestorePlan(full: string, filtered: string) {
  const base = splitSqlScript(filtered, 'sybase');
  for (const batch of base) {
    const tokens = sqlTokens(batch.sql, 'sybase');
    const create = keyword(tokens[0], 'CREATE');
    const alter = keyword(tokens[0], 'ALTER');
    if (
      (create &&
        (keyword(tokens[1], 'TRIGGER') ||
          (keyword(tokens[1], 'OR') && keyword(tokens[3], 'TRIGGER')))) ||
      ((create || alter) &&
        keyword(tokens[1], 'TABLE') &&
        tokens.some((token) => keyword(token, 'REFERENCES') || keyword(token, 'TRIGGER')))
    )
      throw new Error(
        'ASE ddlgen did not filter all foreign keys and triggers. Export structure only.',
      );
  }
  const signatures = base.map((batch) => aseDdlSignature(batch.sql));
  let cursor = 0;
  const deferred: string[] = [],
    context: string[] = [];
  for (const batch of splitSqlScript(full, 'sybase')) {
    const tokens = sqlTokens(batch.sql, 'sybase');
    const setting = keyword(tokens[0], 'USE') || keyword(tokens[0], 'SET');
    if (setting) context.push(batch.sql + '\nGO\n');
    if (signatures[cursor] === aseDdlSignature(batch.sql)) {
      cursor++;
      continue;
    }
    if (setting) continue;
    const trigger = keyword(tokens[0], 'CREATE') && keyword(tokens[1], 'TRIGGER');
    const foreignKey =
      keyword(tokens[0], 'ALTER') &&
      keyword(tokens[1], 'TABLE') &&
      tokens.some((token) => keyword(token, 'ADD')) &&
      tokens.some((token) => keyword(token, 'REFERENCES'));
    const permission = keyword(tokens[0], 'GRANT') || keyword(tokens[0], 'REVOKE');
    const procedure =
      keyword(tokens[0], 'EXEC') || keyword(tokens[0], 'EXECUTE') ? tokens[1] : tokens[0];
    const triggerOrder =
      procedure && !procedure.quoted && procedure.value.toLowerCase() === 'sp_settriggerorder';
    if (!trigger && !foreignKey && !permission && !triggerOrder)
      throw new Error(
        'ASE ddlgen produced a schema layout that cannot safely defer constraints and triggers. Export structure only.',
      );
    deferred.push(...context, batch.sql + '\nGO\n');
    context.length = 0;
  }
  if (cursor !== base.length)
    throw new Error(
      'ASE filtered schema differs from the complete schema. No data export was saved.',
    );
  return { before: filtered + '\nGO\n', after: deferred.join('') };
}
