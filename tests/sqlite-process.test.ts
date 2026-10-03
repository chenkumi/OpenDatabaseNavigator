import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';

const options = { limit: 10, timeout: 20_000, readOnly: false };
const expensiveInsert = `WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 60000000
) INSERT INTO t SELECT sum(x) FROM c`;

async function fixture(task: (adapter: SqliteAdapter) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'dw-sqlite-process-'));
  const adapter = new SqliteAdapter(join(dir, 'test.sqlite'));
  try {
    await task(adapter);
  } finally {
    await adapter.disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

it('kills a timed-out native write, rolls it back, and releases the file before the next write', async () => {
  await fixture(async (adapter) => {
    await adapter.query('CREATE TABLE t(x INTEGER)', [], options);
    await expect(adapter.query(expensiveInsert, [], { ...options, timeout: 200 }))
      .rejects.toThrow('Query timed out.');
    const start = performance.now();
    await adapter.query('INSERT INTO t VALUES (7)', [], options);
    expect(performance.now() - start).toBeLessThan(5_000);
    expect((await adapter.query('SELECT x FROM t', [], options)).rows).toEqual([{ x: '7' }]);
  });
}, 30_000);

it('AbortSignal stops a native write without leaving locks or partially committed rows', async () => {
  await fixture(async (adapter) => {
    await adapter.query('CREATE TABLE t(x INTEGER)', [], options);
    const controller = new AbortController();
    const query = adapter.query(expensiveInsert, [], { ...options, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      await expect(query).rejects.toThrow('Query cancelled.');
    } finally {
      clearTimeout(timer);
    }
    await adapter.query('INSERT INTO t VALUES (9)', [], options);
    expect((await adapter.query('SELECT x FROM t', [], options)).rows).toEqual([{ x: '9' }]);
  });
}, 30_000);

it('disconnect terminates an executing native statement and permits a clean reconnect', async () => {
  await fixture(async (adapter) => {
    await adapter.query('CREATE TABLE t(x INTEGER)', [], options);
    const query = adapter.query(expensiveInsert, [], options);
    const rejected = expect(query).rejects.toThrow('Database process stopped.');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const start = performance.now();
    await adapter.disconnect();
    await rejected;
    expect(performance.now() - start).toBeLessThan(5_000);
    await adapter.query('INSERT INTO t VALUES (11)', [], options);
    expect((await adapter.query('SELECT x FROM t', [], options)).rows).toEqual([{ x: '11' }]);
  });
}, 30_000);

it('concurrent connect calls share a session, preserving memory databases and binary parameters', async () => {
  const adapter = new SqliteAdapter(':memory:');
  try {
    await Promise.all([adapter.connect(), adapter.connect(), adapter.connect()]);
    await adapter.query('CREATE TABLE t(value BLOB)', [], options);
    await adapter.query('INSERT INTO t VALUES (?)', [new Uint8Array([0, 255, 128])], options);
    expect((await adapter.query('SELECT value FROM t', [], options)).rows)
      .toEqual([{ value: 'AP+A' }]);
  } finally {
    await adapter.disconnect();
  }
});

it('disconnect during startup does not leave a live memory database behind', async () => {
  const adapter = new SqliteAdapter(':memory:');
  try {
    const connecting = adapter.connect();
    await adapter.disconnect();
    await connecting;
    // A new connection must be usable after the startup/disconnect race.
    expect((await adapter.query('SELECT 7 AS n', [], options)).rows).toEqual([{ n: '7' }]);
  } finally {
    await adapter.disconnect();
  }
});

it('a startup failure rejects promptly and can be disconnected without hanging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dw-sqlite-startup-'));
  const adapter = new SqliteAdapter(join(dir, 'missing', 'test.sqlite'));
  try {
    await expect(adapter.connect()).rejects.toThrow('SQLite process stopped during startup.');
  } finally {
    await adapter.disconnect();
    await rm(dir, { recursive: true, force: true });
  }
});
