import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createAdapter } from '../src/main/database/factory';
import { connectionSchema } from '../src/shared/schemas';
import { createObjectSchema } from '../src/shared/create-object';
import { planCreateObject } from '../src/main/application/services/create-object-service';
import {
  readObjectDefinition,
  applyObjectChange,
  planObjectChange,
} from '../src/main/application/services/database-object-service';
import {
  rewriteIndexSql,
  indexCapabilities,
  createIndexStatements,
} from '../src/main/database/index-options';
import { mysqlIndexClause } from '../src/main/database/object-sql';
import { assertSingleStatement } from '../src/main/security/single-statement';
import { SqlBuilder } from '../src/main/database/sql-builder';
import type { Engine } from '../src/shared/types';
import type { IndexOptions } from '../src/shared/index-options';
import type { SqlAdapter } from '../src/main/database/adapter';

it('preserves expression/predicate/storage clauses and parses MySQL comments under both SQL modes', () => {
  const sql = 'CREATE INDEX idx ON public.t USING btree (lower(label)) INCLUDE (id) WHERE id > 0';
  expect(rewriteIndexSql(sql, 'postgres', { type: 'UNIQUE', method: 'hash' })).toBe(
    'CREATE UNIQUE INDEX idx ON public.t USING "hash" (lower(label)) INCLUDE (id) WHERE id > 0',
  );
  expect(
    rewriteIndexSql("KEY `ix` (`label`(10)) USING BTREE COMMENT 'old' INVISIBLE", 'mysql', {
      comment: "new'\\text",
    }),
  ).toContain("COMMENT 'new''\\\\text' INVISIBLE");
  const comment = "COMMENT 'a\\''b; c'";
  const definition = `CREATE TABLE t(id int, KEY ix(id) ${comment})`;
  expect(mysqlIndexClause(definition, 'ix', true)).toBe(`KEY ix(id) ${comment}`);
  expect(() =>
    assertSingleStatement(`ALTER TABLE t ADD KEY ix(id) ${comment}`, 'mysql', true),
  ).not.toThrow();
  expect(() =>
    assertSingleStatement(`ALTER TABLE t ADD KEY ix(id) ${comment}; DROP TABLE t`, 'mysql', true),
  ).toThrow('one SQL');
});
it('offers ASE rowstore methods and rejects unsupported method/unique combinations', async () => {
  const stub = {
    query: async () => ({
      rows: [
        { amname: 'hash', can_unique: false, can_order: false },
        { amname: 'btree', can_unique: true, can_order: true },
      ],
    }),
  } as unknown as SqlAdapter;
  expect(
    (await indexCapabilities(stub, 'sybase', { table: 't' })).methods.map((m) => m.name),
  ).toEqual(['NONCLUSTERED', 'CLUSTERED']);
  expect(
    (
      await createIndexStatements(
        stub,
        'sybase',
        { schema: 'dbo', table: 't', name: 'ix' },
        [{ name: 'id', descending: false }],
        { type: 'UNIQUE', method: 'CLUSTERED' },
      )
    )[0],
  ).toContain('CREATE UNIQUE CLUSTERED INDEX');
  await expect(
    createIndexStatements(
      stub,
      'postgres',
      { schema: 'public', table: 't', name: 'ix' },
      [{ name: 'id', descending: false }],
      { type: 'UNIQUE', method: 'hash' },
    ),
  ).rejects.toThrow('uniqueness');
  await expect(
    createIndexStatements(
      stub,
      'postgres',
      { schema: 'public', table: 't', name: 'ix' },
      [{ name: 'id', descending: true }],
      { method: 'hash' },
    ),
  ).rejects.toThrow('descending');
});
const configs: {
  engine: Engine;
  port?: number;
  username?: string;
  database: string;
  schema: string;
}[] = [
  { engine: 'sqlite', database: ':memory:', schema: 'main' },
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
  it.skipIf(config.engine !== 'sqlite' && process.env.DB_INTEGRATION !== '1')(
    `index options: ${config.engine}:${config.port ?? 'local'}`,
    async () => {
      const { schema, ...settings } = config,
        connection = {
          ...connectionSchema.parse({ ...settings, host: '127.0.0.1', name: 'Index test' }),
          id: randomUUID(),
        };
      const adapter = createAdapter(connection, process.env.DB_TEST_PASSWORD),
        b = new SqlBuilder(config.engine);
      const table = 'dw_ix_' + randomUUID().replaceAll('-', '').slice(0, 12),
        name = table + '_idx';
      const ref = {
        connectionId: connection.id,
        schema,
        table,
        kind: 'index' as const,
        objectName: name,
      };
      const target = b.table(ref),
        query = (sql: string) =>
          adapter.query(sql, [], { limit: 100, timeout: 20000, readOnly: false });
      const change = async (patch: IndexOptions) => {
        const before = await readObjectDefinition(adapter, connection, ref);
        return applyObjectChange(adapter, connection, ref, patch, before.version, 20000);
      };
      const create = async (indexName: string, columns: string[], indexOptions: IndexOptions) => {
        const plan = await planCreateObject(
          adapter,
          connection,
          createObjectSchema.parse({
            connectionId: connection.id,
            kind: 'index',
            schema,
            table,
            name: indexName,
            indexColumns: columns.map((name) => ({ name, descending: false })),
            indexOptions,
          }),
        );
        await adapter.executeDdl!(plan.statements, 20000);
      };
      let created = false;
      try {
        await query(`CREATE TABLE ${target}(id INT NOT NULL,qty INT,label VARCHAR(128))`);
        created = true;
        await query(`INSERT INTO ${target}(id,qty,label) VALUES(1,5,'first'),(2,5,'second')`);
        const comment = "索引 ' quote \\ path; retained";
        await create(name, ['qty'], {
          type: 'NORMAL',
          ...(config.engine === 'sqlite' ? {} : { comment }),
        });
        let detail = await readObjectDefinition(adapter, connection, ref);
        expect(detail.indexOptions).toMatchObject({
          type: 'NORMAL',
          ...(config.engine === 'sqlite' ? {} : { comment }),
        });
        await expect(change({ type: 'UNIQUE' })).rejects.toThrow();
        expect((await readObjectDefinition(adapter, connection, ref)).indexOptions?.type).toBe(
          'NORMAL',
        );
        await query(`DELETE FROM ${target} WHERE id=2`);
        detail = await change({ type: 'UNIQUE' });
        expect(detail.indexOptions?.type).toBe('UNIQUE');
        await expect(query(`INSERT INTO ${target}(id,qty) VALUES(2,5)`)).rejects.toThrow();
        const stale = detail.version;
        detail = await change({ type: 'NORMAL' });
        await expect(
          applyObjectChange(adapter, connection, ref, { type: 'UNIQUE' }, stale, 20000),
        ).rejects.toThrow('object changed');
        await query(`INSERT INTO ${target}(id,qty) VALUES(2,5)`);
        expect((await query(`SELECT * FROM ${target}`)).rows).toHaveLength(2);
        if (config.engine !== 'sqlite') {
          // Native comment-only changes must not rebuild PG/SQL Server indexes.
          const plan = planObjectChange(detail, ref, { comment: 'updated' });
          if (config.engine !== 'mysql')
            expect(plan.statements.join(' ')).not.toMatch(/CREATE INDEX|DROP INDEX/);
          detail = await change({ comment: 'updated' });
          expect(detail.indexOptions?.comment).toBe('updated');
        }
        if (config.engine === 'postgres') {
          detail = await change({ method: 'hash' });
          expect(detail.indexOptions?.method).toBe('hash');
          expect(detail.indexOptions?.comment).toBe('updated');
          await expect(change({ type: 'UNIQUE' })).rejects.toThrow('uniqueness');
          detail = await change({ method: '' });
          expect(detail.indexOptions?.method).toBe('btree');
          await query(`ALTER TABLE ${target} ADD tags INT[]`);
          await create(name + '_gin', ['tags'], { method: 'gin', comment: 'GIN tags' });
          expect(
            (await readObjectDefinition(adapter, connection, { ...ref, objectName: name + '_gin' }))
              .indexOptions?.method,
          ).toBe('gin');
        } else if (config.engine === 'mysql') {
          await query("SET SESSION sql_mode=CONCAT(@@SESSION.sql_mode,',NO_BACKSLASH_ESCAPES')");
          const escapedComment = "slash\\'quote; 中文";
          await create(name + '_nobs', ['label'], { comment: escapedComment });
          const nobsRef = { ...ref, objectName: name + '_nobs' };
          const nobs = await readObjectDefinition(adapter, connection, nobsRef);
          expect(nobs.indexOptions?.comment).toBe(escapedComment);
          expect(
            (
              await applyObjectChange(
                adapter,
                connection,
                nobsRef,
                { comment: escapedComment + ' changed' },
                nobs.version,
                20000,
              )
            ).indexOptions?.comment,
          ).toBe(escapedComment + ' changed');
          await create(name + '_ft', ['label'], { type: 'FULLTEXT', comment: '全文' });
          expect(
            (await readObjectDefinition(adapter, connection, { ...ref, objectName: name + '_ft' }))
              .indexOptions,
          ).toMatchObject({ type: 'FULLTEXT', method: '', comment: '全文' });
          await expect(change({ method: 'HASH' })).rejects.toThrow('method');
          const spatial = table + '_spatial',
            memory = table + '_memory';
          try {
            await query(`CREATE TABLE ${b.quote(spatial)}(g POINT NOT NULL)`);
            const statements = await createIndexStatements(
              adapter,
              'mysql',
              { schema, table: spatial, name: 'spatial_idx' },
              [{ name: 'g', descending: false }],
              { type: 'SPATIAL' },
            );
            await adapter.executeDdl!(statements, 20000);
            expect(
              (
                await readObjectDefinition(adapter, connection, {
                  ...ref,
                  table: spatial,
                  objectName: 'spatial_idx',
                })
              ).indexOptions?.type,
            ).toBe('SPATIAL');
            await query(`CREATE TABLE ${b.quote(memory)}(id INT) ENGINE=MEMORY`);
            await adapter.executeDdl!(
              await createIndexStatements(
                adapter,
                'mysql',
                { schema, table: memory, name: 'hash_idx' },
                [{ name: 'id', descending: false }],
                { method: 'HASH' },
              ),
              20000,
            );
            let hash = await readObjectDefinition(adapter, connection, {
              ...ref,
              table: memory,
              objectName: 'hash_idx',
            });
            expect(hash.indexOptions?.method).toBe('HASH');
            hash = await applyObjectChange(
              adapter,
              connection,
              { ...ref, table: memory, objectName: 'hash_idx' },
              { method: 'BTREE' },
              hash.version,
              20000,
            );
            expect(hash.indexOptions?.method).toBe('BTREE');
          } finally {
            await query(`DROP TABLE IF EXISTS ${b.quote(spatial)}`);
            await query(`DROP TABLE IF EXISTS ${b.quote(memory)}`);
          }
        } else if (config.engine === 'sqlserver') {
          detail = await change({ method: 'CLUSTERED' });
          expect(detail.indexOptions?.method).toBe('CLUSTERED');
          expect(detail.indexOptions?.comment).toBe('updated');
          detail = await change({ method: 'NONCLUSTERED' });
          expect(detail.indexOptions?.method).toBe('NONCLUSTERED');
          expect(detail.indexOptions?.comment).toBe('updated');
        }
        if (config.engine !== 'sqlite')
          expect((await change({ comment: '' })).indexOptions?.comment).toBe('');
        if (config.engine === 'sqlserver') {
          await query(
            `EXEC sys.sp_addextendedproperty @name=N'custom_property',@value=N'keep',@level0type=N'SCHEMA',@level0name=N'${schema}',@level1type=N'TABLE',@level1name=N'${table}',@level2type=N'INDEX',@level2name=N'${name}'`,
          );
          detail = await readObjectDefinition(adapter, connection, ref);
          expect(detail.readOnlyReason).toContain('custom extended properties');
          await expect(change({ method: 'CLUSTERED' })).rejects.toThrow(
            'custom extended properties',
          );
        }
      } finally {
        if (created) await query(`DROP TABLE ${target}`);
        await adapter.disconnect();
      }
    },
    120000,
  );
