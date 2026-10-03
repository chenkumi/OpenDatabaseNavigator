import { describe, expect, it } from 'vitest';
import { createDatabaseSql, validateDatabaseOptions } from '../src/main/database/create-database';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS } from '../src/shared/types';

describe('database creation', () => {
  it('builds engine-specific options and rejects unsupported, mismatched and injected options', () => {
    expect(
      createDatabaseSql('mysql', 'demo', { charset: 'utf8mb4', collation: 'utf8mb4_bin' }),
    ).toBe('CREATE DATABASE `demo` CHARACTER SET `utf8mb4` COLLATE `utf8mb4_bin`');
    expect(
      createDatabaseSql('sqlserver', 'demo', { collation: 'Latin1_General_100_CI_AS_SC_UTF8' }),
    ).toBe('CREATE DATABASE [demo] COLLATE Latin1_General_100_CI_AS_SC_UTF8');
    for (const engine of ['sybase', 'sqlserver'] as const)
      expect(() => createDatabaseSql(engine, 'demo', { charset: 'utf8mb4' })).toThrow();
    expect(
      createDatabaseSql('postgres', 'demo', {
        charset: 'LATIN1',
        locale: 'C',
        localeProvider: 'libc',
      }),
    ).toBe(
      `CREATE DATABASE "demo" TEMPLATE template0 ENCODING E'LATIN1' LOCALE_PROVIDER libc LOCALE E'C'`,
    );
    expect(createDatabaseSql('postgres', 'demo', { locale: "a'\\b" })).toContain(
      "LOCALE E'a''\\\\b'",
    );
    expect(() => createDatabaseSql('postgres', 'demo', { collation: 'en_US' })).toThrow();
    expect(() =>
      createDatabaseSql('sqlserver', 'demo', { collation: 'x; DROP DATABASE foo' }),
    ).toThrow();
    const available = {
      charsets: ['utf8mb4', 'latin1'],
      collations: [{ name: 'utf8mb4_bin', charset: 'utf8mb4' }],
    };
    expect(() =>
      validateDatabaseOptions({ charset: 'latin1', collation: 'utf8mb4_bin' }, available),
    ).toThrow('does not belong');
    expect(() => validateDatabaseOptions({ charset: 'unknown' }, available)).toThrow(
      'not available',
    );
    expect(() => validateDatabaseOptions({ collation: 'unknown' }, available)).toThrow(
      'not available',
    );
    expect(() => validateDatabaseOptions({ collation: 'utf8mb4_bin' }, available)).not.toThrow();
  });
  it('quotes database identifiers and rejects unsupported engines and invalid lengths', () => {
    expect(createDatabaseSql('postgres', 'a"; DROP DATABASE x;--')).toBe(
      'CREATE DATABASE "a""; DROP DATABASE x;--"',
    );
    expect(createDatabaseSql('mysql', 'a`b')).toBe('CREATE DATABASE `a``b`');
    expect(createDatabaseSql('sqlserver', 'a]b')).toBe('CREATE DATABASE [a]]b]');
    expect(() => createDatabaseSql('postgres', '中'.repeat(22))).toThrow('limit');
    expect(() => createDatabaseSql('mysql', 'a'.repeat(65))).toThrow('limit');
    for (const name of ['', ' ', ' a', 'a\0b'])
      expect(() => createDatabaseSql('sqlserver', name)).toThrow();
    expect(() => createDatabaseSql('sqlite', 'x')).toThrow('does not support');
    expect(() => createDatabaseSql('redis', 'x')).toThrow('does not support');
  });
  it('uses DDL permission and binds approval to the requested database', async () => {
    const statements: string[] = [];
    const app = new Application(
      {
        connections: new MemoryStore([]),
        workspace: new MemoryStore({ tabs: [] }),
        settings: new MemoryStore({
          ...DEFAULT_SETTINGS,
          policy: { ...DEFAULT_SETTINGS.policy, ddl: 'ask' as const },
        }),
        history: new MemoryStore([]),
        audit: new MemoryStore([]),
      },
      { get: () => undefined, set: () => {}, delete: () => {} },
      () => ({
        connect: async () => {},
        disconnect: async () => {},
        query: async (sql) => {
          statements.push(sql);
          return {
            success: true,
            rows: [],
            columns: [],
            rowCount: 0,
            affectedRows: 0,
            hasMore: false,
            duration: 0,
          };
        },
        databases: async () => [],
        schemas: async () => [],
        tables: async () => [],
        describe: async () => [],
      }),
    );
    try {
      const connection = await app.connections.save({
        name: 'Test',
        engine: 'postgres',
        database: 'postgres',
        agentAccess: 'write',
      });
      const actor = { kind: 'agent' as const, id: 'test', name: 'Test' };
      const pending = await app.commands.dispatch(
        'database.create',
        { connectionId: connection.id, database: 'new_db' },
        actor,
      );
      expect(pending.approvalId).toBeTruthy();
      expect(statements).toEqual([]);
      const done = await app.commands.resolveApproval(pending.approvalId!, true, HUMAN);
      expect(done.success).toBe(true);
      expect(statements).toEqual(['CREATE DATABASE "new_db"']);
      await app.connections.save({ ...connection, agentAccess: 'read' });
      expect(
        (
          await app.commands.dispatch(
            'database.create',
            { connectionId: connection.id, database: 'blocked' },
            actor,
          )
        ).success,
      ).toBe(false);
      expect(statements).toHaveLength(1);
    } finally {
      await app.connections.shutdown();
    }
  });
});
