import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { scratchDir } from './support.mjs';

const dir = scratchDir('dw-review-fixes-');
const env = { ...process.env, DATABASE_WORKSPACE_DATA_DIR: dir, DATABASE_WORKSPACE_HEADLESS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({
  args: ['.', '--user-data-dir=' + join(dir, 'chromium')],
  env,
});
try {
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByRole('heading', { name: '探索資料，從這裡開始。' }).waitFor();
  const raw = (name, args = {}) =>
    page.evaluate(({ name, args }) => window.desktop.command(name, args), { name, args });
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    assert.ok(result.success, `${name}: ${result.error}`);
    return result.data;
  };
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  const c = await call('connection.save', {
    name: 'Review SQLite',
    engine: 'sqlite',
    database: join(dir, 'review.sqlite'),
  });
  await call('connection.connect', { connectionId: c.id });
  const query = (sql) => call('query.execute', { connectionId: c.id, database: c.database, sql });
  await query('CREATE TABLE review_rows(id INTEGER PRIMARY KEY,label TEXT)');
  await query("INSERT INTO review_rows VALUES(1,'first'),(2,'second')");
  const tab = await call('app.open_table', {
    connectionId: c.id,
    database: c.database,
    schema: 'main',
    table: 'review_rows',
  });
  const cell = page.getByLabel('label row 1', { exact: true });
  await expect(cell).toHaveValue('first');
  await expect(cell).toBeEnabled();
  // An external row event must also preserve a cell that has not blurred yet.
  await cell.fill('still typing');
  await call('data.update', {
    connectionId: c.id,
    database: c.database,
    schema: 'main',
    table: 'review_rows',
    values: { label: 'second' },
    filters: [{ column: 'id', operator: '=', value: '2' }],
  });
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
  await expect(cell).toHaveValue('still typing');
  await expect(page.getByLabel('id row 1', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(cell).toHaveValue('first');
  await expect(cell).toBeEnabled();
  // Hold the next refresh at IPC, reproducing a slow server without production hooks.
  await desktop.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('application:command');
    ipcMain.removeHandler('application:command');
    let pause = true;
    ipcMain.handle('application:command', async (...args) => {
      if (args[1] === 'data.select' && pause) {
        pause = false;
        await new Promise((resolve) => {
          globalThis.__reviewRelease = resolve;
        });
      }
      return original(...args);
    });
  });
  await page
    .locator('.table-view:visible')
    .getByRole('button', { name: 'Refresh', exact: true })
    .click();
  await expect(cell).toBeDisabled();
  await query('DELETE FROM review_rows WHERE id=1');
  await desktop.evaluate(() => globalThis.__reviewRelease());
  await expect(page.getByLabel('id row 1', { exact: true })).toHaveValue('2');
  await expect(cell).toHaveValue('second');
  await expect(cell).toBeEnabled();
  await cell.fill('preserved draft');
  await cell.press('Tab');
  const save = page.getByRole('button', { name: 'Save changes', exact: true });
  await expect(save).toBeVisible();
  await call('connection.save', { ...c, name: 'Renamed without disconnect' });
  await expect(cell).toHaveValue('preserved draft');
  await expect(save).toBeVisible();
  assert.equal((await call('app.get_state')).tabs.find((t) => t.id === tab.id).dirty, true);
  for (const [name, args] of [
    ['connection.save', { ...c, database: join(dir, 'changed.sqlite') }],
    ['connection.delete', { connectionId: c.id }],
  ])
    assert.match((await raw(name, args)).error, /Unsaved changes:/);
  await expect(cell).toHaveValue('preserved draft');
  // Editing the PK must match the original key, never the new one.
  await page.getByLabel('id row 1', { exact: true }).fill('3');
  await page.getByLabel('id row 1', { exact: true }).press('Tab');
  await save.click();
  await expect(save).toHaveCount(0);
  assert.deepEqual((await query('SELECT * FROM review_rows')).rows, [
    { id: '3', label: 'preserved draft' },
  ]);
  await expect(cell).toBeEnabled();
  await cell.fill('keep after conflict');
  await cell.press('Tab');
  await query('DELETE FROM review_rows WHERE id=3');
  await save.click();
  await expect(page.getByText(/The original row no longer exists/)).toBeVisible();
  await expect(cell).toHaveValue('keep after conflict');
  await expect(save).toBeVisible();
  await call('connection.delete', { connectionId: c.id, discard: true });
  assert.equal((await call('app.get_state')).tabs.filter((t) => t.connectionId === c.id).length, 0);
  await expect(cell).toHaveCount(0);
  console.log(
    'PASS: slow refresh, draft preservation, original PK, missing-row conflict and connection deletion',
  );
} finally {
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
