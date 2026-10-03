import { acceptConfirmation } from './ui-controls.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';
const password = integrationPassword();
const dataDir = scratchDir('redis-databases-smoke-');
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ args: ['.', isolatedProfile()], env });
let page, call, connectionId;
const key = `desktop:dbs:${Date.now()}`;
try {
  page = await desktop.firstWindow();
  page.setDefaultTimeout(20000);
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
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  connectionId = (
    await call('connection.save', {
      name: 'Redis databases',
      engine: 'redis',
      host: '127.0.0.1',
      port: 16379,
      database: '0',
      password,
      agentAccess: 'write',
    })
  ).id;
  for (const database of ['0', '12', '15'])
    await call('redis.set', { connectionId, database, key, value: `Value in DB ${database}` });
  await page.locator(`[data-connection-id="${connectionId}"]`).dblclick();
  await expect(page.locator('[data-redis-database]')).toHaveCount(16);
  const visible = page.locator('.redis-workspace:visible');
  const selectKey = async (database) => {
    await page.locator(`[data-redis-database="${database}"]`).click();
    await expect(visible.locator('.navigation-heading')).toHaveText(`Redis DB ${database}`);
    await visible.getByLabel('Key pattern').fill(key);
    await visible.getByRole('button', { name: 'Scan', exact: true }).click();
    await visible.getByRole('button', { name: key, exact: true }).click();
    await expect(visible.getByLabel('Redis value')).toHaveValue(`Value in DB ${database}`);
  };
  await selectKey('12');
  await visible.getByLabel('Redis value').fill('DB12 edited');
  await visible.getByRole('button', { name: 'Save value', exact: true }).click();
  await expect(visible.getByRole('button', { name: 'Save value', exact: true })).toBeEnabled();
  assert.deepEqual((await call('redis.get', { connectionId, database: '12', key })).items, [
    'DB12 edited',
  ]);
  await selectKey('0');
  await selectKey('15');
  await page.getByRole('button', { name: 'Refresh databases', exact: true }).click();
  await expect(page.locator('.redis-databases')).toHaveAttribute('aria-busy', 'false');
  const counts = await call('redis.databases', { connectionId });
  for (const db of counts.databases)
    await expect(
      page.locator(`[data-redis-database="${db.database}"] .redis-key-count`),
    ).toHaveText(String(db.keys));
  await page.locator('[data-redis-database="12"]').click();
  await expect(visible.getByLabel('Redis value')).toHaveValue('DB12 edited');
  assert.equal((await call('app.get_state')).tabs.filter((tab) => tab.type === 'redis').length, 3);
  await visible.getByRole('button', { name: 'Delete key', exact: true }).click();
  await acceptConfirmation(page);
  await expect(page.locator('[data-redis-database="12"] .redis-key-count')).toHaveText(
    String(counts.databases[12].keys - 1),
  );
  assert.deepEqual((await call('redis.get', { connectionId, database: '0', key })).items, [
    'Value in DB 0',
  ]);
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await mkdir('.local', { recursive: true });
  await captureDesktop(desktop, '.local/redis-databases.png');
  await call('connection.disconnect', { connectionId, discard: true });
  await expect(page.locator('[data-redis-database]')).toHaveCount(0);
  assert.equal((await call('app.get_state')).tabs.length, 0);
  console.log(
    JSON.stringify({
      success: true,
      verified: [
        '16 database rows and key counts',
        'DB0/12/15 key isolation',
        'DB12 UI edit and delete',
        'automatic count refresh',
        'per-database tabs reused',
        'disconnect clears explorer and all database tabs',
      ],
      screenshot: '.local/redis-databases.png',
    }),
  );
} finally {
  if (call && connectionId) {
    await call('connection.connect', { connectionId }).catch(() => {});
    for (const database of ['0', '12', '15'])
      await call('redis.delete', { connectionId, database, key }).catch(() => {});
  }
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
