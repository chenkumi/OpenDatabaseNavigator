import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';

const directory = scratchDir('dw-sql-file-smoke-');
const database = join(directory, 'script.db'),
  file = join(directory, 'fixture.sql');
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
  await writeFile(
    file,
    "CREATE TABLE imported(id INTEGER PRIMARY KEY, label TEXT);\nBEGIN;\nINSERT INTO imported VALUES(1,'one;值');\nINSERT INTO imported VALUES(2,'two');\nCOMMIT;\n",
  );
  app = await electron.launch({ args: ['.', isolatedProfile()], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.locator('.app-shell').waitFor();
  await page.addStyleTag({
    content:
      '*,*::before,*::after { animation-duration:0s !important; transition-duration:0s !important; }',
  });
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  // Stub only the OS picker; the real main-process file reader, IPC and commands run.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, file);
  const connection = await call('connection.save', {
    engine: 'sqlite',
    database,
    name: 'SQL file test',
  });
  await page.locator(`.connection-main[data-connection-id="${connection.id}"]`).dblclick();
  await page.getByRole('button', { name: `Database actions for ${database}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Execute SQL file', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Choose SQL file', exact: true }).click();
  await expect(dialog.getByText('Statements / batches: 5', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Execute file', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Script completed');
  assert.equal(
    (await call('query.execute', { connectionId: connection.id, sql: 'SELECT * FROM imported' }))
      .rowCount,
    2,
  );
  await expect(dialog.getByRole('button', { name: 'Execute file', exact: true })).toBeDisabled();
  await writeFile(
    file,
    "INSERT INTO imported VALUES(1,'duplicate');\nINSERT INTO imported VALUES(3,'continued');",
  );
  await dialog.getByRole('button', { name: 'Choose SQL file', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Continue after errors', exact: true }).check();
  await dialog.getByRole('button', { name: 'Execute file', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('2 / 2');
  await expect(dialog.getByRole('status')).toContainText('Failed: 1');
  assert.equal(
    (await call('query.execute', { connectionId: connection.id, sql: 'SELECT * FROM imported' }))
      .rowCount,
    3,
  );
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await expect(dialog.getByRole('heading', { name: '執行 SQL 檔案' })).toBeVisible();
  await captureDesktop(app, resolve('.local/sql-file-execution.png'));
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await writeFile(
    file,
    "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n;\nINSERT INTO imported VALUES(99,'must not run');",
  );
  await dialog.getByRole('button', { name: 'Choose SQL file', exact: true }).click();
  await dialog.getByRole('button', { name: 'Execute file', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel execution', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Script cancelled', { timeout: 5000 });
  assert.equal(
    (
      await call('query.execute', {
        connectionId: connection.id,
        sql: 'SELECT * FROM imported WHERE id=99',
      })
    ).rowCount,
    0,
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
  await call('connection.disconnect', { connectionId: connection.id, discard: true });
  console.log(
    'Native file-read path, SQL preview, transaction import, continue-on-error, hard cancellation and Chinese UI passed.',
  );
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
