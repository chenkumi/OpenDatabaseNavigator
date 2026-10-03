import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { createAdapter } from '../src/main/database/factory';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { SqlBuilder } from '../src/main/database/sql-builder';
import { validateDatabaseOptions } from '../src/main/database/create-database';
import type {
  DatabaseOptions,
  DatabaseProperties,
  DatabaseCreateOptions,
} from '../src/shared/database-options';

function fixture() {
  const secrets = new Map<string, string>();
  return new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(DEFAULT_SETTINGS),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    {
      get: (id) => secrets.get(id),
      set: (id, v) => {
        secrets.set(id, v);
      },
      delete: (id) => {
        secrets.delete(id);
      },
    },
    createAdapter,
  );
}
it('shows SQLite encoding read-only and rejects property writes', async () => {
  const app = fixture();
  try {
    const connection = await app.connections.save({
      engine: 'sqlite',
      name: 'encoding',
      database: ':memory:',
    });
    const target = { connectionId: connection.id, database: ':memory:' };
    const result = await app.commands.dispatch('database.properties.describe', target, HUMAN);
    expect(result.success).toBe(true);
    const properties = result.data as DatabaseProperties;
    expect(properties.charset).toBe('UTF-8');
    expect(properties.editable).toEqual({ charset: false, collation: false });
    expect(
      (
        await app.commands.dispatch(
          'database.properties.apply',
          { ...target, changes: { charset: 'UTF8' }, version: properties.version },
          HUMAN,
        )
      ).error,
    ).toContain('read-only');
  } finally {
    await app.connections.shutdown();
  }
});
it('gates PostgreSQL locale providers and UTF8 ICU encoding', () => {
  const available: DatabaseOptions = {
    charsets: ['UTF8', 'LATIN1'],
    collations: [],
    postgres: { version: 140000, providers: [], locales: [{ provider: 'libc', name: 'C' }] },
  };
  expect(() => validateDatabaseOptions({ localeProvider: 'libc' }, available)).toThrow(
    'not available',
  );
  expect(() =>
    validateDatabaseOptions({ charset: 'LATIN1', locale: 'C' }, available),
  ).not.toThrow();
  available.postgres!.providers = ['libc', 'icu', 'builtin'];
  available.postgres!.locales.push({ provider: 'builtin', name: 'C.UTF-8' });
  expect(() =>
    validateDatabaseOptions({ localeProvider: 'icu', locale: 'zh', charset: 'LATIN1' }, available),
  ).toThrow('UTF8');
  expect(() => validateDatabaseOptions({ localeProvider: 'icu' }, available)).toThrow('locale');
  expect(() =>
    validateDatabaseOptions({ localeProvider: 'builtin', locale: 'unknown' }, available),
  ).toThrow('supported');
  expect(() =>
    validateDatabaseOptions(
      { localeProvider: 'builtin', locale: 'C.UTF-8', charset: 'UTF8' },
      available,
    ),
  ).not.toThrow();
});

for (const config of [
  { engine: 'mysql' as const, port: 13306, username: 'root', database: 'workspace' },
  { engine: 'mysql' as const, port: 13307, username: 'root', database: 'workspace' },
  { engine: 'sqlserver' as const, port: 11433, username: 'sa', database: 'master' },
])
  it.skipIf(process.env.DB_INTEGRATION !== '1')(
    `database property changes: ${config.engine}:${config.port}`,
    async () => {
      const app = fixture(),
        name = 'dw_dbprops_' + randomUUID().replaceAll('-', '').slice(0, 12);
      const connection = await app.connections.save({
        ...config,
        name: 'properties',
        host: '127.0.0.1',
        password: process.env.DB_TEST_PASSWORD,
        agentAccess: 'write',
      });
      const target = { connectionId: connection.id, database: name },
        b = new SqlBuilder(config.engine);
      const call = async <T = any>(command: string, args: object): Promise<T> => {
        const r = await app.commands.dispatch(command, args, HUMAN);
        expect(r.success, `${command}: ${r.error}`).toBe(true);
        return r.data as T;
      };
      let created = false;
      try {
        await call('database.create', target);
        created = true;
        const original = await call<DatabaseProperties>('database.properties.describe', target);
        const scope = await app.connections.connect(connection.id, name);
        await scope.query('CREATE TABLE preserved (id int)', [], {
          limit: 1,
          timeout: 10000,
          readOnly: false,
        });
        await scope.query('INSERT INTO preserved (id) VALUES (7)', [], {
          limit: 1,
          timeout: 10000,
          readOnly: false,
        });
        const changes =
          config.engine === 'mysql'
            ? { charset: 'latin1', collation: 'latin1_bin' }
            : { collation: 'Latin1_General_100_CS_AS' };
        const args = { ...target, changes, version: original.version };
        expect((await call('database.properties.preview', args)).sql).toContain('ALTER DATABASE');
        const agent = { kind: 'agent' as const, id: 'test', name: 'test' };
        await app.connections.save({ ...connection, agentAccess: 'read' });
        expect(
          (await app.commands.dispatch('database.properties.apply', args, agent)).success,
        ).toBe(false);
        await app.connections.save({ ...connection, agentAccess: 'write' });
        const changed = await call<DatabaseProperties>('database.properties.apply', args);
        expect(changed.collation).toBe(changes.collation);
        expect(
          (await app.commands.dispatch('database.properties.apply', args, HUMAN)).error,
        ).toContain('changed');
        if (config.engine === 'sqlserver')
          await expect(scope.tables()).rejects.toThrow('disconnected');
        const next = await app.connections.connect(connection.id, name);
        expect(
          (
            await next.query('SELECT id FROM preserved', [], {
              limit: 1,
              timeout: 10000,
              readOnly: true,
            })
          ).rows[0].id,
        ).toBe(7);
        const bad = await app.commands.dispatch(
          'database.properties.preview',
          { ...target, version: changed.version, changes: { collation: 'not_a_real_collation' } },
          HUMAN,
        );
        expect(bad.error).toContain('not available');
        if (config.engine === 'mysql') {
          const mismatch = await app.commands.dispatch(
            'database.properties.preview',
            {
              ...target,
              version: changed.version,
              changes: { charset: 'utf8mb4', collation: 'latin1_bin' },
            },
            HUMAN,
          );
          expect(mismatch.error).toContain('does not belong');
          const reset = await call<DatabaseProperties>('database.properties.apply', {
            ...target,
            version: changed.version,
            changes: { charset: 'utf8mb4' },
          });
          expect(reset.charset).toBe('utf8mb4');
          expect(reset.collation).toMatch(/^utf8mb4_/);
        } else {
          const system = await call<DatabaseProperties>('database.properties.describe', {
            ...target,
            database: 'master',
          });
          expect(system.editable.collation).toBe(false);
          const options = { limit: 1, timeout: 10000, readOnly: false };
          await next.query('CREATE TABLE case_collision (id int)', [], options);
          await next.query('CREATE TABLE CASE_COLLISION (id int)', [], options);
          const failure = await app.commands.dispatch(
            'database.properties.apply',
            {
              ...target,
              version: changed.version,
              changes: { collation: 'Latin1_General_100_CI_AS' },
            },
            HUMAN,
          );
          expect(failure.success).toBe(false);
          expect(
            (await call<DatabaseProperties>('database.properties.describe', target)).collation,
          ).toBe(changed.collation);
          const reconnected = await app.connections.connect(connection.id, name);
          expect(
            (
              await reconnected.query('SELECT id FROM preserved', [], {
                ...options,
                readOnly: true,
              })
            ).rows[0].id,
          ).toBe(7);
        }
      } finally {
        await app.connections.disconnect(connection.id);
        if (created)
          await (
            await app.connections.connect(connection.id, config.database)
          ).query(`DROP DATABASE ${b.quote(name)}`, [], {
            limit: 1,
            timeout: 30000,
            readOnly: false,
          });
        await app.connections.shutdown();
      }
    },
    90000,
  );

it.skipIf(process.env.DB_INTEGRATION !== '1')(
  'PostgreSQL database encodings and libc/ICU/builtin locale creation',
  async () => {
    const app = fixture();
    const connection = await app.connections.save({
      engine: 'postgres',
      name: 'locale',
      host: '127.0.0.1',
      port: 15432,
      username: 'workspace',
      database: 'workspace',
      password: process.env.DB_TEST_PASSWORD,
    });
    const call = async <T = any>(command: string, args: object): Promise<T> => {
      const r = await app.commands.dispatch(
        command,
        { connectionId: connection.id, ...args },
        HUMAN,
      );
      expect(r.success, `${command}: ${r.error}`).toBe(true);
      return r.data as T;
    };
    try {
      const options = await call<DatabaseOptions>('database.options', {});
      expect(options.charsets).toContain('UTF8');
      expect(options.charsets).toContain('LATIN1');
      const cases: DatabaseCreateOptions[] = [
        { charset: 'LATIN1', locale: 'C', lcCtype: 'C', localeProvider: 'libc' },
        { charset: 'UTF8', locale: 'C', localeProvider: 'libc' },
      ];
      if (options.postgres?.providers.includes('icu'))
        cases.push({ charset: 'UTF8', localeProvider: 'icu', locale: 'zh-Hant-TW' });
      if (options.postgres?.providers.includes('builtin'))
        cases.push({ charset: 'UTF8', localeProvider: 'builtin', locale: 'C.UTF-8' });
      for (const entry of cases) {
        const name = 'dw_locale_' + randomUUID().replaceAll('-', '').slice(0, 12);
        await call('database.create', { database: name, ...entry });
        try {
          const props = await call<DatabaseProperties>('database.properties.describe', {
            database: name,
          });
          expect(props.charset).toBe(entry.charset);
          expect(props.localeProvider).toBe(entry.localeProvider);
          expect(props.locale).toBe(entry.locale);
          expect(props.editable).toEqual({ charset: false, collation: false });
          expect(
            (
              await app.commands.dispatch(
                'database.properties.preview',
                {
                  connectionId: connection.id,
                  database: name,
                  version: props.version,
                  changes: { charset: 'UTF8' },
                },
                HUMAN,
              )
            ).error,
          ).toContain('read-only');
        } finally {
          await (
            await app.connections.connect(connection.id)
          ).query(`DROP DATABASE "${name}"`, [], { limit: 1, timeout: 30000, readOnly: false });
        }
      }
    } finally {
      await app.connections.shutdown();
    }
  },
  90000,
);
