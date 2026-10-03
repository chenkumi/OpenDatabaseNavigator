import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClient, RESP_TYPES } from 'redis';
import { RedisTextCodec } from '../src/main/database/adapters/redis/text-codec';
import { RedisAdapter } from '../src/main/database/adapters/redis/redis-adapter';
import { connectionSchema } from '../src/shared/schemas';
import { REDIS_ENCODINGS } from '../src/shared/client-encodings';

const vectors = [
  ['utf8', '\uFEFF中文😀', 'efbbbfe4b8ade69687f09f9880'],
  ['latin1', 'café', '636166e9'],
  ['windows1252', '€café', '80636166e9'],
  ['big5', '許中文', 'b35ca4a4a4e5'],
  ['gbk', '中文', 'd6d0cec4'],
  ['gb18030', '中文😀', 'd6d0cec49439fc36'],
  ['shiftjis', 'ソ日本', '835c93fa967b'],
  ['eucjp', '日本', 'c6fccbdc'],
];

it.each(vectors)('encodes and decodes exact %s Redis bytes', (charset, text, hex) => {
  const codec = new RedisTextCodec(charset);
  expect(codec.arguments('SET', ['key', text])[2]).toEqual(Buffer.from(hex, 'hex'));
  expect(codec.reply('GET', Buffer.from(hex, 'hex'))).toBe(text);
  expect(
    codec.reply('XRANGE', [['1-0', [Buffer.from(hex, 'hex'), Buffer.from(hex, 'hex')]]]),
  ).toEqual([['1-0', [text, text]]]);
  expect(() => codec.arguments('SET', ['key', '\uD800'])).toThrow('losslessly');
});
it('validates Redis encodings, preserves BOMs and separates JSON UTF-8 from key encoding', async () => {
  expect(vectors.map((item) => item[0])).toEqual(REDIS_ENCODINGS.map((item) => item.value));
  for (const { value } of REDIS_ENCODINGS)
    expect(
      connectionSchema.safeParse({ engine: 'redis', name: 'codec', charset: value }).success,
    ).toBe(true);
  for (const charset of ['utf16', 'utf8mb4', 'base64', 'unknown'])
    expect(connectionSchema.safeParse({ engine: 'redis', name: 'codec', charset }).success).toBe(
      false,
    );
  const codec = new RedisTextCodec('latin1');
  expect(codec.arguments('JSON.SET', ['café', '.', '"中文😀"'])).toEqual([
    'JSON.SET',
    Buffer.from('636166e9', 'hex'),
    Buffer.from('.'),
    Buffer.from('"中文😀"'),
  ]);
  expect(codec.reply('JSON.GET', Buffer.from('"中文😀"'))).toBe('"中文😀"');
  expect(codec.reply('INFO', Buffer.from('中文'))).toBe('中文');
  expect(() => new RedisTextCodec().reply('GET', Buffer.from([0xff]))).toThrow('losslessly');
  const adapter = new RedisAdapter({
    ...connectionSchema.parse({
      engine: 'redis',
      name: 'never send',
      host: '127.0.0.1',
      port: 1,
      database: '0',
      charset: 'latin1',
    }),
    id: randomUUID(),
  });
  await expect(adapter.command('SET', ['key', '中文'])).rejects.toThrow('cannot be represented');
});
it('escapes glob syntax bytes inside multibyte characters without escaping user wildcards', () => {
  expect(
    new RedisTextCodec('big5').arguments('SCAN', ['0', 'MATCH', '*許*', 'COUNT', '10'])[3],
  ).toEqual(Buffer.from('2ab35c5c2a', 'hex'));
  expect(new RedisTextCodec('shiftjis').arguments('SCAN', ['0', 'MATCH', '*ソ*'])[3]).toEqual(
    Buffer.from('2a835c5c2a', 'hex'),
  );
});

it.skipIf(process.env.DB_INTEGRATION !== '1').each(vectors)(
  'Redis %s keys and six data types roundtrip against exact server bytes',
  async (charset, text, hex) => {
    const prefix = 'dw:charset:' + randomUUID() + ':';
    const key = prefix + text;
    const rawKey = Buffer.concat([Buffer.from(prefix), Buffer.from(hex, 'hex')]);
    const suffixes = ['', ':hash', ':list', ':set', ':zset', ':stream'];
    const rawKeys = suffixes.map((suffix) => Buffer.concat([rawKey, Buffer.from(suffix)]));
    const connection = {
      ...connectionSchema.parse({
        engine: 'redis',
        name: charset,
        host: '127.0.0.1',
        port: 16379,
        database: '4',
        charset,
        readTimeout: 2000,
        writeTimeout: 2000,
      }),
      id: randomUUID(),
    };
    const adapter = new RedisAdapter(connection, process.env.DB_TEST_PASSWORD);
    const admin = createClient({
      socket: { host: '127.0.0.1', port: 16379, reconnectStrategy: false },
      password: process.env.DB_TEST_PASSWORD,
      database: 4,
    });
    admin.on('error', () => {});
    const raw = (args: (string | Buffer)[]) =>
      admin.sendCommand(args, { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } });
    try {
      await admin.connect();
      await adapter.command('SET', [key, text]);
      expect(await raw(['GET', rawKey])).toEqual(Buffer.from(hex, 'hex'));
      expect(await adapter.command('GETRANGE', [key, '0', '-1'])).toBe(text);
      await expect(adapter.command('SET', [key, '\uD800'])).rejects.toThrow('losslessly');
      expect(await raw(['GET', rawKey])).toEqual(Buffer.from(hex, 'hex'));
      await adapter.command('HSET', [key + ':hash', text, text]);
      expect((await adapter.command('HSCAN', [key + ':hash', '0']))[1]).toEqual([text, text]);
      await adapter.command('RPUSH', [key + ':list', text]);
      expect(await adapter.command('LRANGE', [key + ':list', '0', '-1'])).toEqual([text]);
      await adapter.command('SADD', [key + ':set', text]);
      expect((await adapter.command('SSCAN', [key + ':set', '0']))[1]).toEqual([text]);
      await adapter.command('ZADD', [key + ':zset', '1.25', text]);
      expect(await adapter.command('ZRANGE', [key + ':zset', '0', '-1', 'WITHSCORES'])).toEqual([
        text,
        '1.25',
      ]);
      const id = await adapter.command('XADD', [key + ':stream', '*', text, text]);
      expect(await adapter.command('XRANGE', [key + ':stream', '-', '+'])).toEqual([
        [id, [text, text]],
      ]);
      let cursor = '0';
      const found: string[] = [];
      do {
        const page = await adapter.command('SCAN', [cursor, 'MATCH', key + '*', 'COUNT', '100']);
        cursor = page[0];
        found.push(...page[1]);
      } while (cursor !== '0');
      expect(found.sort()).toEqual(suffixes.map((suffix) => key + suffix).sort());
    } finally {
      await adapter.disconnect();
      if (admin.isReady) await raw(['DEL', ...rawKeys]);
      if (admin.isOpen) admin.destroy();
    }
  },
  15000,
);

it.skipIf(process.env.DB_INTEGRATION !== '1')(
  'Redis JSON stays UTF-8 under a Latin-1 key',
  async () => {
    const key = 'dw:charset:json:' + randomUUID() + ':café';
    const rawKey = Buffer.concat([Buffer.from(key.slice(0, -1)), Buffer.from([0xe9])]);
    const adapter = new RedisAdapter(
      {
        ...connectionSchema.parse({
          engine: 'redis',
          name: 'JSON charset',
          host: '127.0.0.1',
          port: 16380,
          database: '4',
          charset: 'latin1',
        }),
        id: randomUUID(),
      },
      process.env.DB_TEST_PASSWORD,
    );
    const admin = createClient({
      socket: { host: '127.0.0.1', port: 16380, reconnectStrategy: false },
      password: process.env.DB_TEST_PASSWORD,
      database: 4,
    });
    admin.on('error', () => {});
    try {
      await admin.connect();
      const document = { 中文: '😀' };
      await adapter.command('JSON.SET', [key, '.', JSON.stringify(document)]);
      expect(JSON.parse(await adapter.command('JSON.GET', [key, '.']))).toEqual(document);
      expect(JSON.parse((await admin.sendCommand(['JSON.GET', rawKey, '.'])) as string)).toEqual(
        document,
      );
    } finally {
      await adapter.disconnect();
      if (admin.isReady) await admin.sendCommand(['DEL', rawKey]);
      if (admin.isOpen) admin.destroy();
    }
  },
);
