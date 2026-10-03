import { it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sqliteSqlExport } from '../src/main/database/adapters/sqlite/export-process';
import { sqliteScriptSession } from '../src/main/database/adapters/sqlite/script-process';
import { splitSqlScript } from '../src/main/database/sql-script-parser';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { createAdapter } from '../src/main/database/factory';

async function dump(file: string, includeData = true, write?: (chunk: string) => Promise<void>) {
  let sql = '';
  await sqliteSqlExport(file, {
    includeData,
    signal: new AbortController().signal,
    timeout: 10000,
    write: async (chunk) => {
      sql += chunk;
      await write?.(chunk);
    },
    progress: () => {},
  });
  return sql;
}
for (const encoding of ['UTF-8', 'UTF-16le'])
  it(`SQLite SQL export preserves exact values, objects and sequence state (${encoding})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-export-test-'));
    const source = join(dir, 'source.db'),
      target = join(dir, 'target.db');
    let db: DatabaseSync | undefined, restored: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(source);
      db.exec(
        `PRAGMA encoding='${encoding}'; PRAGMA user_version=23; PRAGMA application_id=128;
      CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL COLLATE NOCASE UNIQUE);
      INSERT INTO parent VALUES(1,'one'),(500,'deleted'); DELETE FROM parent WHERE id=500;
      CREATE TABLE "odd\"名字"(id INTEGER PRIMARY KEY, value TEXT, data BLOB, num, real_num REAL, computed TEXT GENERATED ALWAYS AS (value||'!') VIRTUAL, stored INT GENERATED ALWAYS AS (id*2) STORED, parent_id INT REFERENCES parent(id));
      INSERT INTO "odd\"名字"(id,value,data,num,real_num,parent_id) VALUES(77, '中😀'||char(0)||'文', X'00FFAA', 9223372036854775807, 1.2345678901234567, 1),
        (80, '', X'', -9223372036854775808, 9e999, NULL), (100,NULL,NULL,0,-9e999,1);
      CREATE TABLE gap(value TEXT); INSERT INTO gap(rowid,value) VALUES(123,'gap');
      CREATE TABLE wr(a TEXT,b INT,PRIMARY KEY(a,b)) WITHOUT ROWID; INSERT INTO wr VALUES('x',2);
      CREATE UNIQUE INDEX "odd index" ON "odd\"名字"(value) WHERE value IS NOT NULL;
      CREATE VIEW vv AS SELECT id, computed FROM "odd\"名字";
      CREATE TABLE log(value TEXT);
      CREATE TRIGGER tt AFTER INSERT ON gap BEGIN INSERT INTO log VALUES(new.value); UPDATE gap SET value=value WHERE rowid=new.rowid; END;
    `.replaceAll('odd"名字', 'odd""名字'),
      );
      const sql = await dump(source);
      await sqliteScriptSession(target, async (execute) => {
        for (const unit of splitSqlScript(sql, 'sqlite'))
          await execute(unit.sql, new AbortController().signal, 10000);
      });
      restored = new DatabaseSync(target);
      const dataSql =
        'SELECT id,hex(CAST(value AS BLOB)) AS text_hex,hex(data) AS blob_hex,CAST(num AS TEXT) AS integer_text,real_num,hex(CAST(computed AS BLOB)) AS generated_hex,stored,parent_id FROM "odd""名字" ORDER BY id';
      expect(restored.prepare(dataSql).all()).toEqual(db.prepare(dataSql).all());
      expect(restored.prepare('SELECT rowid,* FROM gap').all()).toEqual(
        db.prepare('SELECT rowid,* FROM gap').all(),
      );
      expect(restored.prepare('SELECT * FROM wr').all()).toEqual(
        db.prepare('SELECT * FROM wr').all(),
      );
      expect(restored.prepare('SELECT * FROM log').all()).toEqual([]);
      expect(restored.prepare('SELECT * FROM vv').all()).toEqual(
        db.prepare('SELECT * FROM vv').all(),
      );
      restored.exec(
        "INSERT INTO parent(value) VALUES('next'); INSERT INTO gap(value) VALUES('trigger');",
      );
      expect(restored.prepare("SELECT id FROM parent WHERE value='next'").get()?.id).toBe(501);
      expect(restored.prepare('SELECT * FROM log').get()?.value).toBe('trigger');
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(restored.prepare('PRAGMA encoding').get()?.encoding).toBe(encoding);
      expect(restored.prepare('PRAGMA user_version').get()?.user_version).toBe(23);
      const schemaFile = join(dir, 'schema.db');
      const schema = new DatabaseSync(schemaFile);
      try {
        schema.exec(await dump(source, false));
        expect(schema.prepare('SELECT count(*) AS n FROM parent').get()?.n).toBe(0);
        expect(
          schema.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").get()?.name,
        ).toBe('tt');
      } finally {
        schema.close();
      }
    } finally {
      db?.close();
      restored?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

it('SQLite export uses one WAL snapshot and supports cancellation / unsupported-object refusal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dw-export-test-')),
    file = join(dir, 'test.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(value); INSERT INTO t VALUES(1);');
    let changed = false;
    const sql = await dump(file, true, async () => {
      if (!changed) {
        changed = true;
        db.exec('UPDATE t SET value=2; INSERT INTO t VALUES(3);');
      }
    });
    const restored = new DatabaseSync(':memory:');
    try {
      restored.exec(sql);
      expect(restored.prepare('SELECT value FROM t').all()).toEqual([{ value: 1 }]);
    } finally {
      restored.close();
    }
    const controller = new AbortController();
    await expect(
      sqliteSqlExport(file, {
        includeData: true,
        signal: controller.signal,
        timeout: 10000,
        write: async () => {
          controller.abort();
        },
        progress: () => {},
      }),
    ).rejects.toThrow('cancelled');
    db.exec('CREATE VIRTUAL TABLE search USING fts5(text);');
    await expect(dump(file)).rejects.toThrow('virtual/shadow');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function fixture() {
  return new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(DEFAULT_SETTINGS),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    { get: () => undefined, set: () => {}, delete: () => {} },
    createAdapter,
  );
}
async function finish(app: Application, id: string) {
  for (let i = 0; i < 1000; i++) {
    const progress = app.exports.status(id, HUMAN);
    if (progress.state !== 'running') return progress;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Export did not finish.');
}
it('SQL export commands enforce ownership, revocation, safe saving and the import-size bound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dw-export-service-')),
    file = join(dir, 'source.sql');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t(value); INSERT INTO t VALUES(42);');
  db.close();
  const app = fixture();
  try {
    const connection = await app.connections.save({
      name: 'export',
      engine: 'sqlite',
      database: file,
      agentAccess: 'read',
    });
    await app.connections.connect(connection.id);
    const id = randomUUID();
    const started = await app.commands.dispatch(
      'export.start',
      { id, connectionId: connection.id, database: file, includeData: true },
      HUMAN,
    );
    expect(started.success, started.error).toBe(true);
    expect((await finish(app, id)).state).toBe('completed');
    const reader = { kind: 'agent' as const, id: 'desktop', name: 'cannot impersonate' };
    expect(() => app.exports.status(id, reader)).toThrow('not found');
    const chunks = await app.exports.read(id, 0, HUMAN);
    expect(chunks.done).toBe(true);
    expect(Buffer.from(chunks.base64, 'base64').toString()).toContain('INSERT INTO "t"');
    await expect(app.exports.save(id, file, HUMAN)).rejects.toThrow('overwrite');
    const saved = join(dir, 'saved.sql');
    await app.exports.save(id, saved, HUMAN);
    expect(await readFile(saved, 'utf8')).toContain('COMMIT;');
    await app.exports.release(id, HUMAN);
    expect(() => app.exports.status(id, HUMAN)).toThrow('not found');
    const cancelled = randomUUID();
    await app.exports.start(
      { id: cancelled, connectionId: connection.id, database: file, includeData: true },
      HUMAN,
    );
    await app.connections.disconnect(connection.id, true);
    expect((await finish(app, cancelled)).state).toBe('cancelled');
    expect(app.connections.status(connection.id).connected).toBe(false);
    await app.exports.release(cancelled, HUMAN);
    await app.connections.connect(connection.id, undefined, true);
    const own = randomUUID();
    await app.exports.start(
      { id: own, connectionId: connection.id, database: file, includeData: false },
      reader,
    );
    expect((await finish(app, own)).state).toBe('completed');
    await app.connections.save({ ...connection, agentAccess: 'disabled' });
    await expect(app.exports.read(own, 0, reader)).rejects.toThrow('disabled');
    await app.exports.release(own, reader);
    const large = new DatabaseSync(file);
    large.exec('INSERT INTO t VALUES(zeroblob(9000000));');
    large.close();
    await app.connections.connect(connection.id);
    const big = randomUUID();
    await app.exports.start(
      { id: big, connectionId: connection.id, database: file, includeData: true },
      HUMAN,
    );
    const result = await finish(app, big);
    expect(result.state).toBe('failed');
    expect(result.error).toContain('16 MiB');
    await expect(app.exports.read(big, 0, HUMAN)).rejects.toThrow('not ready');
    await app.connections.delete(connection.id, true);
    await app.exports.release(big, HUMAN);
  } finally {
    await app.exports.shutdown();
    await app.connections.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
