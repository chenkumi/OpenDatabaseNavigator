import { expect, it } from 'vitest';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';
import { listDatabaseObjects } from '../src/main/application/services/database-metadata';
import { connectionSchema } from '../src/shared/schemas';
it('lists SQLite indexes and triggers with their table and definition', async () => {
  const adapter = new SqliteAdapter(':memory:');
  const options = { limit: 10, timeout: 5000, readOnly: false };
  try {
    await adapter.query('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)', [], options);
    await adapter.query('CREATE INDEX items_name ON items(name)', [], options);
    await adapter.query(
      'CREATE TRIGGER items_trigger AFTER INSERT ON items BEGIN SELECT 1; END',
      [],
      options,
    );
    const connection = {
      ...connectionSchema.parse({ name: 'test', engine: 'sqlite', database: ':memory:' }),
      id: 'test',
    };
    expect(await listDatabaseObjects(adapter, connection, 'index')).toEqual([
      expect.objectContaining({
        name: 'items_name',
        table: 'items',
        schema: 'main',
        definition: 'CREATE INDEX items_name ON items(name)',
      }),
    ]);
    expect(await listDatabaseObjects(adapter, connection, 'trigger')).toEqual([
      expect.objectContaining({ name: 'items_trigger', table: 'items', schema: 'main' }),
    ]);
  } finally {
    await adapter.disconnect();
  }
});
