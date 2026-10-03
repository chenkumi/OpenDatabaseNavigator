import { it, expect } from 'vitest';
import { createServer, createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { createServer as createTlsServer, connect as connectTls } from 'node:tls';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { Request as TdsRequest, type Connection as TdsConnection } from 'tedious';
import type { Pool, PoolConnection } from 'mysql2';
import { SocketTimeouts } from '../src/main/database/adapters/network/socket-timeouts';
import { MysqlAdapter } from '../src/main/database/adapters/mysql/mysql-adapter';
import { mysqlSqlExport } from '../src/main/database/adapters/mysql/sql-export';
import { PostgresAdapter } from '../src/main/database/adapters/postgres/postgres-adapter';
import { SqlServerAdapter } from '../src/main/database/adapters/sqlserver/sqlserver-adapter';
import { connectionSchema } from '../src/shared/schemas';
import type { Connection } from '../src/shared/types';

async function sockets(task: (client: Socket, peer: Socket) => Promise<void>) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = createConnection({
    host: '127.0.0.1',
    port: (server.address() as { port: number }).port,
  });
  await once(client, 'connect');
  const [peer] = (await accepted) as [Socket];
  client.on('error', () => {});
  peer.on('error', () => {});
  try {
    await task(client, peer);
  } finally {
    client.destroy();
    peer.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it('measures receive inactivity, preserves idle connections, and releases deadlines', async () => {
  await sockets(async (client, peer) => {
    const guard = new SocketTimeouts(client, { readTimeout: 150 });
    await delay(180);
    expect(client.destroyed).toBe(false);
    const release = guard.begin();
    for (let i = 0; i < 5; i++) {
      const received = once(client, 'data');
      peer.write('part');
      await received;
      await delay(45);
    }
    expect(client.destroyed).toBe(false); // Total runtime exceeds the read limit.
    release();
    release();
    await delay(180);
    expect(client.destroyed).toBe(false);
    const failed = once(client, 'error');
    guard.begin();
    expect((await failed)[0]).toMatchObject({ code: 'EREADTIMEOUT' });
    expect(client.destroyed).toBe(true);
  });
});

it('does not count locally paused result consumption as network inactivity', async () => {
  await sockets(async (client, peer) => {
    const guard = new SocketTimeouts(client, { readTimeout: 100 });
    const release = guard.begin();
    client.pause();
    peer.write('buffered result');
    await delay(150);
    expect(client.destroyed).toBe(false);
    const received = once(client, 'data');
    client.resume();
    await received;
    release();
  });
});

it('suspends read deadlines above the socket layer and resumes only after all consumers resume', async () => {
  await sockets(async (client) => {
    const guard = new SocketTimeouts(client, { readTimeout: 100 });
    const release = guard.begin();
    const resumeFirst = guard.suspendRead();
    const resumeSecond = guard.suspendRead();
    await delay(140);
    resumeFirst();
    resumeFirst();
    await delay(140);
    expect(client.destroyed).toBe(false);
    const failed = once(client, 'error');
    resumeSecond();
    expect((await failed)[0]).toMatchObject({ code: 'EREADTIMEOUT' });
    release();
  });
});

it('aborts a blocked transport write even when receive traffic continues', async () => {
  let finishWrite!: (error?: Error | null) => void;
  const transport = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      finishWrite = callback;
    },
  });
  const guard = new SocketTimeouts(transport as Socket, { writeTimeout: 120 });
  const release = guard.begin();
  const failed = once(transport, 'error');
  let callbackCount = 0;
  transport.write('blocked', () => {
    callbackCount++;
  });
  const traffic = setInterval(() => transport.push(Buffer.from('received')), 20);
  try {
    const [error] = await failed;
    expect(error).toMatchObject({ code: 'EWRITETIMEOUT' });
    finishWrite(error);
    await delay(10);
    expect(callbackCount).toBe(1);
    expect(transport.destroyed).toBe(true);
  } finally {
    clearInterval(traffic);
    release();
    transport.destroy();
  }
});

it('validates network timeout settings without changing old connection defaults', () => {
  expect(connectionSchema.parse({ engine: 'mysql', name: 'old' })).toMatchObject({
    readTimeout: 0,
    writeTimeout: 0,
  });
  for (const field of ['readTimeout', 'writeTimeout']) {
    expect(
      connectionSchema.safeParse({ engine: 'postgres', name: 'supported', [field]: 100 }).success,
    ).toBe(true);
    expect(
      connectionSchema.safeParse({ engine: 'sqlserver', name: 'SQL auth', [field]: 100 }).success,
    ).toBe(true);
    expect(
      connectionSchema.safeParse({
        engine: 'sqlserver',
        sqlServerAuth: 'windows',
        name: 'ODBC',
        [field]: 100,
      }).success,
    ).toBe(false);
    for (const value of [-1, 1.5, 300001])
      expect(
        connectionSchema.safeParse({ engine: 'mysql', name: 'invalid', [field]: value }).success,
      ).toBe(false);
    expect(
      connectionSchema.safeParse({ engine: 'sybase', name: 'ASE native relay', [field]: 100 })
        .success,
    ).toBe(true);
    expect(
      connectionSchema.safeParse({
        engine: 'sqlite',
        name: 'unsupported',
        database: ':memory:',
        [field]: 100,
      }).success,
    ).toBe(false);
  }
});

it.each(['read', 'write'] as const)(
  'applies the %s deadline to an authenticated TLS transport',
  async (direction) => {
    const cert = readFileSync(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));
    const key = readFileSync(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
    const server = createTlsServer({ cert, key });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const accepted = once(server, 'secureConnection');
    const client = connectTls({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
      servername: 'localhost',
      ca: cert,
      rejectUnauthorized: true,
    });
    await once(client, 'secureConnect');
    const [peer] = (await accepted) as [Socket];
    peer.on('error', () => {});
    try {
      expect(client.authorized).toBe(true);
      const guard = new SocketTimeouts(
        client,
        direction === 'read' ? { readTimeout: 120 } : { writeTimeout: 120 },
      );
      const failed = once(client, 'error');
      const release = guard.begin();
      if (direction === 'write') {
        client.cork();
        client.write('blocked encrypted request');
      }
      expect((await failed)[0]).toMatchObject({
        code: direction === 'read' ? 'EREADTIMEOUT' : 'EWRITETIMEOUT',
      });
      release();
    } finally {
      client.destroy();
      peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

for (const port of [13306, 13307])
  it.skipIf(process.env.DB_INTEGRATION !== '1')(
    `MySQL network deadlines cover queries, SQL scripts and SQL export (${port})`,
    async () => {
      const database = 'dw_io_' + randomUUID().replaceAll('-', '').slice(0, 12);
      const password = process.env.DB_TEST_PASSWORD;
      const connection = {
        ...connectionSchema.parse({
          name: 'I/O',
          engine: 'mysql',
          host: '127.0.0.1',
          port,
          username: 'root',
          database,
          readTimeout: 150,
          writeTimeout: 1000,
        }),
        id: randomUUID(),
      } as Connection;
      const admin = await mysql.createConnection({
        host: connection.host,
        port,
        user: 'root',
        password,
      });
      let adapter: MysqlAdapter | undefined;
      try {
        await admin.query('CREATE DATABASE `' + database + '`');
        await admin.query('CREATE TABLE `' + database + '`.items(id int)');
        adapter = new MysqlAdapter(connection, password);
        await adapter.connect();
        await delay(220); // An idle pool must remain usable.
        expect(
          String(
            (await adapter.query('SELECT 1 AS n', [], { readOnly: true, limit: 1, timeout: 5000 }))
              .rows[0].n,
          ),
        ).toBe('1');
        await expect(
          adapter.query('SELECT SLEEP(2)', [], { readOnly: true, limit: 1, timeout: 5000 }),
        ).rejects.toThrow('Network read timed out');
        expect(
          String(
            (await adapter.query('SELECT 2 AS n', [], { readOnly: true, limit: 1, timeout: 5000 }))
              .rows[0].n,
          ),
        ).toBe('2');
        // Hold actual TCP writes in the socket buffer to exercise the driver's
        // write/error path deterministically (Windows loopback buffers can
        // otherwise accept an entire large test payload immediately).
        const pool = (adapter as unknown as { pool: Pool }).pool;
        const held = await new Promise<PoolConnection>((resolve, reject) =>
          pool.getConnection((error, client) => (error ? reject(error) : resolve(client))),
        );
        (held as unknown as { stream: Socket }).stream.cork();
        held.release();
        await expect(
          adapter.query('SELECT 3', [], { readOnly: true, limit: 1, timeout: 5000 }),
        ).rejects.toThrow('Network write timed out');
        await expect(
          adapter.withScriptSession(async (execute) =>
            execute('SELECT SLEEP(2)', new AbortController().signal, 5000),
          ),
        ).rejects.toThrow('Network read timed out');
        await admin.query('LOCK TABLES `' + database + '`.items WRITE');
        try {
          await expect(
            mysqlSqlExport(connection, password, {
              includeData: true,
              timeout: 5000,
              signal: new AbortController().signal,
              write: async () => {},
              progress: () => {},
            }),
          ).rejects.toThrow('Network read timed out');
        } finally {
          await admin.query('UNLOCK TABLES');
        }
        await adapter.disconnect();
      } finally {
        await adapter?.disconnect();
        await admin.query('DROP DATABASE IF EXISTS `' + database + '`');
        await admin.end();
      }
    },
    20000,
  );

it.skipIf(process.env.DB_INTEGRATION !== '1')(
  'PostgreSQL deadlines cover protocol dispatch, queued queries, DDL and SQL sessions',
  async () => {
    const connection = {
      ...connectionSchema.parse({
        name: 'PostgreSQL I/O',
        engine: 'postgres',
        host: '127.0.0.1',
        port: 15432,
        username: 'workspace',
        database: 'workspace',
        readTimeout: 180,
        writeTimeout: 250,
      }),
      id: randomUUID(),
    } as Connection;
    const adapter = new PostgresAdapter(connection, process.env.DB_TEST_PASSWORD);
    const query = (sql: string) =>
      adapter.query(sql, [], { readOnly: false, limit: 100, timeout: 5000 });
    try {
      await adapter.connect();
      await delay(240);
      expect((await query('SELECT 1 AS n')).rows[0].n).toBe(1);
      // Receiving notices constitutes network progress even when the statement
      // runs longer than the read deadline and produces no result rows yet.
      await query(
        "DO $$ BEGIN FOR i IN 1..8 LOOP PERFORM pg_sleep(0.06); RAISE NOTICE 'progress'; END LOOP; END $$",
      );
      await expect(query('SELECT pg_sleep(2)')).rejects.toThrow('Network read timed out');
      expect((await query('SELECT 2 AS n')).rows[0].n).toBe(2);
      await expect(query('SELECT invalid_io_column')).rejects.toThrow('does not exist');
      await delay(240);
      expect((await query('SELECT 3 AS n')).rows[0].n).toBe(3);
      const pool = (adapter as unknown as { pool: pg.Pool }).pool;
      const client = await pool.connect();
      try {
        // Named statements skip Parse after their first invocation.
        const prepared = { name: 'io-prepared', text: 'SELECT $1::int AS n', values: [4] };
        expect((await client.query(prepared)).rows[0].n).toBe(4);
        expect((await client.query({ ...prepared, values: [5] })).rows[0].n).toBe(5);
        const queued = Array.from({ length: 6 }, () => client.query('SELECT pg_sleep(0.06)'));
        await Promise.all(queued); // Queue wait exceeds 180 ms; each dispatch does not.
        (client as unknown as { connection: { stream: Socket } }).connection.stream.cork();
        await expect(client.query(prepared)).rejects.toThrow('Network write timed out');
      } finally {
        client.release(true);
      }
      await expect(adapter.executeDdl(['SELECT pg_sleep(2)'], 5000)).rejects.toThrow(
        'Network read timed out',
      );
      await expect(
        adapter.withScriptSession(async (execute) => {
          await execute('SELECT 1', new AbortController().signal, 5000);
          await delay(240);
          await execute('SELECT pg_sleep(2)', new AbortController().signal, 5000);
        }),
      ).rejects.toThrow('Network read timed out');
      expect((await query('SELECT 6 AS n')).rows[0].n).toBe(6);
    } finally {
      await adapter.disconnect();
    }
  },
  15000,
);

it.skipIf(process.env.DB_INTEGRATION !== '1')(
  'SQL Server password authentication deadlines cover queries, transactions, paused results and SQL files',
  async () => {
    const connection = {
      ...connectionSchema.parse({
        name: 'SQL Server I/O',
        engine: 'sqlserver',
        host: '127.0.0.1',
        port: 11433,
        username: 'sa',
        database: 'master',
        readTimeout: 200,
        writeTimeout: 300,
      }),
      id: randomUUID(),
    } as Connection;
    const adapter = new SqlServerAdapter(connection, process.env.DB_TEST_PASSWORD, 1);
    const query = (sql: string) =>
      adapter.query(sql, [], { readOnly: false, limit: 100, timeout: 5000 });
    try {
      await adapter.connect();
      await delay(280);
      expect((await query('SELECT 1 AS n')).rows[0].n).toBe(1);
      await query(
        "DECLARE @n INT=0; WHILE @n<8 BEGIN RAISERROR('progress',0,1) WITH NOWAIT; WAITFOR DELAY '00:00:00.06'; SET @n+=1; END;",
      );
      await expect(query("WAITFOR DELAY '00:00:02'; SELECT 2 AS n")).rejects.toThrow(
        'Network read timed out',
      );
      expect((await query('SELECT 3 AS n')).rows[0].n).toBe(3);
      await expect(query('SELECT invalid_io_column')).rejects.toThrow('Invalid column name');
      await delay(280);
      expect((await query('SELECT 4 AS n')).rows[0].n).toBe(4);
      const pool = (
        adapter as unknown as {
          pool: {
            acquire(requester: object): Promise<TdsConnection>;
            release(connection: TdsConnection): void;
            config: { validateConnection: boolean };
          };
        }
      ).pool;
      const held = await pool.acquire({});
      try {
        // Consume the first row, pause longer than the read deadline, then
        // consume the server's buffered second result without a false timeout.
        await new Promise<void>((resolve, reject) => {
          const request = new TdsRequest(
            "SELECT 1 AS n; WAITFOR DELAY '00:00:00.1'; SELECT 2 AS n",
            (error) => (error ? reject(error) : resolve()),
          );
          let first = true;
          request.on('row', () => {
            if (first) {
              first = false;
              request.pause();
              setTimeout(() => request.resume(), 500);
            }
          });
          held.execSqlBatch(request);
        });
        // Do not let pool validation consume the deliberately blocked write.
        pool.config.validateConnection = false;
        held.socket!.cork();
      } finally {
        pool.release(held);
      }
      await expect(query('SELECT 5 AS n')).rejects.toThrow('Network write timed out');
      await expect(adapter.executeDdl(["WAITFOR DELAY '00:00:02'"], 5000)).rejects.toThrow(
        'Network read timed out',
      );
      await expect(
        adapter.withScriptSession(async (execute) => {
          await execute('SELECT 1', new AbortController().signal, 5000);
          await delay(280);
          await execute("WAITFOR DELAY '00:00:02'", new AbortController().signal, 5000);
        }),
      ).rejects.toThrow('Network read timed out');
      expect((await query('SELECT 6 AS n')).rows[0].n).toBe(6);
    } finally {
      await adapter.disconnect();
    }
  },
  20000,
);
