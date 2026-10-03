import { dismissConfirmation, acceptConfirmation } from './ui-controls.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';
const dataDir = scratchDir('database-connections-');
const file = join(dataDir, 'lifecycle.sqlite');
const db = new DatabaseSync(file);
db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)');
db.close();
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const launch = async () => {
  app = await electron.launch({ args: ['.', isolatedProfile()], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.locator('.connection-list').waitFor();
};
const call = async (name, args = {}) => {
  const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
    name,
    args,
  });
  assert.ok(result.success, result.error);
  return result.data;
};
const stop = async () => {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.exit(0));
  await closed;
};
try {
  await launch();
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  const a = await call('connection.save', {
    name: 'Lifecycle A',
    engine: 'sqlite',
    database: file,
  });
  const b = await call('connection.save', {
    name: 'Lifecycle B',
    engine: 'sqlite',
    database: file,
  });
  await call('app.open_table', {
    connectionId: a.id,
    table: 'items',
    schema: 'main',
    database: file,
  });
  await stop();
  await launch();
  const card = (id) => page.locator(`.connection-main[data-connection-id="${id}"]`);
  await expect(card(a.id)).toHaveAttribute('data-state', 'disconnected');
  await expect(card(a.id)).toContainText('Double-click to connect');
  assert.equal((await call('connection.status', { connectionId: a.id })).connected, false);
  await expect(page.locator('.tab-content:visible')).toContainText('Double-click to connect');
  await card(a.id).click();
  assert.equal((await call('connection.status', { connectionId: a.id })).connected, false);
  await card(a.id).dblclick();
  await expect(card(a.id)).toHaveAttribute('data-state', 'connected');
  await expect(page.getByRole('button', { name: '▤ items', exact: true })).toBeVisible();
  await card(b.id).dblclick();
  await expect(card(b.id)).toHaveAttribute('data-state', 'connected');
  const other = await call('app.open_query', {
    connectionId: b.id,
    sql: 'SELECT 2',
    title: 'Other connection',
  });
  for (const type of ['query', 'index', 'trigger']) {
    if (type === 'query')
      await call('app.open_query', { connectionId: a.id, sql: 'SELECT 1', title: 'A query' });
    else
      await call('app.open_object', {
        connectionId: a.id,
        schema: 'main',
        table: 'items',
        objectName: 'missing',
        type,
      });
  }
  // A dirty tab prevents accidental loss; cancellation leaves the actual connection open.
  const dirty = (await call('app.get_state')).tabs.find((tab) => tab.title === 'A query');
  await call('workspace.update', { id: dirty.id, patch: { dirty: true } });
  const menu = () =>
    page.getByRole('button', { name: 'Connection actions for Lifecycle A', exact: true }).click();
  await menu();
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  await dismissConfirmation(page);
  await expect(card(a.id)).toHaveAttribute('data-state', 'connected');
  await menu();
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  await acceptConfirmation(page);
  await expect(card(a.id)).toHaveAttribute('data-state', 'disconnected');
  await expect(page.getByRole('button', { name: '▤ items', exact: true })).toHaveCount(0);
  assert.deepEqual(
    (await call('app.get_state')).tabs.map((tab) => tab.id),
    [other.id],
  );
  assert.equal((await call('connection.status', { connectionId: a.id })).connected, false);
  assert.equal((await call('connection.status', { connectionId: b.id })).connected, true);
  // A renderer reload cannot bring a disconnected connection back online.
  await page.reload();
  await expect(card(a.id)).toHaveAttribute('data-state', 'disconnected');
  await card(a.id).dblclick();
  await expect(card(a.id)).toHaveAttribute('data-state', 'connected');
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await captureDesktop(app, resolve('.local/connection-lifecycle.png'));
  console.log(
    JSON.stringify({
      success: true,
      verified: [
        'Cold startup and restored tabs stay offline',
        'Single click selects; double click connects',
        'Dirty disconnect can be cancelled',
        'Disconnect closes all related tab types only',
        'Explorer closes and other connection stays active',
        'Explicit reconnect after renderer reload',
      ],
    }),
  );
} finally {
  if (app) await stop().catch(() => {});
}
