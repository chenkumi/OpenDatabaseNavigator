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
  DATABASE_WORKSPACE_DATA_DIR: scratchDir('database-properties-'),
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', isolatedProfile()], env });
let page,
  connectionId,
  created = false;
const table = 'dw_ui_props_' + randomUUID().replaceAll('-', '').slice(0, 12);
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
      name: 'Properties MySQL',
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
    sql: `CREATE TABLE ${table}(id INT PRIMARY KEY,label VARCHAR(40) NOT NULL DEFAULT 'guest') DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
  });
  created = true;
  await page.locator(`.connection-main[data-connection-id="${connectionId}"]`).dblclick();
  await page.getByRole('button', { name: `▤ ${table}`, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Design table', exact: true }).click();
  const editor = () => page.locator('.tab-content:visible .structure-editor');
  const ref = { connectionId, database: 'workspace', schema: 'workspace', table };
  const apply = async () => {
    await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
    await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
    await editor().getByRole('status').filter({ hasText: 'Changes applied.' }).waitFor();
  };
  await editor().getByRole('tab', { name: 'Column options', exact: true }).click();
  await selectValue(page, editor().getByLabel('Property column', { exact: true }), 'label');
  await expect(editor().getByLabel('Comment', { exact: true })).toBeEnabled();
  await editor().getByLabel('Comment', { exact: true }).fill("欄位's 註解");
  await editor().getByRole('checkbox', { name: 'Binary comparison', exact: true }).check();
  await expect
    .poll(async () =>
      (await call('app.get_state')).tabs.some(
        (tab) => tab.dirty && tab.sql.includes('column-properties'),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(editor().getByRole('tab', { name: 'Column options', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(editor().getByLabel('Comment', { exact: true })).toHaveValue("欄位's 註解");
  await expect(editor().getByLabel('Collation', { exact: true })).toContainText('utf8mb4_bin');
  await apply();
  let detail = await call('structure.describe', ref);
  assert.equal(detail.columns[1].properties.comment, "欄位's 註解");
  assert.equal(detail.columns[1].properties.collation, 'utf8mb4_bin');
  assert.match(detail.columns[1].defaultSql, /guest/);
  await editor().getByRole('tab', { name: 'Table options', exact: true }).click();
  await editor().getByLabel('Comment', { exact: true }).fill('資料表註解');
  await selectValue(page, editor().getByLabel('Character set', { exact: true }), 'latin1');
  await selectValue(page, editor().getByLabel('Collation', { exact: true }), 'latin1_bin');
  await apply();
  detail = await call('structure.describe', ref);
  assert.equal(detail.properties.comment, '資料表註解');
  assert.equal(detail.properties.collation, 'latin1_bin');
  assert.equal(detail.columns[1].properties.collation, 'utf8mb4_bin');
  await editor().getByLabel('Comment', { exact: true }).fill('discard');
  await editor().getByRole('button', { name: 'Revert changes', exact: true }).click();
  await acceptConfirmation(page);
  await expect(editor().getByLabel('Comment', { exact: true })).toHaveValue('資料表註解');
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await expect(editor().getByRole('tab', { name: '資料表選項', exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await captureDesktop(app, resolve('.local/structure-properties.png'));
  console.log(
    'Property tabs, character set/collation choices, binary toggle, comments, persistent drafts, preview/apply, discard and Chinese labels passed.',
  );
} finally {
  try {
    if (created) await call('query.execute', { connectionId, sql: `DROP TABLE ${table}` });
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}
