import { _electron as electron, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { scratchDir, isolatedProfile } from './support.mjs';

const directory = scratchDir('rename-objects-');
const database = join(directory, 'rename.sqlite');
const db = new DatabaseSync(database);
db.exec(
  "CREATE TABLE items(id INTEGER PRIMARY KEY, note TEXT); INSERT INTO items VALUES(1,'kept'); CREATE INDEX ix_old ON items(note); CREATE TRIGGER tr_old AFTER INSERT ON items BEGIN SELECT 1; END; CREATE VIEW v_old AS SELECT * FROM items;",
);
db.close();
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: directory,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', isolatedProfile()], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => console.error(error.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.getByRole('heading', { name: '探索資料，從這裡開始。' }).waitFor();
  const call = async (name, args = {}) => {
    const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
      name,
      args,
    });
    assert.ok(result.success, `${name}: ${result.error}`);
    return result.data;
  };
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  const connection = await call('connection.save', {
    engine: 'sqlite',
    name: 'Rename SQLite',
    database,
  });
  await page.locator(`[data-connection-id="${connection.id}"]`).dblclick();
  const scope = { connectionId: connection.id, database, schema: 'main' };
  const tableTab = await call('app.open_table', { ...scope, table: 'items' });
  await call('app.open_table', { ...scope, table: 'v_old' });
  const indexTab = await call('app.open_object', {
    ...scope,
    table: 'items',
    type: 'index',
    objectName: 'ix_old',
  });
  await expect(
    page.locator('.tab-content:visible').getByLabel('SQL definition', { exact: true }),
  ).toHaveValue(/CREATE INDEX/);
  await call('workspace.update', { id: indexTab.id, patch: { dirty: true } });
  const search = page.getByLabel('Search tables…', { exact: true });
  const openRename = async (kind, name) => {
    await search.fill(name);
    await page.getByRole('button', { name: `Object actions for ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: `Rename ${kind}`, exact: true }).click();
    return page.getByRole('dialog', { name: `Rename ${kind}`, exact: true });
  };
  let dialog = await openRename('index', 'ix_old');
  await dialog.getByLabel('New name', { exact: true }).fill('ix_new');
  await dialog.getByRole('button', { name: 'Preview SQL', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Unsaved changes');
  await expect(dialog.getByRole('button', { name: 'Rename object', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await call('workspace.update', { id: indexTab.id, patch: { dirty: false } });
  await call('app.open_object', {
    ...scope,
    table: 'items',
    type: 'trigger',
    objectName: 'tr_old',
  });
  await expect(
    page.locator('.tab-content:visible').getByLabel('SQL definition', { exact: true }),
  ).toHaveValue(/CREATE TRIGGER/);
  for (const [kind, old, name] of [
    ['index', 'ix_old', 'ix_new'],
    ['trigger', 'tr_old', 'tr_new'],
    ['view', 'v_old', 'v_new'],
    ['table', 'items', 'renamed_items'],
  ]) {
    dialog = await openRename(kind, old);
    if (kind === 'table') {
      await dialog.getByLabel('New name', { exact: true }).fill('v_new');
      await dialog.getByRole('button', { name: 'Preview SQL', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('already exists');
    }
    await dialog.getByLabel('New name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Preview SQL', exact: true }).click();
    await expect(dialog.locator('pre')).toContainText(name);
    if (kind === 'table') {
      await mkdir('.local', { recursive: true });
      await page.screenshot({ path: resolve('.local/rename-object.png') });
    }
    await dialog.getByRole('button', { name: 'Rename object', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await search.fill(name);
    await expect(
      page.getByRole('button', { name: `Object actions for ${name}`, exact: true }),
    ).toBeVisible();
    const state = await call('app.get_state');
    assert.ok(
      state.tabs.some((tab) =>
        kind === 'index' || kind === 'trigger' ? tab.objectName === name : tab.table === name,
      ),
    );
  }
  const state = await call('app.get_state');
  assert.ok(!state.tabs.some((tab) => tab.id === tableTab.id));
  assert.equal(state.tabs.find((tab) => tab.objectName === 'tr_new').table, 'renamed_items');
  assert.equal(
    (
      await call('query.execute', {
        connectionId: connection.id,
        database,
        sql: 'SELECT note FROM renamed_items',
        showInApp: false,
      })
    ).rows[0].note,
    'kept',
  );
  await page.reload();
  await expect
    .poll(async () =>
      (await call('app.get_state')).tabs.some((tab) => tab.table === 'renamed_items'),
    )
    .toBe(true);
  console.log(
    'Rename desktop smoke passed: four menus, preview, dirty protection, collision recovery, tree/tab updates, rows retained and reload persistence.',
  );
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
