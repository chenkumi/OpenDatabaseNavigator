import type { Connection } from '../../../shared/types';
import type { CreateObjectInput } from '../../../shared/create-object';
import type { SqlAdapter } from '../../database/adapter';
import { SqlBuilder } from '../../database/sql-builder';
import { validateFragment } from '../../database/structure-sql';
import { keyword, sqlTokens, assertSqliteTrigger } from '../../database/object-sql';
import { assertSingleStatement } from '../../security/single-statement';
import { generationCapabilities, generatedDefinition } from '../../database/generated-columns';
import { createViewDefinition } from '../../database/view-options';
import { createIndexStatements } from '../../database/index-options';

export async function planCreateObject(
  adapter: SqlAdapter,
  connection: Connection,
  input: CreateObjectInput,
) {
  const engine = connection.engine;
  if (engine === 'redis') throw new Error('Redis does not support SQL objects.');
  const checkName = (name: string) => {
    const limit = engine === 'postgres' ? 63 : engine === 'mysql' ? 64 : 128;
    if (
      !name ||
      name.includes('\0') ||
      (engine === 'postgres' ? Buffer.byteLength(name, 'utf8') : [...name].length) > limit
    )
      throw new Error('Object identifier exceeds the database limit or is invalid.');
  };
  [input.name, input.schema, ...input.columns.map((column) => column.name)].forEach(checkName);
  const schemas = await adapter.schemas();
  if (!schemas.includes(input.schema)) throw new Error('Select an existing schema.');
  const b = new SqlBuilder(engine),
    q = (name: string) => b.quote(name);
  const object = b.table({ schema: input.schema, table: input.name });
  const table = input.table ? b.table({ schema: input.schema, table: input.table }) : '';
  const statements: string[] = [];
  if (input.kind === 'table') {
    if (!input.columns.length) throw new Error('Add at least one column.');
    if (
      new Set(input.columns.map((column) => column.name.toLowerCase())).size !==
      input.columns.length
    )
      throw new Error('Column names must be unique.');
    const generation = input.columns.some((column) => column.generation)
      ? await generationCapabilities(adapter, engine)
      : undefined;
    const columns = input.columns.map((column) => {
      if (column.generation) {
        if (column.defaultSql.trim() || column.primaryKey)
          throw new Error(
            'Generated columns cannot have a default or be selected as a primary key in this form.',
          );
        if (!column.nullable)
          throw new Error('Generated column nullability is managed by the database in this form.');
        return generatedDefinition(
          engine,
          column.name,
          column.type,
          column.generation,
          generation!,
        );
      }
      validateFragment(column.type, engine, true);
      if (column.defaultSql.trim()) validateFragment(column.defaultSql, engine);
      if (engine === 'sybase')
        return `${q(column.name)} ${column.type}${column.defaultSql.trim() ? ` DEFAULT ${column.defaultSql}` : ''} ${column.primaryKey || !column.nullable ? 'NOT NULL' : 'NULL'}`;
      return `${q(column.name)} ${column.type} ${column.primaryKey || !column.nullable ? 'NOT NULL' : 'NULL'}${column.defaultSql.trim() ? ` DEFAULT ${column.defaultSql}` : ''}`;
    });
    const pk = input.columns.filter((column) => column.primaryKey).map((column) => q(column.name));
    if (pk.length) columns.push(`PRIMARY KEY (${pk.join(', ')})`);
    statements.push(`CREATE TABLE ${object} (\n  ${columns.join(',\n  ')}\n)`);
  } else if (input.kind === 'view') {
    const sql = input.selectSql.trim();
    assertSingleStatement(sql, engine);
    const tokens = sqlTokens(sql, engine);
    if (!keyword(tokens[0], 'SELECT') && !keyword(tokens[0], 'WITH'))
      throw new Error('Enter a SELECT query for the view.');
    // No appended SQL Server batches or data-modifying CTEs in a view definition.
    if (
      tokens.some(
        (token) =>
          !token.quoted &&
          /^(INSERT|UPDATE|DELETE|MERGE|INTO|CREATE|ALTER|DROP|EXEC|EXECUTE|USE|GRANT|REVOKE|DENY|TRUNCATE|SET|DECLARE|BACKUP|RESTORE|DBCC|WAITFOR|COMMIT|ROLLBACK)$/i.test(
            token.value,
          ),
      )
    )
      throw new Error('Only a SELECT query is permitted in a view.');
    statements.push(await createViewDefinition(adapter, engine, object, sql, input.viewOptions));
  } else {
    const target = (await adapter.tables(input.schema)).find((item) => item.name === input.table);
    if (!target) throw new Error('Select an existing target table or view.');
    if (input.kind === 'index') {
      if (target.kind !== 'table') throw new Error('This creator supports indexes on tables only.');
      if (!input.indexColumns.length) throw new Error('Select at least one index column.');
      const available = (await adapter.describe({ schema: input.schema, table: input.table })).map(
        (column) => column.name,
      );
      if (
        new Set(input.indexColumns.map((column) => column.name)).size !==
          input.indexColumns.length ||
        input.indexColumns.some((column) => !available.includes(column.name))
      )
        throw new Error('Select distinct existing index columns.');
      statements.push(
        ...(await createIndexStatements(
          adapter,
          engine,
          { schema: input.schema, table: input.table, name: input.name },
          input.indexColumns,
          { type: input.unique ? 'UNIQUE' : 'NORMAL', ...input.indexOptions },
        )),
      );
    } else {
      const isView = target.kind === 'view';
      if (
        (engine === 'mysql' && (isView || input.timing === 'INSTEAD OF')) ||
        (['sqlserver', 'sybase'].includes(engine) &&
          (input.timing === 'BEFORE' || (isView && input.timing !== 'INSTEAD OF'))) ||
        (engine === 'sybase' && !isView && input.timing !== 'AFTER') ||
        (engine === 'sqlite' && isView !== (input.timing === 'INSTEAD OF')) ||
        (engine === 'postgres' && isView !== (input.timing === 'INSTEAD OF'))
      )
        throw new Error('This trigger timing is not supported for the selected target.');
      if (engine === 'postgres') {
        const functionSchema = input.functionSchema || input.schema;
        const functionName =
          input.functionName.trim() || (input.createFunction ? input.name + '_fn' : '');
        if (!functionName) throw new Error('Select an existing PostgreSQL trigger function.');
        checkName(functionName);
        checkName(functionSchema);
        const fn = b.table({ schema: functionSchema, table: functionName });
        if (input.createFunction) {
          if (!input.body.trim()) throw new Error('Enter the trigger body.');
          let tag = '$trigger_body$';
          while (input.body.includes(tag)) tag = tag.slice(0, -1) + '_$';
          statements.push(
            `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS ${tag}\nBEGIN\n${input.body}\nEND;\n${tag}`,
          );
        } else {
          const result = await adapter.query(
            "SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=$2 AND p.pronargs=0 AND p.prorettype='trigger'::regtype",
            [functionSchema, functionName],
            { limit: 1, timeout: 30000, readOnly: true },
          );
          if (!result.rows.length)
            throw new Error('Select an existing PostgreSQL trigger function.');
        }
        statements.push(
          `CREATE TRIGGER ${q(input.name)} ${input.timing} ${input.event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        );
      } else {
        if (!input.body.trim()) throw new Error('Enter the trigger body.');
        // Keep user SQL inside the generated BEGIN/END body, not another batch.
        const tokens = sqlTokens(input.body, engine),
          blocks: string[] = [];
        for (let index = 0; index < tokens.length; index++) {
          const token = tokens[index];
          const statementStart =
            index === 0 ||
            [';', ':', 'THEN', 'ELSE', 'DO', 'BEGIN'].some((word) =>
              keyword(tokens[index - 1], word),
            );
          if (
            keyword(token, 'BEGIN') ||
            keyword(token, 'CASE') ||
            (engine === 'mysql' &&
              statementStart &&
              ['IF', 'LOOP', 'WHILE', 'REPEAT'].some((word) => keyword(token, word)))
          )
            blocks.push(token.value.toUpperCase());
          if (keyword(token, 'END')) {
            const block = blocks.pop();
            if (!block) throw new Error('Unbalanced trigger body.');
            if (
              engine === 'mysql' &&
              ['IF', 'CASE', 'LOOP', 'WHILE', 'REPEAT'].some((word) =>
                keyword(tokens[index + 1], word),
              )
            ) {
              if (!keyword(tokens[index + 1], block)) throw new Error('Unbalanced trigger body.');
              index++;
            }
          }
          if (keyword(token, 'GO') || keyword(token, 'DELIMITER'))
            throw new Error('Omit GO and DELIMITER from the trigger body.');
        }
        if (blocks.length) throw new Error('Unbalanced trigger body.');
        const sql = `CREATE TRIGGER ${object} ${engine === 'sybase' ? `ON ${table} ${input.timing === 'AFTER' ? 'FOR' : input.timing} ${input.event} AS` : engine === 'sqlserver' ? `ON ${table} ${input.timing} ${input.event} AS` : `${input.timing} ${input.event} ON ${engine === 'sqlite' ? q(input.table) : table} FOR EACH ROW`}\nBEGIN\n${input.body.trim()}${/;\s*$/.test(input.body) ? '' : ';'}\nEND`;
        if (engine === 'sqlite') assertSqliteTrigger(sql);
        statements.push(sql);
      }
    }
  }
  return {
    statements,
    atomic: !['mysql', 'sybase'].includes(engine),
    notice:
      engine === 'sybase'
        ? 'ASE support is experimental. Multi-statement DDL requires the database ddl in tran option.'
        : engine === 'mysql'
          ? 'MySQL / MariaDB DDL commits implicitly.'
          : 'Creation runs in a transaction.',
  };
}
