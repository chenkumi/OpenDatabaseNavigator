import { _electron as electron, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { selectValue, acceptConfirmation } from './ui-controls.mjs';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';

const directory = scratchDir('database-constraints-');
const file = join(directory, 'constraints.sqlite');
const db = new DatabaseSync(file);
db.exec(
  'CREATE TABLE parent(a INT,b INT,PRIMARY KEY(a,b)); CREATE TABLE child(id INTEGER PRIMARY KEY, a INT, b INT, score INT); INSERT INTO parent VALUES(1,2); INSERT INTO child VALUES(1,1,2,5)',
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
    name: 'Constraints SQLite',
    engine: 'sqlite',
    database: file,
  });
  const ref = { connectionId: connection.id, database: file, schema: 'main', table: 'child' };
  await page.locator(`.connection-main[data-connection-id="${connection.id}"]`).dblclick();
  await page.getByRole('button', { name: '▤ child', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Design table', exact: true }).click();
  const editor = () => page.locator('.tab-content:visible .structure-editor');
  const apply = async () => {
    await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
    await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
    await editor().getByRole('status').filter({ hasText: 'Changes applied.' }).waitFor();
  };
  await editor().getByRole('tab', { name: 'Foreign keys', exact: true }).click();
  await editor().getByRole('button', { name: 'Add constraint', exact: true }).click();
  await editor().getByLabel('Constraint name', { exact: true }).fill('child_parent');
  await selectValue(page, editor().getByLabel('Referenced table', { exact: true }), 'parent');
  await selectValue(page, editor().getByLabel('Local column 1', { exact: true }), 'a');
  await selectValue(page, editor().getByLabel('Referenced column 1', { exact: true }), 'a');
  await editor().getByRole('button', { name: 'Add column pair', exact: true }).click();
  await selectValue(page, editor().getByLabel('Local column 2', { exact: true }), 'b');
  await selectValue(page, editor().getByLabel('Referenced column 2', { exact: true }), 'b');
  await selectValue(page, editor().getByLabel('On delete', { exact: true }), 'SET NULL');
  await selectValue(page, editor().getByLabel('On update', { exact: true }), 'CASCADE');
  await expect
    .poll(async () =>
      (await call('app.get_state')).tabs.some(
        (tab) => tab.dirty && tab.sql.includes('child_parent'),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(editor().getByRole('tab', { name: 'Foreign keys', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(editor().getByLabel('Constraint name', { exact: true })).toHaveValue('child_parent');
  await apply();
  let detail = await call('structure.describe', ref);
  assert.deepEqual(detail.constraints[0].definition.columns, ['a', 'b']);
  assert.equal(detail.constraints[0].definition.onDelete, 'SET NULL');
  await selectValue(page, editor().getByLabel('On delete', { exact: true }), 'CASCADE');
  await apply();
  await editor().getByRole('button', { name: 'Drop constraint', exact: true }).click();
  await apply();
  assert.equal((await call('structure.describe', ref)).constraints.length, 0);
  await editor().getByRole('tab', { name: 'Checks', exact: true }).click();
  await editor().getByRole('button', { name: 'Add constraint', exact: true }).click();
  await editor().getByLabel('Constraint name', { exact: true }).fill('score_positive');
  await editor().getByLabel('Check expression', { exact: true }).fill('score >= 0');
  await expect(
    editor().getByRole('checkbox', { name: 'Not enforced', exact: true }),
  ).toBeDisabled();
  await apply();
  await editor().getByLabel('Check expression', { exact: true }).fill('score > 100');
  await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(editor().getByRole('alert')).toContainText('CHECK constraint failed');
  assert.equal(
    (await call('query.execute', { connectionId: connection.id, sql: 'SELECT score FROM child' }))
      .rows[0].score,
    '5',
  );
  await editor().getByRole('button', { name: 'Revert changes', exact: true }).click();
  await acceptConfirmation(page);
  await editor().getByLabel('Check expression', { exact: true }).fill('score >= 2');
  await apply();
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await expect(editor().getByLabel('檢查運算式', { exact: true })).toHaveValue('score >= 2');
  // Let Base UI transitions finish before waking the hidden compositor.
  await page.waitForTimeout(300);
  await captureDesktop(app, resolve('.local/constraint-designer.png'));
  await editor().getByRole('button', { name: '刪除約束', exact: true }).click();
  await editor().getByRole('button', { name: '預覽變更', exact: true }).click();
  await editor().getByRole('button', { name: '套用變更', exact: true }).click();
  await expect.poll(async () => (await call('structure.describe', ref)).constraints.length).toBe(0);
  console.log(
    'Constraint tabs, composite column pairs, reference choices, actions, persistent drafts, SQL preview/apply, failed-check rollback, edit/delete and Chinese labels passed.',
  );
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
