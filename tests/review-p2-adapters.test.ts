import { expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableClauses, validateFragment } from '../src/main/database/structure-sql';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';

it('MySQL fragments whose quoting depends on NO_BACKSLASH_ESCAPES are rejected', () => {
  const injected = "'\\', DROP COLUMN a, ADD y int DEFAULT '";
  expect(() => validateFragment(injected, 'mysql')).toThrow('ambiguous');
  expect(() => validateFragment("'it\\'s'", 'mysql')).toThrow('ambiguous');
  expect(() => validateFragment("'it''s'", 'mysql')).not.toThrow();
  expect(() => validateFragment("'a\\\\b'", 'mysql')).not.toThrow();
  expect(() => validateFragment('varchar(10)', 'mysql', true)).not.toThrow();
  // Other engines are unaffected by the MySQL sql_mode.
  expect(() => validateFragment("'it''s'", 'postgres')).not.toThrow();
});

it('a SHOW CREATE definition ending a default in a backslash splits correctly in NO_BACKSLASH_ESCAPES mode', () => {
  const sql = "CREATE TABLE t (\n  a varchar(5) DEFAULT 'x\\',\n  b int\n)";
  expect(tableClauses(sql, 'mysql', true).clauses).toHaveLength(2);
  expect(() => tableClauses(sql, 'mysql', false)).toThrow();
});

it('a stopped SQLite statement does not let a second thread start against the same file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dw-sqlite-stop-'));
  const adapter = new SqliteAdapter(join(dir, 'a.db'));
  const options = { limit: 10, timeout: 20_000, readOnly: false };
  try {
    await adapter.query('CREATE TABLE t (x integer)', [], options);
    await expect(
      adapter.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 8000000) SELECT count(*) FROM c',
        [],
        { ...options, timeout: 200 },
      ),
    ).rejects.toThrow('timed out');
    // The next request waits for the old thread to finish instead of racing it
    // for the file lock, so it succeeds rather than failing with "database is locked".
    const inserted = await adapter.query('INSERT INTO t VALUES (1)', [], options);
    expect(inserted.affectedRows).toBe(1);
  } finally {
    await adapter.disconnect();
  }
}, 40_000);

it('ASE nchar and nvarchar columns keep their character length', async () => {
  const { aseColumns } = await import('../src/main/database/adapters/sybase/sybase-catalog');
  const reply = (sql: string) => {
    if (sql.includes('@@ncharsize')) return [{ size: 3 }];
    if (sql.includes('syscolumns c JOIN'))
      return [
        { name: 'a', type: 'nvarchar', length: 150, status: 8, cdefault: 0 },
        { name: 'b', type: 'nchar', length: 30, status: 0, cdefault: 0 },
        { name: 'c', type: 'varchar', length: 20, status: 8, cdefault: 0 },
      ];
    return [];
  };
  const adapter = {
    query: async (sql: string) => ({ rows: reply(sql), hasMore: false }),
  } as never;
  const { columns } = await aseColumns(adapter, { schema: 'dbo', table: 't' } as never);
  expect(columns.map((column) => column.type)).toEqual([
    'nvarchar(50)',
    'nchar(10)',
    'varchar(20)',
  ]);
});

it('stopping a long read does not delay the next request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dw-sqlite-read-stop-'));
  const adapter = new SqliteAdapter(join(dir, 'a.db'));
  const options = { limit: 10, timeout: 20_000, readOnly: true };
  try {
    await adapter.query('SELECT 1', [], options);
    await expect(
      adapter.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 60000000) SELECT count(*) FROM c',
        [],
        { ...options, timeout: 200 },
      ),
    ).rejects.toThrow('timed out');
    const started = performance.now();
    const next = await adapter.query('SELECT 7 AS n', [], options);
    expect(next.rows).toEqual([{ n: '7' }]);
    expect(performance.now() - started).toBeLessThan(5_000);
  } finally {
    await adapter.disconnect();
  }
}, 40_000);
