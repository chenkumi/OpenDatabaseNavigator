import { _electron as electron, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { selectValue, acceptConfirmation } from './ui-controls.mjs';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';

const directory = scratchDir('database-generation-');
const file = join(directory, 'generation.sqlite');
const db = new DatabaseSync(file);
db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, qty INT); INSERT INTO items VALUES(1,5)');
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
  page.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.locator('.app-shell').waitFor();
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
    name: 'Generated SQLite',
    engine: 'sqlite',
    database: file,
  });
  const ref = { connectionId: connection.id, database: file, schema: 'main', table: 'items' };
  await page.locator(`.connection-main[data-connection-id="${connection.id}"]`).dblclick();
  await page.getByRole('button', { name: '▤ items', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Design table', exact: true }).click();
  const active = () => page.locator('.tab-content:visible');
  const editor = () => active().locator('.structure-editor');
  const apply = async () => {
    await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
    await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
    await editor().getByRole('status').filter({ hasText: 'Changes applied.' }).waitFor();
  };
  await editor().getByRole('tab', { name: 'Generated columns', exact: true }).click();
  await editor().getByRole('button', { name: 'Add generated column', exact: true }).click();
  await editor().getByLabel('Generated column name', { exact: true }).fill('total');
  await editor().getByLabel('Generation expression', { exact: true }).fill('qty * 2');
  await selectValue(page, editor().getByLabel('Generation storage', { exact: true }), 'stored');
  await expect
    .poll(async () =>
      (await call('app.get_state')).tabs.some(
        (tab) => tab.dirty && tab.sql.includes('generated-add'),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(editor().getByLabel('Generation expression', { exact: true })).toHaveValue(
    'qty * 2',
  );
  await apply();
  let detail = await call('structure.describe', ref);
  assert.equal(detail.columns.find((c) => c.name === 'total').generation.storage, 'stored');
  await editor().getByLabel('Generation expression', { exact: true }).fill('qty * 3');
  await selectValue(page, editor().getByLabel('Generation storage', { exact: true }), 'virtual');
  await apply();
  assert.equal(
    (await call('query.execute', { connectionId: connection.id, sql: 'SELECT total FROM items' }))
      .rows[0].total,
    '15',
  );
  await editor().getByLabel('Generation expression', { exact: true }).fill('missing_column + 1');
  await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(editor().getByRole('alert')).toBeVisible();
  await editor().getByRole('button', { name: 'Revert changes', exact: true }).click();
  await acceptConfirmation(page);
  await active().getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(active().getByLabel('qty row 1', { exact: true })).toBeVisible();
  await expect(active().getByLabel('total row 1', { exact: true })).toHaveCount(0);
  await expect(active().getByRole('cell', { name: /^15(?:\s|$)/ })).toBeVisible();
  await active().getByRole('tab', { name: 'Structure', exact: true }).click();
  await editor().getByRole('tab', { name: 'Generated columns', exact: true }).click();
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await expect(editor().getByLabel('產生運算式', { exact: true })).toHaveValue('qty * 3');
  await page.waitForTimeout(300);
  await captureDesktop(app, resolve('.local/generated-columns.png'));
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await editor().getByRole('button', { name: 'Drop column', exact: true }).click();
  await apply();
  assert.ok(!(await call('structure.describe', ref)).columns.some((c) => c.name === 'total'));
  await call('app.open_create_object', {
    connectionId: connection.id,
    database: file,
    schema: 'main',
    kind: 'table',
  });
  await active().getByLabel('Object name', { exact: true }).fill('created_generated');
  await active().getByRole('button', { name: 'Add column', exact: true }).click();
  await active().getByLabel('Column name 2', { exact: true }).fill('twice');
  await active().getByRole('checkbox', { name: 'Generated column 2', exact: true }).check();
  await active().getByLabel('Generation expression 2', { exact: true }).fill('id * 2');
  await expect(active().getByLabel('Default SQL 2', { exact: true })).toBeDisabled();
  await expect(
    active().getByRole('checkbox', { name: 'Primary key 2', exact: true }),
  ).toBeDisabled();
  await active().getByRole('button', { name: 'Preview SQL', exact: true }).click();
  await active().getByRole('button', { name: 'Create object', exact: true }).click();
  await active().getByRole('status').filter({ hasText: 'Object created.' }).waitFor();
  detail = await call('structure.describe', { ...ref, table: 'created_generated' });
  assert.equal(detail.columns.find((c) => c.name === 'twice').generation.expression, 'id * 2');
  console.log(
    'Generated column add/edit/drop, storage switch, draft restore, failed expression rollback, read-only data cells, table creation and Chinese UI passed.',
  );
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
