import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type { SqlAdapter } from '../src/main/database/adapter';
import { aseSchemas } from '../src/main/database/adapters/sybase/sybase-catalog';
import { assertAseReadOnly } from '../src/main/security/ase-readonly';

it('lists only owners of browsable tables/views or attached triggers, once each', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Local in-memory catalog fixture, never an ASE connection or server write.
    db.exec(`ATTACH DATABASE ':memory:' AS dbo;
      CREATE TABLE dbo.sysusers(uid INTEGER, suid INTEGER, name TEXT);
      CREATE TABLE dbo.sysobjects(id INTEGER, uid INTEGER, type TEXT, deltrig INTEGER, instrig INTEGER, updtrig INTEGER);
      INSERT INTO dbo.sysusers VALUES (1,1,'dbo'),(2,2,'table_owner'),(3,3,'view_owner'),(4,4,'trigger_owner'),(5,5,'empty_user'),(6,6,'procedure_owner'),(7,7,'orphan_trigger_owner'),(8,8,'system_owner');
      INSERT INTO dbo.sysobjects VALUES (10,1,'U',20,21,22),(11,1,'V',0,0,0),(12,2,'U',0,0,0),(13,3,'V',0,0,0),
        (20,4,'TR',0,0,0),(21,4,'TR',0,0,0),(22,4,'TR',0,0,0),(30,7,'TR',0,0,0),(40,6,'P',0,0,0),(50,8,'S',0,0,0);`);
    const query = vi.fn(async (sql: string) => {
      assertAseReadOnly(sql);
      expect(sql).not.toMatch(/\bJOIN\b/i); // ASE11 comma-join compatibility.
      return { rows: db.prepare(sql).all(), columns: ['name'], hasMore: false };
    });
    const owners = await aseSchemas({ query } as unknown as SqlAdapter);
    expect(owners).toEqual(['dbo', 'table_owner', 'trigger_owner', 'view_owner']);
    expect(query).toHaveBeenCalledWith(expect.any(String), [], {
      limit: 5000,
      timeout: 30000,
      readOnly: true,
    });
    db.exec('DELETE FROM dbo.sysobjects');
    expect(await aseSchemas({ query } as unknown as SqlAdapter)).toEqual([]);
  } finally {
    db.close();
  }
});

it('rejects truncated owner metadata instead of returning an incomplete hierarchy', async () => {
  const query = vi.fn(async () => ({ rows: [{ name: 'dbo' }], hasMore: true }));
  await expect(aseSchemas({ query } as unknown as SqlAdapter)).rejects.toThrow('5000-row limit');
});

it('propagates catalog failures without substituting the full user list', async () => {
  const query = vi.fn(async () => {
    throw new Error('catalog unavailable');
  });
  await expect(aseSchemas({ query } as unknown as SqlAdapter)).rejects.toThrow(
    'catalog unavailable',
  );
  expect(query).toHaveBeenCalledTimes(1);
});
