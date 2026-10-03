import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { selectValue, acceptConfirmation } from './ui-controls.mjs';
import { captureDesktop } from './capture-desktop.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';
const password = integrationPassword();
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: scratchDir('database-index-options-'),
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', isolatedProfile()], env });
let page,
  connectionId,
  created = false;
const table = 'dw_ui_ix_' + randomUUID().replaceAll('-', '').slice(0, 10),
  index = table + '_idx';
const call = async (name, args = {}) => {
  const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
    name,
    args,
  });
  assert.ok(result.success, result.error);
  return result.data;
};
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.locator('.app-shell').waitFor();
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  connectionId = (
    await call('connection.save', {
      name: 'Index Options MySQL',
      engine: 'mysql',
      host: '127.0.0.1',
      port: 13306,
      username: 'root',
      password,
      database: 'workspace',
    })
  ).id;
  await call('connection.connect', { connectionId });
  await call('query.execute', {
    connectionId,
    sql: `CREATE TABLE ${table}(id INT PRIMARY KEY,label VARCHAR(128))`,
  });
  created = true;
  await call('query.execute', {
    connectionId,
    sql: `INSERT INTO ${table} VALUES(1,'duplicate'),(2,'duplicate')`,
  });
  await call('app.open_create_object', {
    connectionId,
    database: 'workspace',
    schema: 'workspace',
    kind: 'index',
  });
  const active = () => page.locator('.tab-content:visible'),
    editor = () => active().locator('.database-object-view');
  await active().getByLabel('Object name', { exact: true }).fill(index);
  await selectValue(page, active().getByLabel('Target table / view', { exact: true }), table);
  await active().getByRole('checkbox', { name: 'label', exact: true }).check();
  await selectValue(page, active().getByLabel('Index type', { exact: true }), 'FULLTEXT');
  await expect(active().getByLabel('Index method', { exact: true })).toHaveCount(0);
  await active().getByLabel('Index comment', { exact: true }).fill('Fulltext comment');
  await active().getByRole('button', { name: 'Preview SQL', exact: true }).click();
  await expect(active().locator('.create-preview pre')).toContainText('CREATE FULLTEXT INDEX');
  await active().getByRole('button', { name: 'Create object', exact: true }).click();
  await active().getByRole('status').filter({ hasText: 'Object created.' }).waitFor();
  await active().getByRole('button', { name: 'Open created object', exact: true }).click();
  await editor().getByRole('tab', { name: 'Index options', exact: true }).click();
  await expect(editor().getByLabel('Index comment', { exact: true })).toHaveValue(
    'Fulltext comment',
  );
  await selectValue(page, editor().getByLabel('Index type', { exact: true }), 'NORMAL');
  await selectValue(page, editor().getByLabel('Index method', { exact: true }), 'BTREE');
  await editor().getByLabel('Index comment', { exact: true }).fill("索引 ' backslash \\ comment");
  await expect
    .poll(async () =>
      (await call('app.get_state')).tabs.some((t) => t.dirty && t.sql.includes('indexOptions')),
    )
    .toBe(true);
  await page.reload();
  await expect(editor().getByLabel('Index type', { exact: true })).toContainText('NORMAL');
  await editor().getByRole('tab', { name: 'Definition', exact: true }).click();
  await expect(editor().locator('.object-definition-editor')).toHaveAttribute('readonly', '');
  await editor().getByRole('tab', { name: 'Index options', exact: true }).click();
  const apply = async () => {
    await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
    await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
    await editor().getByRole('status').filter({ hasText: 'Changes applied.' }).waitFor();
  };
  await apply();
  const ref = {
    connectionId,
    database: 'workspace',
    schema: 'workspace',
    table,
    kind: 'index',
    objectName: index,
  };
  assert.equal((await call('object.describe', ref)).indexOptions.type, 'NORMAL');
  await selectValue(page, editor().getByLabel('Index type', { exact: true }), 'UNIQUE');
  await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(editor().getByRole('alert')).toBeVisible();
  assert.equal((await call('object.describe', ref)).indexOptions.type, 'NORMAL');
  await editor().getByRole('button', { name: 'Revert changes', exact: true }).click();
  await acceptConfirmation(page);
  await editor().getByLabel('Index comment', { exact: true }).fill('Updated index comment');
  await apply();
  await editor().getByRole('tab', { name: 'Definition', exact: true }).click();
  const sql = await editor().locator('.object-definition-editor').inputValue();
  await editor()
    .locator('.object-definition-editor')
    .fill(sql + '\n-- draft');
  await editor().getByRole('tab', { name: 'Index options', exact: true }).click();
  await expect(editor().getByLabel('Index type', { exact: true })).toBeDisabled();
  await editor().getByRole('button', { name: 'Revert changes', exact: true }).click();
  await acceptConfirmation(page);
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await expect(editor().getByLabel('索引註解', { exact: true })).toHaveValue(
    'Updated index comment',
  );
  await editor()
    .locator('.database-object-content')
    .evaluate((element) => {
      element.scrollTop = 0;
    });
  await page.waitForTimeout(300);
  await captureDesktop(app, resolve('.local/index-options.png'));
  console.log(
    'Index type/method/comment creation and editing, FULLTEXT conversion, failed UNIQUE preservation, draft restore, SQL locks and Chinese UI passed.',
  );
} finally {
  if (created)
    await call('query.execute', { connectionId, sql: `DROP TABLE ${table}` }).catch(() => {});
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
