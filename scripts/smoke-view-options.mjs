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
  DATABASE_WORKSPACE_DATA_DIR: scratchDir('database-view-options-'),
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', isolatedProfile()], env });
let page,
  connectionId,
  tableCreated = false,
  viewCreated = false;
const stem = 'dw_ui_view_' + randomUUID().replaceAll('-', '').slice(0, 10),
  table = stem + '_t',
  view = stem + '_v';
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
      name: 'View Options MySQL',
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
    sql: `CREATE TABLE ${table}(id INT PRIMARY KEY,qty INT)`,
  });
  tableCreated = true;
  const ref = { connectionId, database: 'workspace', schema: 'workspace', table: view };
  await call('app.open_create_object', {
    connectionId,
    database: 'workspace',
    schema: 'workspace',
    kind: 'view',
  });
  const active = () => page.locator('.tab-content:visible');
  await active().getByLabel('Object name', { exact: true }).fill(view);
  await active()
    .getByLabel('SELECT query', { exact: true })
    .fill(`SELECT id,qty FROM ${table} WHERE qty > 0`);
  await active().getByRole('tab', { name: 'Advanced', exact: true }).click();
  await selectValue(page, active().getByLabel('View algorithm', { exact: true }), 'MERGE');
  await selectValue(page, active().getByLabel('View security', { exact: true }), 'INVOKER');
  await selectValue(page, active().getByLabel('Check option', { exact: true }), 'CASCADED');
  await active()
    .getByRole('checkbox', { name: 'Use current account as definer', exact: true })
    .uncheck();
  await expect(active().getByLabel('Definer user', { exact: true })).toHaveValue('root');
  await active().getByRole('button', { name: 'Preview SQL', exact: true }).click();
  await expect(active().locator('.create-preview pre')).toContainText('SQL SECURITY INVOKER');
  await active().getByRole('button', { name: 'Create object', exact: true }).click();
  await active().getByRole('status').filter({ hasText: 'Object created.' }).waitFor();
  viewCreated = true;
  await active().getByRole('button', { name: 'Open created object', exact: true }).click();
  await active().getByRole('tab', { name: 'Structure', exact: true }).click();
  const editor = () => active().locator('.structure-editor');
  await editor().getByRole('tab', { name: 'Definition', exact: true }).click();
  const definitionTop = (await editor().locator('.object-definition-editor').boundingBox()).y;
  await editor().getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(editor().getByLabel('View algorithm', { exact: true })).toContainText('MERGE');
  await selectValue(page, editor().getByLabel('Check option', { exact: true }), 'NONE');
  await editor().getByRole('tab', { name: 'Definition', exact: true }).click();
  assert.ok(
    Math.abs(
      (await editor().locator('.object-definition-editor').boundingBox()).y - definitionTop,
    ) < 1,
    'Pending options must not shift the editor.',
  );
  await expect(editor().locator('.object-definition-editor')).toHaveAttribute('readonly', '');
  await expect
    .poll(async () =>
      (await call('app.get_state')).tabs.some((t) => t.dirty && t.sql.includes('view-options')),
    )
    .toBe(true);
  await page.reload();
  await expect(editor().getByLabel('Check option', { exact: true })).toContainText('NONE');
  const apply = async () => {
    await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
    await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
    await editor().getByRole('status').filter({ hasText: 'Changes applied.' }).waitFor();
  };
  await apply();
  assert.equal((await call('structure.describe', ref)).viewOptions.checkOption, 'NONE');
  await selectValue(page, editor().getByLabel('View algorithm', { exact: true }), 'TEMPTABLE');
  await selectValue(page, editor().getByLabel('Check option', { exact: true }), 'LOCAL');
  await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await expect(editor().getByRole('alert')).toContainText(
    'TEMPTABLE views cannot use CHECK OPTION.',
  );
  await editor().getByRole('button', { name: 'Revert changes', exact: true }).click();
  await acceptConfirmation(page);
  await selectValue(page, editor().getByLabel('View security', { exact: true }), 'DEFINER');
  await selectValue(page, editor().getByLabel('Check option', { exact: true }), 'LOCAL');
  await apply();
  assert.equal((await call('structure.describe', ref)).viewOptions.security, 'DEFINER');
  // SQL editing locks options until reverted, so drafts cannot silently overwrite each other.
  await editor().getByRole('tab', { name: 'Definition', exact: true }).click();
  const sql = await editor().locator('.object-definition-editor').inputValue();
  await editor()
    .locator('.object-definition-editor')
    .fill(sql + '\n-- draft');
  await editor().getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(editor().getByLabel('View algorithm', { exact: true })).toBeDisabled();
  await editor().getByRole('button', { name: 'Revert changes', exact: true }).click();
  await acceptConfirmation(page);
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await expect(editor().getByLabel('檢查選項', { exact: true })).toContainText('LOCAL');
  await editor().evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await captureDesktop(app, resolve('.local/view-options.png'));
  console.log(
    'View create/edit options, definer, validation, draft restore, SQL conflict protection and Chinese UI passed.',
  );
} finally {
  if (connectionId) {
    if (viewCreated)
      await call('query.execute', { connectionId, sql: `DROP VIEW ${view}` }).catch(() => {});
    if (tableCreated)
      await call('query.execute', { connectionId, sql: `DROP TABLE ${table}` }).catch(() => {});
  }
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
