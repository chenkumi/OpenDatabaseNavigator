import { selectValue } from './ui-controls.mjs';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';

if (process.platform !== 'win32') throw new Error('This integration smoke requires Windows.');
const password = integrationPassword();
const dataDir = scratchDir('database-workspace-windows-auth-');
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.argv.includes('--packaged')
  ? resolve(
      process.env.DATABASE_WORKSPACE_EXECUTABLE || 'release/win-unpacked/Database Workspace.exe',
    )
  : undefined;
const app = await electron.launch({
  executablePath,
  args: executablePath ? [isolatedProfile()] : ['.', isolatedProfile()],
  env,
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.getByRole('heading', { name: '探索資料，從這裡開始。' }).waitFor();
  const call = async (name, args = {}) => {
    const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
      name,
      args,
    });
    assert.ok(result.success, `${name}: ${result.error}`);
    return result.data;
  };
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await page.getByRole('button', { name: 'Create your first connection' }).click();
  await selectValue(page, page.getByLabel('Database type', { exact: true }), 'sqlserver');
  assert.equal(
    await page.getByLabel('Authentication', { exact: true }).innerText(),
    'SQL Server authentication',
  );
  await page.getByLabel('Username', { exact: true }).waitFor();
  await page.getByLabel('Password', { exact: true }).fill('must-not-be-stored');
  await selectValue(page, page.getByLabel('Authentication', { exact: true }), 'windows');
  assert.equal(await page.getByLabel('Username', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Password', { exact: true }).count(), 0);
  await page.getByLabel('Name', { exact: true }).fill('Windows SQL Server');
  await page
    .getByLabel('Host', { exact: true })
    .fill(process.env.WINDOWS_SQLSERVER_HOST || 'lpc:localhost');
  await page.getByLabel('Database', { exact: true }).fill('master');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await page.getByText('Connection successful', { exact: true }).waitFor();
  await mkdir('.local', { recursive: true });
  await captureDesktop(app, resolve('.local/sqlserver-windows-auth.png'));
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  const integrated = (await call('connection.list'))[0];
  assert.equal(integrated.sqlServerAuth, 'windows');
  assert.equal(integrated.username, undefined);
  const identity = await call('query.execute', {
    connectionId: integrated.id,
    sql: 'SELECT auth_scheme FROM sys.dm_exec_connections WHERE session_id=@@SPID',
    showInApp: true,
  });
  assert.ok(['NTLM', 'KERBEROS'].includes(identity.rows[0].auth_scheme));
  const windowsDecimal = await page.evaluate(
    (connectionId) =>
      window.desktop.command('query.execute', {
        connectionId,
        sql: "SELECT CAST('123456789012345.123456' AS DECIMAL(21,6)) AS value",
      }),
    integrated.id,
  );
  assert.equal(windowsDecimal.success, false);
  assert.match(windowsDecimal.error, /cannot return DECIMAL or SQL_VARIANT losslessly/);
  const windowsExact = await call('query.execute', {
    connectionId: integrated.id,
    sql: "SELECT CONVERT(NVARCHAR(50), CAST('123456789012345.123456' AS DECIMAL(21,6))) AS value",
  });
  assert.equal(windowsExact.rows[0].value, '123456789012345.123456');
  await page
    .getByRole('button', { name: 'Connection actions for Windows SQL Server', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  assert.equal(
    await page.getByLabel('Authentication', { exact: true }).innerText(),
    'Windows authentication',
  );
  await selectValue(page, page.getByLabel('Authentication', { exact: true }), 'sql');
  await page.getByLabel('Password', { exact: true }).waitFor();
  await page.locator('.modal header button').click();
  const sql = await call('connection.save', {
    name: 'Password SQL Server',
    engine: 'sqlserver',
    host: '127.0.0.1',
    port: 11433,
    database: 'master',
    username: 'sa',
    password,
    sqlServerAuth: 'sql',
  });
  await call('connection.test', { ...sql });
  const exact = await call('query.execute', {
    connectionId: sql.id,
    sql: "SELECT CAST('123456789012345.123456' AS DECIMAL(21,6)) AS value",
  });
  assert.equal(exact.rows[0].value, '123456789012345.123456');
  const standard = await call('query.execute', {
    connectionId: sql.id,
    sql: 'SELECT 7 AS password_login',
  });
  assert.equal(standard.rows[0].password_login, 7);
  const again = await call('query.execute', {
    connectionId: integrated.id,
    sql: 'SELECT 8 AS integrated_login',
  });
  assert.equal(again.rows[0].integrated_login, 8);
  await page.reload();
  await page
    .getByRole('button', { name: 'Connection actions for Windows SQL Server', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  assert.equal(
    await page.getByLabel('Authentication', { exact: true }).innerText(),
    'Windows authentication',
  );
  const stored = await readFile(join(dataDir, 'connections.json'), 'utf8');
  assert.ok(!stored.includes(password) && !stored.includes('must-not-be-stored'));
  console.log(
    JSON.stringify(
      {
        success: true,
        packaged: !!executablePath,
        verified: [
          'authentication selector and credential fields',
          'real Windows NTLM/Kerberos login',
          'Test / Save / Edit / reload persistence',
          'SQL password and Windows sessions coexist',
          'no plaintext credentials',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
