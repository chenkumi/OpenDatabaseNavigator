import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import mssql from 'mssql';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { sqlServerTestEnv } from './sqlserver-test-env.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';

const password = integrationPassword();
const directory = scratchDir('dw-sqlserver-export-smoke-');
const destination = join(directory, 'export.sql');
const env = {
  ...sqlServerTestEnv(),
  DATABASE_WORKSPACE_DATA_DIR: join(directory, 'app'),
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const database = 'dw_smo_export_ui_' + randomUUID().replaceAll('-', '').slice(0, 12);
const pool = await new mssql.ConnectionPool({
  server: '127.0.0.1',
  port: 11433,
  user: 'sa',
  password,
  database: 'master',
  options: { encrypt: false, trustServerCertificate: false },
}).connect();
let app, page, connection;
async function call(name, args = {}) {
  const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
    name,
    args,
  });
  assert.ok(result.success, result.error);
  return result.data;
}
try {
  await pool.request().batch('CREATE DATABASE [' + database + ']');
  await pool
    .request()
    .input('text', mssql.NVarChar(mssql.MAX), '中文😀\0\r\nline')
    .batch(
      'CREATE TABLE [' +
        database +
        '].dbo.items(id bigint IDENTITY PRIMARY KEY,label nvarchar(max),amount numeric(38,18)); INSERT INTO [' +
        database +
        '].dbo.items(label,amount) VALUES(@text,12345678901234567890.123456789012345678)',
    );
  app = await electron.launch({ args: ['.', isolatedProfile()], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.locator('.app-shell').waitFor();
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation-duration:0s !important;transition-duration:0s !important;}',
  });
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, destination);
  connection = await call('connection.save', {
    name: 'SQL Server export',
    engine: 'sqlserver',
    host: '127.0.0.1',
    port: 11433,
    username: 'sa',
    password,
    database,
    readTimeout: 2000,
    writeTimeout: 2000,
  });
  await page.locator(`.connection-main[data-connection-id="${connection.id}"]`).dblclick();
  const open = async () => {
    await page
      .getByRole('button', { name: `Database actions for ${database}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Export SQL file', exact: true }).click();
  };
  const setTool = async (path) => {
    await page
      .getByRole('button', { name: 'Connection actions for SQL Server export', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel('PowerShell path for SQL export').fill(path);
    await form.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(form).toHaveCount(0);
    const saved = (await call('connection.list')).find((value) => value.id === connection.id);
    assert.equal(saved.sqlServerPowerShellPath, path || undefined);
    const item = page.locator(`.connection-main[data-connection-id="${connection.id}"]`);
    await expect(item).toHaveAttribute('data-state', 'disconnected');
    await item.dblclick();
  };
  await setTool(join(directory, process.platform === 'win32' ? 'powershell.exe' : 'pwsh'));
  await open();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Export failed');
  await expect(dialog.getByRole('alert')).toContainText('does not exist');
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await setTool('');
  const lock = new mssql.Transaction(pool);
  await lock.begin();
  try {
    await new mssql.Request(lock).batch(
      'SELECT TOP (1) * FROM [' + database + '].dbo.items WITH (TABLOCKX,HOLDLOCK)',
    );
    await open();
    await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Export failed', { timeout: 30000 });
    await expect(dialog.getByRole('alert')).toContainText('Network read timed out');
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  } finally {
    await lock.rollback();
  }
  await open();
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Export completed', { timeout: 30000 });
  await expect(dialog.getByRole('status')).toContainText('Tables: 1');
  await expect(dialog.getByRole('status')).toContainText('Rows: 1');
  await dialog.getByRole('button', { name: 'Save SQL file', exact: true }).click();
  await expect(dialog.getByText('SQL file saved: export.sql', { exact: true })).toBeVisible();
  const sql = await readFile(destination, 'utf8');
  assert.ok(sql.includes('12345678901234567890.123456789012345678'));
  assert.ok(!sql.includes('\0'));
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await expect(dialog.getByRole('heading', { name: '匯出 SQL 檔案', exact: true })).toBeVisible();
  await expect(dialog.getByText(/資料表共用鎖/)).toBeVisible();
  await captureDesktop(app, resolve('.local/sqlserver-sql-export.png'));
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await open();
  await dialog.getByRole('checkbox', { name: 'Include table data', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Export completed', { timeout: 30000 });
  await dialog.getByRole('button', { name: 'Save SQL file', exact: true }).click();
  await expect(dialog.getByText('SQL file saved: export.sql', { exact: true })).toBeVisible();
  assert.ok(!/^INSERT INTO/m.test(await readFile(destination, 'utf8')));
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await call('connection.disconnect', { connectionId: connection.id, discard: true });
  await pool
    .request()
    .batch('DROP DATABASE [' + database + ']; CREATE DATABASE [' + database + ']');
  await call('connection.connect', { connectionId: connection.id });
  const input = { connectionId: connection.id, database, sql, fileName: 'export.sql' };
  await call('script.preview', input);
  const id = randomUUID();
  await call('script.execute', { ...input, id, continueOnError: false });
  await expect
    .poll(async () => {
      const status = await call('script.status', { id });
      if (status.state === 'failed') throw new Error(JSON.stringify(status));
      return status.state;
    })
    .toBe('completed');
  const { recordset } = await pool
    .request()
    .query('SELECT label,CONVERT(varchar(60),amount) AS amount FROM [' + database + '].dbo.items');
  assert.equal(recordset[0].label, '中文😀\0\r\nline');
  assert.equal(recordset[0].amount, '12345678901234567890.123456789012345678');
  console.log(
    'SQL Server native tool settings, both export modes, save, command-bus import, exact values and Chinese UI passed.',
  );
} finally {
  if (connection && page)
    await call('connection.disconnect', { connectionId: connection.id, discard: true }).catch(
      () => {},
    );
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
  await pool.request().batch('DROP DATABASE IF EXISTS [' + database + ']');
  await pool.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
