import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createAdapter } from '../src/main/database/factory';
import { connectionSchema } from '../src/shared/schemas';
import { createObjectSchema } from '../src/shared/create-object';
import { planCreateObject } from '../src/main/application/services/create-object-service';
import {
  describeStructure,
  applyStructure,
} from '../src/main/application/services/table-structure-service';
import {
  viewCapabilities,
  createViewDefinition,
  planViewOptions,
  checkOptionInSql,
  replaceCheckOption,
} from '../src/main/database/view-options';
import type { ViewOptions } from '../src/shared/view-options';
import type { SqlAdapter } from '../src/main/database/adapter';
import type { Engine, TableStructure } from '../src/shared/types';
import { SqlBuilder } from '../src/main/database/sql-builder';

const stub = (version = '150000') =>
  ({
    query: async () => ({ rows: [{ version, current_user_account: 'root@localhost' }] }),
  }) as unknown as SqlAdapter;
it('gates view options by engine/version and quotes definer accounts', async () => {
  expect((await viewCapabilities(stub('140000'), 'postgres')).securityModes).toEqual([]);
  expect((await viewCapabilities(stub(), 'postgres')).securityModes).toEqual([
    'DEFINER',
    'INVOKER',
  ]);
  await expect(
    createViewDefinition(stub(), 'sqlite', 'v', 'SELECT 1', { checkOption: 'LOCAL' }),
  ).rejects.toThrow('check option');
  await expect(
    createViewDefinition(stub(), 'sqlserver', 'v', 'SELECT 1', { algorithm: 'MERGE' }),
  ).rejects.toThrow('algorithms');
  await expect(
    createViewDefinition(stub(), 'mysql', 'v', 'SELECT 1', {
      algorithm: 'TEMPTABLE',
      checkOption: 'CASCADED',
    }),
  ).rejects.toThrow('TEMPTABLE');
  expect(
    await createViewDefinition(stub(), 'mysql', 'v', 'SELECT 1', {
      definer: { user: '', host: 'localhost' },
    }),
  ).toContain('DEFINER=``@`localhost`');
  expect(
    await createViewDefinition(stub(), 'mysql', 'v', 'SELECT 1', {
      definer: { user: 'a`b', host: '%' },
    }),
  ).toContain('DEFINER=`a``b`@`%`');
  expect(
    await createViewDefinition(stub(), 'sybase', '[dbo].[v]', 'SELECT id FROM t', {
      checkOption: 'CASCADED',
    }),
  ).toContain('WITH CHECK OPTION');
});
it('changes only the trailing check clause and keeps SQL comments, literals and scoped identity', async () => {
  const sql =
    "CREATE VIEW v AS SELECT 'WITH LOCAL CHECK OPTION' AS label FROM t WITH LOCAL CHECK OPTION; -- keep";
  expect(checkOptionInSql(sql, 'mysql')).toBe('LOCAL');
  expect(replaceCheckOption(sql, 'mysql', 'NONE')).toBe(
    "CREATE VIEW v AS SELECT 'WITH LOCAL CHECK OPTION' AS label FROM t; -- keep",
  );
  const detail = {
    engine: 'mysql',
    kind: 'view',
    schema: 'another',
    table: 'v',
    definition: sql,
    version: '',
    columns: [],
    prefix: [],
    viewOptions: {
      algorithm: 'MERGE',
      definer: { user: 'owner', host: '%' },
      security: 'INVOKER',
      checkOption: 'LOCAL',
    },
    viewCapabilities: await viewCapabilities(stub(), 'mysql'),
  } as TableStructure & { prefix: string[] };
  const plan = planViewOptions(detail, { checkOption: 'CASCADED' });
  expect(plan.statements[0]).toContain(
    'DEFINER=`owner`@`%` SQL SECURITY INVOKER VIEW `another`.`v`',
  );
  expect(plan.statements[0]).toContain(
    "SELECT 'WITH LOCAL CHECK OPTION' AS label FROM t\nWITH CASCADED CHECK OPTION; -- keep",
  );
  expect(() => planViewOptions(detail, { security: 'INVOKER' })).toThrow('no view option');
  expect(() =>
    planViewOptions({ ...detail, readOnlyReason: 'protected' }, { checkOption: 'NONE' }),
  ).toThrow('protected');
});

const configs: {
  engine: Engine;
  port: number;
  username: string;
  database: string;
  schema: string;
}[] = [
  {
    engine: 'postgres',
    port: 15432,
    username: 'workspace',
    database: 'workspace',
    schema: 'public',
  },
  { engine: 'mysql', port: 13306, username: 'root', database: 'workspace', schema: 'workspace' },
  { engine: 'mysql', port: 13307, username: 'root', database: 'workspace', schema: 'workspace' },
  { engine: 'sqlserver', port: 11433, username: 'sa', database: 'master', schema: 'dbo' },
];
for (const config of configs)
  it.skipIf(process.env.DB_INTEGRATION !== '1')(
    `view options create/edit/readback/enforcement/grants: ${config.engine}:${config.port}`,
    async () => {
      const { schema: _schema, ...connectionInput } = config;
      const connection = {
        ...connectionSchema.parse({ ...connectionInput, name: 'View options', host: '127.0.0.1' }),
        id: randomUUID(),
      };
      const adapter = createAdapter(connection, process.env.DB_TEST_PASSWORD);
      const stem = 'dw_view_' + randomUUID().replaceAll('-', '').slice(0, 10),
        table = stem + '_t',
        view = stem + '_v';
      const b = new SqlBuilder(config.engine),
        q = (name: string) => b.table({ schema: config.schema, table: name });
      const ref = { schema: config.schema, table: view };
      const run = (sql: string) =>
        adapter.query(sql, [], { limit: 100, timeout: 10000, readOnly: false });
      const change = async (options: ViewOptions) => {
        const before = await describeStructure(adapter, connection, ref);
        return applyStructure(
          adapter,
          connection,
          ref,
          { action: 'view-options', options },
          before.version,
          10000,
        );
      };
      let tableCreated = false,
        viewCreated = false;
      try {
        await run(`CREATE TABLE ${q(table)}(id INT PRIMARY KEY,qty INT)`);
        tableCreated = true;
        const options: ViewOptions = {
          checkOption: 'CASCADED',
          ...(config.engine === 'mysql'
            ? { algorithm: 'MERGE', security: 'INVOKER', definer: null }
            : config.engine === 'postgres'
              ? { security: 'INVOKER' }
              : {}),
        };
        const plan = await planCreateObject(
          adapter,
          connection,
          createObjectSchema.parse({
            connectionId: connection.id,
            schema: config.schema,
            kind: 'view',
            name: view,
            selectSql: `SELECT id,qty FROM ${q(table)} WHERE qty > 0`,
            viewOptions: options,
          }),
        );
        await adapter.executeDdl!(plan.statements, 10000);
        viewCreated = true;
        let detail = await describeStructure(adapter, connection, ref);
        expect(detail.viewOptions).toMatchObject({
          ...options,
          ...(config.engine === 'mysql'
            ? { definer: detail.viewCapabilities!.currentDefiner }
            : {}),
        });
        await run(`INSERT INTO ${q(view)} VALUES(1,5)`);
        await expect(run(`INSERT INTO ${q(view)} VALUES(2,-1)`)).rejects.toThrow();
        if (config.engine === 'postgres') {
          await run(`ALTER VIEW ${q(view)} SET (security_barrier=true)`);
          await run(`GRANT SELECT ON ${q(view)} TO PUBLIC`);
          await run(`COMMENT ON VIEW ${q(view)} IS 'retained comment'`);
        } else if (config.engine === 'sqlserver') await run(`GRANT SELECT ON ${q(view)} TO public`);
        const stale = await describeStructure(adapter, connection, ref);
        detail = await change({
          checkOption: 'NONE',
          ...(config.engine === 'mysql' || config.engine === 'postgres'
            ? { security: 'DEFINER' }
            : {}),
        });
        expect(detail.viewOptions?.checkOption).toBe('NONE');
        await run(`INSERT INTO ${q(view)} VALUES(2,-1)`);
        expect((await run(`SELECT * FROM ${q(table)}`)).rows).toHaveLength(2);
        await expect(
          applyStructure(
            adapter,
            connection,
            ref,
            { action: 'view-options', options: { checkOption: 'CASCADED' } },
            stale.version,
            10000,
          ),
        ).rejects.toThrow('structure changed');
        if (config.engine === 'mysql') {
          const originalDefiner = detail.viewOptions!.definer;
          detail = await change({ algorithm: 'TEMPTABLE' });
          expect(detail.viewOptions).toMatchObject({
            algorithm: 'TEMPTABLE',
            definer: originalDefiner,
            security: 'DEFINER',
          });
          await expect(change({ checkOption: 'LOCAL' })).rejects.toThrow('TEMPTABLE');
          expect((await describeStructure(adapter, connection, ref)).version).toBe(detail.version);
          detail = await change({
            algorithm: 'MERGE',
            checkOption: 'LOCAL',
            security: 'INVOKER',
            definer: detail.viewCapabilities!.currentDefiner!,
          });
          expect(detail.viewOptions).toMatchObject({
            algorithm: 'MERGE',
            checkOption: 'LOCAL',
            security: 'INVOKER',
          });
        } else {
          if (config.engine === 'postgres') {
            expect(
              (await run(`SELECT reloptions FROM pg_class WHERE relname='${view}'`)).rows[0]
                .reloptions,
            ).toContain('security_barrier=true');
            expect(
              (await run(`SELECT obj_description('${q(view)}'::regclass) AS comment`)).rows[0]
                .comment,
            ).toBe('retained comment');
            expect(
              (
                await run(
                  `SELECT * FROM information_schema.role_table_grants WHERE table_name='${view}' AND grantee='PUBLIC'`,
                )
              ).rows.length,
            ).toBeGreaterThan(0);
          } else
            expect(
              (
                await run(
                  `SELECT * FROM sys.database_permissions WHERE major_id=OBJECT_ID('${q(view)}') AND grantee_principal_id=DATABASE_PRINCIPAL_ID('public')`,
                )
              ).rows.length,
            ).toBeGreaterThan(0);
          await change({ checkOption: config.engine === 'postgres' ? 'LOCAL' : 'CASCADED' });
        }
        await expect(run(`INSERT INTO ${q(view)} VALUES(3,-3)`)).rejects.toThrow();
      } finally {
        if (viewCreated) await run(`DROP VIEW ${q(view)}`);
        if (tableCreated) await run(`DROP TABLE ${q(table)}`);
        await adapter.disconnect();
      }
    },
    60000,
  );
