import { acceptConfirmation } from './ui-controls.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';
const dataDir = scratchDir('database-object-tabs-');
const file = join(dataDir, 'objects.sqlite');
const db = new DatabaseSync(file);
db.exec(
  'CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); CREATE INDEX items_name_idx ON items(name); CREATE TRIGGER items_insert AFTER INSERT ON items BEGIN SELECT 1; END;',
);
db.close();
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', isolatedProfile()], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.getByRole('heading', { name: '探索資料，從這裡開始。' }).waitFor();
  const call = async (name, args = {}) => {
    const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
      name,
      args,
    });
    assert.ok(result.success, result.error);
    return result.data;
  };
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  const connection = await call('connection.save', {
    name: 'Objects SQLite',
    engine: 'sqlite',
    database: file,
  });
  await page.getByRole('button', { name: /Objects SQLite sqlite/ }).dblclick();
  await page.getByRole('button', { name: 'Index', exact: true }).click();
  await page.locator('.metadata-object').filter({ hasText: 'items_name_idx' }).dblclick();
  const editor = () =>
    page.locator('.tab-content:visible').getByLabel('SQL definition', { exact: true });
  const active = () => page.locator('.tab-content:visible');
  await expect(editor()).toHaveValue(/CREATE INDEX items_name_idx/);
  await editor().fill('CREATE INDEX items_name_idx ON items(name DESC) WHERE name IS NOT NULL');
  await active().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await expect(active().getByRole('region', { name: 'SQL preview' })).toContainText('DROP INDEX');
  await active().getByRole('button', { name: 'Apply changes', exact: true }).click();
  await active().getByRole('status').filter({ hasText: 'Changes applied.' }).waitFor();
  const indexRef = {
    connectionId: connection.id,
    database: file,
    schema: 'main',
    table: 'items',
    objectName: 'items_name_idx',
    kind: 'index',
  };
  assert.match((await call('object.describe', indexRef)).editableSql, /name DESC/);
  await page.getByRole('button', { name: 'Trigger', exact: true }).click();
  await page.locator('.metadata-object').filter({ hasText: 'items_insert' }).dblclick();
  await expect(editor()).toHaveValue(/CREATE TRIGGER items_insert/);
  const triggerDraft =
    "CREATE TRIGGER items_insert AFTER INSERT ON items BEGIN UPDATE items SET name='edited' WHERE id=NEW.id; SELECT 2; END";
  await editor().fill(triggerDraft);
  // Unapplied drafts and their baseline version survive renderer restoration.
  await expect(page.locator('.tab').last()).toContainText('•');
  await page.reload();
  await expect(editor()).toHaveValue(triggerDraft);
  await active().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await active().getByRole('button', { name: 'Apply changes', exact: true }).click();
  await active().getByRole('status').filter({ hasText: 'Changes applied.' }).waitFor();
  await call('query.execute', {
    connectionId: connection.id,
    sql: "INSERT INTO items(id,name) VALUES(1,'before')",
  });
  assert.equal(
    (
      await call('query.read', {
        connectionId: connection.id,
        sql: 'SELECT name FROM items WHERE id=1',
      })
    ).rows[0].name,
    'edited',
  );
  // Invalid replacement rolls back and keeps the draft available for correction.
  await editor().fill(triggerDraft.replace('SELECT 2', 'INVALID SQL'));
  await active().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await active().getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(active().getByRole('alert')).toBeVisible();
  await expect(editor()).toHaveValue(/INVALID SQL/);
  await active().getByRole('button', { name: 'Revert changes', exact: true }).click();
  await acceptConfirmation(page);
  await expect(editor()).toHaveValue(/SELECT 2/);
  assert.equal(
    await page.locator('.database-tree pre, .database-tree details.metadata-object').count(),
    0,
  );
  let state = await call('app.get_state');
  assert.deepEqual(
    state.tabs.map((tab) => tab.type),
    ['index', 'trigger'],
  );
  assert.ok(
    state.tabs.every(
      (tab) => tab.database === file && tab.schema === 'main' && tab.table === 'items',
    ),
  );
  await page.locator('.tab').first().locator('button').first().click();
  await expect(editor()).toHaveValue(/CREATE INDEX/);
  await captureDesktop(app, resolve('.local/database-object-tabs.png'));
  await page.reload();
  await expect(editor()).toHaveValue(/CREATE INDEX/);
  await page.locator('.tab').last().locator('button').first().click();
  await expect(editor()).toHaveValue(/CREATE TRIGGER/);
  await call('query.execute', { connectionId: connection.id, sql: 'DROP TRIGGER items_insert' });
  await page
    .locator('.tab-content:visible')
    .getByRole('button', { name: 'Refresh', exact: true })
    .click();
  await page.getByRole('alert').filter({ hasText: 'Object no longer exists' }).waitFor();
  await page.getByRole('button', { name: 'Close items_insert', exact: true }).click();
  state = await call('app.get_state');
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].type, 'index');
  console.log(
    JSON.stringify(
      {
        success: true,
        verified: [
          'Index and Trigger open in tabs',
          'no inline tree definitions',
          'scope and tab restoration',
          'refresh handles deleted objects',
          'tab switching and close',
          'edit, preview and apply Index/Trigger',
          'trigger execution changes data',
          'draft restoration and invalid-edit rollback',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
