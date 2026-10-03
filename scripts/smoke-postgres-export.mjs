import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';

const password = integrationPassword();
const directory = scratchDir('dw-postgres-export-smoke-');
const destination = join(directory, 'export.sql');
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: join(directory, 'app'),
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const database = 'dw_pg_export_ui_' + randomUUID().replaceAll('-', '').slice(0, 12);
const config = { host: '127.0.0.1', port: 15432, user: 'workspace', password };
const admin = new pg.Client({ ...config, database: 'workspace' });
let app, page, db, connection;
async function call(name, args = {}) {
  const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
    name,
    args,
  });
  assert.ok(result.success, result.error);
  return result.data;
}
try {
  await admin.connect();
  await admin.query('CREATE DATABASE "' + database + '"');
  db = new pg.Client({ ...config, database });
  await db.connect();
  await db.query(
    'CREATE TABLE items(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,label text,amount numeric(40,20))',
  );
  await db.query('INSERT INTO items(label,amount) VALUES($1,$2)', [
    '中文😀\r\nline\nend',
    '12345678901234567890.12345678901234567890',
  ]);
  await db.query('CREATE VIEW labels AS SELECT label FROM items');
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
  connection = await call('connection.save', {
    name: 'PostgreSQL export',
    engine: 'postgres',
    host: config.host,
    port: config.port,
    username: config.user,
    password,
    database,
    readTimeout: 1000,
    writeTimeout: 1500,
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
      .getByRole('button', { name: 'Connection actions for PostgreSQL export', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel('pg_dump path').fill(path);
    await form.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(form).toHaveCount(0);
    const saved = (await call('connection.list')).find((value) => value.id === connection.id);
    assert.equal(saved.pgDumpPath, path || undefined);
    const item = page.locator(`.connection-main[data-connection-id="${connection.id}"]`);
    await expect(item).toHaveAttribute('data-state', 'disconnected');
    await item.dblclick();
  };
  await setTool(join(directory, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'));
  await open();
  await page.getByRole('dialog').getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Export failed');
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('does not exist');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await setTool('');
  await db.query('BEGIN; LOCK TABLE items IN ACCESS EXCLUSIVE MODE');
  try {
    await open();
    const blocked = page.getByRole('dialog');
    await blocked.getByRole('button', { name: 'Start export', exact: true }).click();
    await expect(blocked.getByRole('status')).toContainText('Export failed');
    await expect(blocked.getByRole('alert')).toContainText('Network read timed out');
    await blocked.getByRole('button', { name: 'Close', exact: true }).last().click();
  } finally {
    await db.query('ROLLBACK');
  }
  await open();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Export completed');
  await expect(dialog.getByRole('status')).toContainText('Rows: —');
  await expect(dialog.getByRole('status')).toContainText('Tables: 1');
  await dialog.getByRole('button', { name: 'Save SQL file', exact: true }).click();
  await expect(dialog.getByText('SQL file saved: export.sql', { exact: true })).toBeVisible();
  const sql = await readFile(destination, 'utf8');
  assert.ok(sql.includes('12345678901234567890.12345678901234567890'));
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await expect(dialog.getByRole('heading', { name: '匯出 SQL 檔案', exact: true })).toBeVisible();
  await expect(dialog.getByText(/需要原生 pg_dump/)).toBeVisible();
  await captureDesktop(app, resolve('.local/postgres-sql-export.png'));
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await open();
  await dialog.getByRole('checkbox', { name: 'Include table data', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Export completed');
  await dialog.getByRole('button', { name: 'Save SQL file', exact: true }).click();
  await expect(dialog.getByText('SQL file saved: export.sql', { exact: true })).toBeVisible();
  assert.ok(!/^INSERT INTO/m.test(await readFile(destination, 'utf8')));
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await call('connection.disconnect', { connectionId: connection.id, discard: true });
  await db.end();
  db = undefined;
  await admin.query('DROP DATABASE "' + database + '"');
  await admin.query('CREATE DATABASE "' + database + '"');
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
  db = new pg.Client({ ...config, database });
  await db.connect();
  const { rows } = await db.query('SELECT * FROM items');
  assert.equal(rows[0].label, '中文😀\r\nline\nend');
  assert.equal(rows[0].amount, '12345678901234567890.12345678901234567890');
  console.log(
    'PostgreSQL native export network deadline, recovery/save, structure-only, command-bus import, exact CRLF and Chinese UI passed.',
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
  await db?.end();
  await admin.query('DROP DATABASE IF EXISTS "' + database + '"');
  await admin.end();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
