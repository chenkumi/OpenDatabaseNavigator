import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';

const directory = scratchDir('dw-sql-export-smoke-');
const database = join(directory, 'source.db'),
  destination = join(directory, 'export.sql');
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: join(directory, 'app'),
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
async function call(name, args = {}) {
  const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
    name,
    args,
  });
  assert.ok(result.success, result.error);
  return result.data;
}
try {
  app = await electron.launch({ args: ['.', isolatedProfile()], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.locator('.app-shell').waitFor();
  await page.addStyleTag({
    content:
      '*,*::before,*::after {animation-duration:0s !important;transition-duration:0s !important;}',
  });
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, destination);
  const connection = await call('connection.save', {
    engine: 'sqlite',
    database,
    name: 'SQL export test',
  });
  await page.locator(`.connection-main[data-connection-id="${connection.id}"]`).dblclick();
  for (const sql of [
    'CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)',
    "INSERT INTO items(label) VALUES('中文😀'),('two')",
    'CREATE INDEX label_idx ON items(label)',
    'CREATE VIEW labels AS SELECT label FROM items',
  ])
    await call('query.execute', { connectionId: connection.id, sql });
  await page.getByRole('button', { name: `Database actions for ${database}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export SQL file', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Include table data', exact: true }).uncheck();
  await expect(dialog.getByText('Structure only', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Export completed');
  await dialog.getByRole('button', { name: 'Save SQL file', exact: true }).click();
  await expect(dialog.getByText('SQL file saved: export.sql', { exact: true })).toBeVisible();
  assert.ok(!(await readFile(destination, 'utf8')).includes('INSERT INTO "items"'));
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: `Database actions for ${database}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export SQL file', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Rows: 2');
  await dialog.getByRole('button', { name: 'Save SQL file', exact: true }).click();
  await expect(dialog.getByText('SQL file saved: export.sql', { exact: true })).toBeVisible();
  const sql = await readFile(destination, 'utf8');
  assert.ok(sql.includes('INSERT INTO "items"'));
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await expect(dialog.getByRole('heading', { name: '匯出 SQL 檔案', exact: true })).toBeVisible();
  await captureDesktop(app, resolve('.local/sql-file-export.png'));
  await dialog.getByRole('button', { name: '關閉', exact: true }).last().click();
  const restored = await call('connection.save', {
    engine: 'sqlite',
    database: join(directory, 'restored.db'),
    name: 'Restored',
  });
  await call('connection.connect', { connectionId: restored.id });
  const id = crypto.randomUUID();
  await call('script.execute', {
    connectionId: restored.id,
    database: restored.database,
    id,
    sql,
    fileName: 'export.sql',
    continueOnError: false,
  });
  await expect.poll(async () => (await call('script.status', { id })).state).toBe('completed');
  const result = await call('query.execute', {
    connectionId: restored.id,
    sql: 'SELECT * FROM labels ORDER BY label',
  });
  assert.deepEqual(
    result.rows.map((row) => row.label),
    ['two', '中文😀'],
  );
  await call('connection.disconnect', { connectionId: connection.id, discard: true });
  await call('connection.disconnect', { connectionId: restored.id, discard: true });
  console.log('SQL export modes, native save path, Chinese UI and import round-trip passed.');
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
