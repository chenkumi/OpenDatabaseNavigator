import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';

const password = integrationPassword();
const directory = scratchDir('dw-mysql-export-smoke-');
const destination = join(directory, 'export.sql');
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
      '*,*::before,*::after{animation-duration:0s !important;transition-duration:0s !important;}',
  });
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, destination);
  for (const port of [13306, 13307]) {
    const database = 'dw_export_ui_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const admin = await mysql.createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
      password,
      charset: 'utf8mb4',
    });
    let connection;
    try {
      await admin.query(
        'CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      );
      await admin.query('USE `' + database + '`');
      await admin.query(
        'CREATE TABLE items(id INT PRIMARY KEY,label VARCHAR(100),amount DECIMAL(40,20)) ENGINE=InnoDB',
      );
      await admin.query(
        "INSERT INTO items VALUES(1,'中文😀',12345678901234567890.12345678901234567890)",
      );
      await admin.query('CREATE VIEW labels AS SELECT label FROM items');
      connection = await call('connection.save', {
        name: port === 13306 ? 'MySQL export' : 'MariaDB export',
        engine: 'mysql',
        host: '127.0.0.1',
        port,
        username: 'root',
        password,
        database,
        charset: 'latin1',
      });
      await page.locator(`.connection-main[data-connection-id="${connection.id}"]`).dblclick();
      const open = async () => {
        await page
          .getByRole('button', { name: `Database actions for ${database}`, exact: true })
          .click();
        await page.getByRole('menuitem', { name: 'Export SQL file', exact: true }).click();
      };
      await open();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText('Export completed');
      await dialog.getByRole('button', { name: 'Save SQL file', exact: true }).click();
      await expect(dialog.getByText('SQL file saved: export.sql', { exact: true })).toBeVisible();
      const sql = await readFile(destination, 'utf8');
      assert.ok(sql.includes('12345678901234567890.12345678901234567890'));
      if (port === 13306) {
        await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
        await expect(
          dialog.getByRole('heading', { name: '匯出 SQL 檔案', exact: true }),
        ).toBeVisible();
        await captureDesktop(app, resolve('.local/mysql-sql-export.png'));
        await call('settings.save', { ...(await call('settings.get')), language: 'en' });
      }
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
      await admin.query('CREATE TABLE oversized(value LONGBLOB) ENGINE=InnoDB');
      await admin.query("INSERT INTO oversized VALUES(REPEAT('x',9000000))");
      await open();
      await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText('Export failed');
      await expect(dialog.getByRole('alert')).toBeVisible();
      await dialog.getByRole('checkbox', { name: 'Include table data', exact: true }).uncheck();
      await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText('Export completed');
      await dialog.getByRole('button', { name: 'Save SQL file', exact: true }).click();
      await expect(dialog.getByText('SQL file saved: export.sql', { exact: true })).toBeVisible();
      assert.ok(!(await readFile(destination, 'utf8')).includes('INSERT INTO `items`'));
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
      await call('connection.disconnect', { connectionId: connection.id, discard: true });
      await admin.query('DROP DATABASE `' + database + '`');
      await admin.query(
        'CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      );
      await admin.query('USE `' + database + '`');
      await call('connection.connect', { connectionId: connection.id });
      const input = { connectionId: connection.id, database, sql, fileName: 'export.sql' };
      const preview = await call('script.preview', input),
        id = randomUUID();
      await call('script.execute', {
        ...input,
        id,
        continueOnError: false,
        mysqlSqlMode: preview.mysqlSqlMode,
      });
      await expect.poll(async () => (await call('script.status', { id })).state).toBe('completed');
      const [rows] = await admin.query('SELECT * FROM items');
      assert.equal(rows[0].label, '中文😀');
      assert.equal(rows[0].amount, '12345678901234567890.12345678901234567890');
    } finally {
      if (connection)
        await call('connection.disconnect', { connectionId: connection.id, discard: true }).catch(
          () => {},
        );
      await admin.query({ sql: 'DROP DATABASE IF EXISTS `' + database + '`', timeout: 10000 });
      await admin.end();
    }
  }
  console.log(
    'MySQL and MariaDB native export/save, failure-to-schema retry, Unicode import and Chinese UI passed.',
  );
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
