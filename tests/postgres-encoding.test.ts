import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createServer, createConnection, type Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import iconv from 'iconv-lite';
import { PostgresAdapter } from '../src/main/database/adapters/postgres/postgres-adapter';
import {
  PostgresTextProtocol,
  postgresEncodingClient,
} from '../src/main/database/adapters/postgres/text-protocol';
import { POSTGRES_ENCODINGS } from '../src/shared/client-encodings';
import { connectionSchema } from '../src/shared/schemas';

const vectors = [
  ['UTF8', 'utf8', '\uFEFF中文😀'],
  ['LATIN1', 'latin1', 'café'],
  ['WIN1252', 'windows1252', '€café'],
  ['BIG5', 'big5', '許中文'],
  ['GBK', 'gbk', '中文'],
  ['GB18030', 'gb18030', '中文😀'],
  ['SJIS', 'shiftjis', 'ソ日本'],
  ['EUC_JP', 'eucjp', '日本'],
];
const i32 = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value);
  return b;
};
const i16 = (value: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value);
  return b;
};
const frame = (code: string, body: Buffer) =>
  Buffer.concat([Buffer.from(code), i32(body.length + 4), body]);
const cstr = (text: string, codec = 'utf8') =>
  Buffer.concat([iconv.encode(text, codec), Buffer.from([0])]);

it.each(vectors)(
  'transcodes %s protocol text across arbitrary packet boundaries',
  (charset, codec, text) => {
    const protocol = new PostgresTextProtocol(charset);
    const sql = 'select ' + text;
    expect(protocol.outgoing(frame('Q', cstr(sql)))).toEqual(frame('Q', cstr(sql, codec)));
    const wire = Buffer.concat([
      frame('T', Buffer.concat([i16(1), cstr(text, codec), Buffer.alloc(18)])),
      frame(
        'D',
        Buffer.concat([i16(1), i32(iconv.encode(text, codec).length), iconv.encode(text, codec)]),
      ),
      frame('N', Buffer.concat([Buffer.from('M'), cstr(text, codec), Buffer.from([0])])),
    ]);
    const result: Buffer[] = [];
    for (const byte of wire) protocol.receive(Buffer.from([byte]), (value) => result.push(value));
    expect(result[0]).toEqual(frame('T', Buffer.concat([i16(1), cstr(text), Buffer.alloc(18)])));
    expect(result[1]).toEqual(
      frame('D', Buffer.concat([i16(1), i32(Buffer.byteLength(text)), Buffer.from(text)])),
    );
    expect(result[2]).toEqual(
      frame('N', Buffer.concat([Buffer.from('M'), cstr(text), Buffer.from([0])])),
    );
  },
);
it('keeps binary parameters unchanged and refuses malformed frames or encoding changes', () => {
  const codec = new PostgresTextProtocol('BIG5');
  expect(() => codec.startup({ database: 'db\0user\0other' })).toThrow('startup parameter');
  const bytes = Buffer.from([0, 255, 0x80]);
  const bind = Buffer.concat([
    cstr(''),
    cstr(''),
    i16(2),
    i16(0),
    i16(1),
    i16(2),
    i32(6),
    Buffer.from('中文'),
    i32(3),
    bytes,
    i16(1),
    i16(0),
  ]);
  expect(codec.outgoing(frame('B', bind))).toEqual(
    frame(
      'B',
      Buffer.concat([
        cstr(''),
        cstr(''),
        i16(2),
        i16(0),
        i16(1),
        i16(2),
        i32(4),
        Buffer.from('a4a4a4e5', 'hex'),
        i32(3),
        bytes,
        i16(1),
        i16(0),
      ]),
    ),
  );
  expect(() => codec.outgoing(frame('Q', cstr('😀')))).toThrow('losslessly');
  expect(() =>
    codec.receive(frame('S', Buffer.concat([cstr('client_encoding'), cstr('UTF8')])), () => {}),
  ).toThrow('Changing client_encoding');
  expect(() =>
    new PostgresTextProtocol('UTF8').receive(Buffer.from([68, 127, 255, 255, 255]), () => {}),
  ).toThrow('64 MiB');
  expect(vectors.map((v) => v[0])).toEqual(POSTGRES_ENCODINGS.map((e) => e.value));
  for (const { value } of POSTGRES_ENCODINGS)
    expect(
      connectionSchema.safeParse({ name: 'pg', engine: 'postgres', charset: value }).success,
    ).toBe(true);
  expect(
    connectionSchema.safeParse({ name: 'pg', engine: 'postgres', charset: 'SQL_ASCII' }).success,
  ).toBe(false);
});

const integration = process.env.DB_INTEGRATION === '1';
const password = process.env.DB_TEST_PASSWORD;
const config = (charset: string) => ({
  ...connectionSchema.parse({
    name: 'encoding',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 15432,
    username: 'workspace',
    database: 'workspace',
    charset,
    readTimeout: 2000,
    writeTimeout: 2000,
  }),
  id: 'pg-encoding',
});
it.skipIf(!integration).each(vectors)(
  'round-trips %s SQL, values, identifiers, arrays and JSON on PostgreSQL',
  async (charset, _codec, text) => {
    const adapter = new PostgresAdapter(config(charset), password);
    const table = 'enc_' + randomUUID().replaceAll('-', '');
    const query = (sql: string, params: unknown[] = [], readOnly = false, limit = 5) =>
      adapter.query(sql, params, { readOnly, timeout: 10000, limit });
    try {
      await adapter.connect();
      expect((await query('SHOW client_encoding')).rows[0].client_encoding).toBe(charset);
      await adapter.executeDdl(
        [
          `CREATE TABLE ${table} (id int primary key, "${text}" text, bytes bytea, data jsonb, items text[])`,
        ],
        10000,
      );
      const bytes = Buffer.from([0, 255, 0x80, 0x5c]);
      await query(`INSERT INTO ${table} VALUES (1,$1,$2,$3,$4)`, [
        text,
        bytes,
        { value: text },
        [text, null],
      ]);
      const result = (await query(`SELECT * FROM ${table}`, [], true)).rows[0];
      expect(result[text]).toBe(text);
      expect(result.bytes).toBe(bytes.toString('base64'));
      expect(result.data).toEqual({ value: text });
      expect(result.items).toEqual([text, null]);
      await adapter.withScriptSession(async (execute) => {
        const signal = new AbortController().signal;
        await execute(`UPDATE ${table} SET "${text}"='${text}' WHERE id=1`, signal, 10000);
        await execute(`SELECT "${text}" FROM ${table}`, signal, 10000);
      });
      const limited = await query('SELECT generate_series(1,100000000) AS id', [], true, 2);
      expect(limited.rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(limited.hasMore).toBe(true);
      await expect(query(`SELECT * FROM "missing_${text}"`)).rejects.toThrow('missing_' + text);
      if (!['UTF8', 'GB18030'].includes(charset)) {
        await expect(
          query(`INSERT INTO ${table}(id,"${text}") VALUES (2,$1)`, ['😀']),
        ).rejects.toThrow('losslessly');
        await expect(query(`INSERT INTO ${table}(id,"${text}") VALUES (2,'😀')`)).rejects.toThrow(
          'losslessly',
        );
        expect((await query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n).toBe('1');
      }
    } finally {
      await query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
      await adapter.disconnect();
    }
  },
  30000,
);

it.skipIf(!integration)(
  'uses the encoded protocol after verified TLS and rejects an untrusted certificate',
  async () => {
    const cert = await readFile(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));
    const key = await readFile(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
    const context = createSecureContext({ cert, key });
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      let prefix = Buffer.alloc(0);
      const negotiate = (chunk: Buffer) => {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length < 8) return;
        if (prefix.length !== 8 || prefix.readInt32BE(4) !== 80877103) {
          socket.destroy();
          return;
        }
        socket.off('data', negotiate);
        socket.write('S');
        const secure = new TLSSocket(socket, { isServer: true, secureContext: context });
        sockets.add(secure);
        secure.on('error', () => {});
        secure.once('secure', () => {
          const upstream = createConnection({ host: '127.0.0.1', port: 15432 });
          sockets.add(upstream);
          upstream.on('error', () => secure.destroy());
          upstream.once('connect', () => {
            secure.pipe(upstream);
            upstream.pipe(secure);
          });
          secure.once('close', () => upstream.destroy());
          upstream.once('close', () => secure.destroy());
        });
      };
      socket.on('data', negotiate);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const Client = postgresEncodingClient('BIG5');
    const connection = {
      host: 'localhost',
      port: (server.address() as { port: number }).port,
      user: 'workspace',
      password,
      database: 'workspace',
      connectionTimeoutMillis: 3000,
    };
    try {
      const client = new Client({ ...connection, ssl: { ca: cert, rejectUnauthorized: true } });
      await client.connect();
      try {
        expect((await client.query("SELECT '許中文' AS value")).rows).toEqual([
          { value: '許中文' },
        ]);
      } finally {
        await client.end();
      }
      const untrusted = new Client({ ...connection, ssl: { rejectUnauthorized: true } });
      try {
        await expect(untrusted.connect()).rejects.toThrow(/certificate|self-signed/);
      } finally {
        await untrusted.end();
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15000,
);

it.skipIf(!integration)(
  'rejects mid-query encoding changes before returning rows and retains prepared binary parameters',
  async () => {
    const adapter = new PostgresAdapter(config('BIG5'), password);
    try {
      await expect(
        adapter.query(
          "SELECT set_config('client_encoding','UTF8',false), '中文' FROM generate_series(1,10)",
          [],
          { limit: 1, timeout: 10000, readOnly: true },
        ),
      ).rejects.toThrow();
    } finally {
      await adapter.disconnect();
    }
    const Client = postgresEncodingClient('BIG5');
    const client = new Client({
      host: '127.0.0.1',
      port: 15432,
      user: 'workspace',
      password,
      database: 'workspace',
    });
    await client.connect();
    try {
      for (let i = 0; i < 2; i++) {
        const result = await client.query({
          name: 'encoded',
          text: 'SELECT $1::text AS "中文", $2::bytea AS bytes',
          values: ['中文', Buffer.from([0, 255])],
        });
        expect(result.rows[0]).toEqual({ 中文: '中文', bytes: Buffer.from([0, 255]) });
      }
    } finally {
      await client.end();
    }
  },
);

it.skipIf(!integration)(
  'keeps Unicode startup identities and SCRAM passwords intact with a legacy client encoding',
  async () => {
    const name = 'dw_enc_' + randomUUID().replaceAll('-', '') + '_中文';
    const secret = randomUUID() + '_中文';
    const admin = new pg.Client({
      host: '127.0.0.1',
      port: 15432,
      user: 'workspace',
      password,
      database: 'workspace',
    });
    await admin.connect();
    let created = false;
    try {
      await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}'`);
      created = true;
      const Client = postgresEncodingClient('BIG5');
      const client = new Client({
        host: '127.0.0.1',
        port: 15432,
        user: name,
        password: async () => secret,
        database: 'workspace',
      });
      try {
        await client.connect();
        expect((await client.query('SELECT current_user AS name')).rows[0].name).toBe(name);
      } finally {
        await client.end();
      }
    } finally {
      if (created) await admin.query(`DROP ROLE "${name}"`);
      await admin.end();
    }
  },
);
