import { selectValue, acceptConfirmation } from './ui-controls.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';
const password = integrationPassword();
const dataDir = scratchDir('redis-types-smoke-');
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ args: ['.', isolatedProfile()], env });
const prefix = `desktop:types:${Date.now()}:`;
let call, connectionId;
const types = ['string', 'list', 'set', 'zset', 'hash', 'stream', 'json'];
try {
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setBackgroundThrottling(false);
  });
  await page.getByRole('heading', { name: '探索資料，從這裡開始。' }).waitFor();
  call = async (name, args = {}) => {
    const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
      name,
      args,
    });
    assert.ok(result.success, `${name}: ${result.error}`);
    return result.data;
  };
  await call('settings.save', { ...(await call('settings.get')), language: 'en', pageSize: 100 });
  connectionId = (
    await call('connection.save', {
      name: 'Redis seven types',
      engine: 'redis',
      host: '127.0.0.1',
      port: 16380,
      database: '12',
      password,
      agentAccess: 'write',
    })
  ).id;
  const ref = { connectionId, database: '12' };
  for (const [operation, type, args] of [
    ['set', 'string', { value: 'hello string' }],
    ['rpush', 'list', { value: 'hello list' }],
    ['sadd', 'set', { member: 'hello set' }],
    ['zadd', 'zset', { member: 'hello zset', score: 5 }],
    ['hset', 'hash', { field: 'message', value: 'hello hash' }],
    ['json_set', 'json', { value: '{"hello":"JSON","nested":[true,null,1]}' }],
  ])
    await call('redis.' + operation, { ...ref, key: prefix + type, ...args });
  for (let i = 1; i <= 3; i++)
    await call('redis.xadd', {
      ...ref,
      key: prefix + 'stream',
      id: `${i}-0`,
      fields: [
        ['level', 'info'],
        ['message', `message ${i}`],
        ['metadata', '{"source":"desktop"}'],
      ],
    });
  await call('redis.expire', { ...ref, key: prefix + 'string', ttl: 120 });
  await call('redis.expire', { ...ref, key: prefix + 'json', ttl: 120 });
  await page.locator(`[data-connection-id="${connectionId}"]`).dblclick();
  const view = page.locator('.redis-workspace:visible');
  await view.getByLabel('Key pattern').fill(prefix + '*');
  await view.getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(view.locator('.key-list button')).toHaveCount(7);
  const open = async (type) => {
    await view.getByRole('button', { name: prefix + type, exact: true }).click();
    await expect(view.locator('.redis-value .badge')).toHaveText(type);
  };
  for (const type of types.slice(0, 5)) {
    await open(type);
    if (type === 'string') {
      await expect(view.getByLabel('Redis value')).toHaveValue('hello string');
      assert.ok(Number(await view.getByLabel('TTL seconds').inputValue()) > 0);
      await view.getByLabel('Redis value').fill('edited string');
      await view.getByRole('button', { name: 'Save value', exact: true }).click();
      await expect(view).toHaveAttribute('aria-busy', 'false');
      assert.ok((await call('redis.ttl', { ...ref, key: prefix + type })).ttl > 0);
    } else await view.getByRole('cell', { name: `hello ${type}`, exact: true }).waitFor();
  }
  await call('settings.save', { ...(await call('settings.get')), pageSize: 2 });
  await open('stream');
  const stream = view.getByRole('table', { name: 'Stream entries' });
  await expect(stream.getByRole('row')).toHaveCount(3);
  await stream.getByRole('cell', { name: '1-0', exact: true }).waitFor();
  await view.getByRole('button', { name: 'Next values →', exact: true }).click();
  await stream.getByRole('cell', { name: '3-0', exact: true }).waitFor();
  await expect(view.getByRole('button', { name: 'Next values →', exact: true })).toBeDisabled();
  await stream.getByRole('button', { name: 'Remove', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Continue', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await call('redis.get', { ...ref, key: prefix + 'stream', limit: 10 })).items.length,
    )
    .toBe(2);
  await view.getByLabel('Redis value').fill('{"level":"warn","message":"added in desktop"}');
  await view.getByRole('button', { name: 'Append entry', exact: true }).click();
  await expect(view).toHaveAttribute('aria-busy', 'false');
  assert.equal(
    (await call('redis.get', { ...ref, key: prefix + 'stream', limit: 10 })).items.length,
    3,
  );
  await call('settings.save', { ...(await call('settings.get')), pageSize: 100 });
  // Saving rescans keys using the current small page size, so refresh the full key list.
  await view.getByRole('button', { name: 'Scan', exact: true }).click();
  await open('json');
  assert.equal(JSON.parse(await view.getByLabel('Redis value').inputValue()).hello, 'JSON');
  await view.getByLabel('Redis value').fill('{"updated":[1,2],"message":"中文"}');
  await view.getByRole('button', { name: 'Save value', exact: true }).click();
  await expect(view).toHaveAttribute('aria-busy', 'false');
  const saved = await call('redis.get', { ...ref, key: prefix + 'json' });
  assert.equal(saved.type, 'json');
  assert.equal(JSON.parse(saved.items[0]).message, '中文');
  assert.ok(saved.ttl > 0);
  await view.getByRole('button', { name: '＋ New key', exact: true }).click();
  await view.getByLabel('Redis type').click();
  await expect(page.getByRole('option')).toHaveText(types);
  await page.keyboard.press('Escape');
  await selectValue(page, view.getByLabel('Redis type'), 'stream');
  await view.getByLabel('New key name').fill(prefix + 'new-stream');
  await view.getByLabel('Redis value').fill('[["duplicate","one"],["duplicate","two"]]');
  await view.getByRole('button', { name: 'Append entry', exact: true }).click();
  await expect(view.locator('.redis-value .badge')).toHaveText('stream');
  const created = await call('redis.get', { ...ref, key: prefix + 'new-stream' });
  assert.deepEqual(created.items[0].fields, [
    ['duplicate', 'one'],
    ['duplicate', 'two'],
  ]);
  await view.getByRole('button', { name: '＋ New key', exact: true }).click();
  await selectValue(page, view.getByLabel('Redis type'), 'json');
  await view.getByLabel('New key name').fill(prefix + 'new-json');
  await view.getByLabel('Redis value').fill('[true,null,{"created":"desktop"}]');
  await view.getByRole('button', { name: 'Save value', exact: true }).click();
  await expect(view.locator('.redis-value .badge')).toHaveText('json');
  assert.deepEqual(
    JSON.parse((await call('redis.get', { ...ref, key: prefix + 'new-json' })).items[0]),
    [true, null, { created: 'desktop' }],
  );
  await open('stream');
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await mkdir('.local', { recursive: true });
  await captureDesktop(desktop, '.local/redis-stream.png');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      success: true,
      verified: [
        'seven types open',
        'stream field grid and pagination',
        'stream append and entry deletion',
        'create native stream and JSON',
        'JSON document edit',
        'existing TTL preserved',
      ],
      screenshot: '.local/redis-stream.png',
    }),
  );
} finally {
  if (call && connectionId)
    for (const type of [...types, 'new-stream', 'new-json'])
      await call('redis.delete', { connectionId, database: '12', key: prefix + type }).catch(
        () => {},
      );
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
