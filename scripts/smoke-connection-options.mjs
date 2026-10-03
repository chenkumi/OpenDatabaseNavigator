import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { selectValue } from './ui-controls.mjs';
import { captureDesktop } from './capture-desktop.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';

const password = integrationPassword();
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: scratchDir('database-options-'),
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const created = [];
let page;
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
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  for (const config of [
    { name: 'Options MySQL', engine: 'mysql', port: 13306, username: 'root', database: '' },
    {
      name: 'Options SQL Server',
      engine: 'sqlserver',
      port: 11433,
      username: 'sa',
      database: 'master',
    },
  ]) {
    const connection = await call('connection.save', { ...config, host: '127.0.0.1', password });
    await page
      .getByRole('button', { name: `Connection actions for ${config.name}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Connection timeout (ms)')).toHaveValue('10000');
    await dialog.getByLabel('Connection timeout (ms)').fill('15000');
    await dialog.getByLabel('Heartbeat interval (seconds)').fill('2');
    if (config.engine === 'mysql') {
      await dialog.getByLabel('Client character set').fill('utf8mb4');
    } else {
      await expect(dialog.getByLabel('Client character set')).toHaveAttribute('readonly', '');
      await selectValue(page, dialog.getByLabel('Authentication', { exact: true }), 'windows');
      await expect(dialog.getByLabel('Read timeout (ms)')).toHaveValue('0');
      await dialog.getByLabel('Read timeout (ms)').fill('1500');
      await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText('Please check Server SPN.');
      await dialog.getByLabel('Server SPN', { exact: true }).fill('MSSQLSvc/db.example.test:1433');
      await captureDesktop(app, resolve('.local/windows-io-settings.png'));
      await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const integrated = (await call('connection.list')).find((item) => item.id === connection.id);
      assert.equal(integrated.sqlServerSpn, 'MSSQLSvc/db.example.test:1433');
      assert.equal(integrated.readTimeout, 1500);
      await page
        .getByRole('button', { name: `Connection actions for ${config.name}`, exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      await expect(dialog.getByLabel('Server SPN', { exact: true })).toHaveValue(
        integrated.sqlServerSpn,
      );
      await selectValue(page, dialog.getByLabel('Authentication', { exact: true }), 'sql');
      await dialog.getByLabel('Password', { exact: true }).fill(password);
      await dialog.getByLabel('Username', { exact: true }).fill(config.username);
      await dialog.getByLabel('Read timeout (ms)').fill('0');
    }
    await expect(dialog.getByLabel('Read timeout (ms)')).toHaveValue('0');
    await dialog.getByLabel('Read timeout (ms)').fill('1500');
    await dialog.getByLabel('Write timeout (ms)').fill('2500');
    if (config.engine === 'mysql')
      await captureDesktop(app, resolve('.local/connection-options.png'));
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await call('connection.list')).find((item) => item.id === connection.id);
    assert.equal(saved.connectionTimeout, 15000);
    assert.equal(saved.heartbeatInterval, 2);
    assert.equal(saved.readTimeout, 1500);
    assert.equal(saved.writeTimeout, 2500);
    if (config.engine === 'mysql') {
      assert.equal(saved.charset, 'utf8mb4');
    }
    await page.locator(`.connection-main[data-connection-id="${connection.id}"]`).dblclick();
    await expect(
      page.locator(`.connection-main[data-connection-id="${connection.id}"]`),
    ).toHaveAttribute('data-state', 'connected');
    await page.getByRole('button', { name: 'Create database', exact: true }).click();
    const database = `dw_options_${randomUUID().replaceAll('-', '')}`;
    created.push({ connectionId: connection.id, database });
    await dialog.getByLabel('Database name').fill(database);
    await expect(dialog.getByLabel('Collation', { exact: true })).toBeEnabled();
    const collation = config.engine === 'mysql' ? 'utf8mb4_bin' : 'Latin1_General_100_CI_AS';
    if (config.engine === 'mysql') {
      await selectValue(page, dialog.getByLabel('Character set', { exact: true }), 'utf8mb4');
      await selectValue(page, dialog.getByLabel('Collation', { exact: true }), collation);
      await selectValue(page, dialog.getByLabel('Character set', { exact: true }), 'latin1');
      await expect(dialog.getByLabel('Collation', { exact: true })).toContainText(
        'Default collation',
      );
      await selectValue(page, dialog.getByLabel('Character set', { exact: true }), 'utf8mb4');
    } else await expect(dialog.getByLabel('Character set', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Search collations').fill(collation);
    await selectValue(page, dialog.getByLabel('Collation', { exact: true }), collation);
    await captureDesktop(app, resolve(`.local/database-options-${config.engine}.png`));
    await dialog.getByRole('button', { name: 'Create database', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.ok((await call('database.list', { connectionId: connection.id })).includes(database));
    const metadata = await call('query.execute', {
      connectionId: connection.id,
      sql:
        config.engine === 'mysql'
          ? `SELECT DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${database}'`
          : `SELECT collation_name AS collation FROM sys.databases WHERE name = '${database}'`,
    });
    assert.equal(metadata.rows[0].collation, collation);
    {
      const failure = await page.evaluate(
        async ({ connectionId, sql }) =>
          window.desktop.command('query.execute', { connectionId, sql }),
        {
          connectionId: connection.id,
          sql: config.engine === 'mysql' ? 'SELECT SLEEP(3)' : "WAITFOR DELAY '00:00:03'",
        },
      );
      assert.equal(failure.success, false);
      assert.match(failure.error, /Network read timed out/);
      await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
      await page.getByRole('button', { name: `${config.name} 的連線選單`, exact: true }).click();
      await page.getByRole('menuitem', { name: '設定', exact: true }).click();
      await expect(dialog.getByLabel('讀取逾時（毫秒）')).toHaveValue('1500');
      if (config.engine === 'sqlserver') {
        const hint = dialog.getByText(
          'SQL Server 網路讀寫逾時適用於查詢、SQL 檔案及 TCP 原生匯出。Windows 驗證需指定伺服器 SPN；匯出逾時需含 Microsoft.Data.SqlClient 5.0 以上版本的 SqlServer PowerShell 模組。',
          { exact: true },
        );
        await hint.scrollIntoViewIfNeeded();
        await expect(hint).toBeVisible();
      }
      await page.waitForTimeout(300);
      await captureDesktop(
        app,
        resolve(
          config.engine === 'mysql'
            ? '.local/connection-io-timeouts.png'
            : '.local/sqlserver-io-timeouts.png',
        ),
      );
      await dialog.getByRole('button', { name: '關閉', exact: true }).click();
      await call('settings.save', { ...(await call('settings.get')), language: 'en' });
    }
  }
  const postgres = await call('connection.save', {
    name: 'Options PostgreSQL',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 15432,
    username: 'workspace',
    database: 'workspace',
    password,
  });
  await page
    .getByRole('button', { name: 'Connection actions for Options PostgreSQL', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const pgDialog = page.getByRole('dialog');
  await expect(pgDialog.getByLabel('Read timeout (ms)')).toHaveValue('0');
  await selectValue(page, pgDialog.getByLabel('Client character set', { exact: true }), 'BIG5');
  await pgDialog.getByLabel('Read timeout (ms)').fill('500');
  await pgDialog.getByLabel('Write timeout (ms)').fill('1000');
  await expect(
    pgDialog.getByText(
      'PostgreSQL network deadlines apply to queries, SQL files and pg_dump export. Native export monitors transport inactivity throughout the job; output processing pauses the read deadline.',
      { exact: true },
    ),
  ).toBeVisible();
  await pgDialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  const pgSaved = (await call('connection.list')).find((item) => item.id === postgres.id);
  assert.equal(pgSaved.readTimeout, 500);
  assert.equal(pgSaved.writeTimeout, 1000);
  assert.equal(pgSaved.charset, 'BIG5');
  await call('connection.connect', { connectionId: postgres.id });
  const pgEncoding = await call('query.execute', {
    connectionId: postgres.id,
    sql: 'SHOW client_encoding',
  });
  assert.equal(pgEncoding.rows[0].client_encoding, 'BIG5');
  const pgText = await call('query.execute', {
    connectionId: postgres.id,
    sql: 'SELECT \'許中文\' AS "中文"',
  });
  assert.equal(pgText.rows[0]['中文'], '許中文');
  const pgFailure = await page.evaluate(
    (connectionId) =>
      window.desktop.command('query.execute', {
        connectionId,
        sql: 'SELECT pg_sleep(2)',
      }),
    postgres.id,
  );
  assert.equal(pgFailure.success, false);
  assert.match(pgFailure.error, /Network read timed out/);
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await page.getByRole('button', { name: 'Options PostgreSQL 的連線選單', exact: true }).click();
  await page.getByRole('menuitem', { name: '設定', exact: true }).click();
  await expect(pgDialog.getByLabel('讀取逾時（毫秒）')).toHaveValue('500');
  await expect(pgDialog.getByLabel('用戶端字元集', { exact: true })).toContainText('Big5');
  await pgDialog.getByLabel('用戶端字元集', { exact: true }).scrollIntoViewIfNeeded();
  await captureDesktop(app, resolve('.local/postgres-encoding.png'));
  const pgHint = pgDialog.getByText(
    'PostgreSQL 網路讀寫逾時適用於查詢、SQL 檔案及 pg_dump 匯出。原生匯出依工作期間的網路活動計時；處理輸出時暫停讀取期限。',
    { exact: true },
  );
  await pgHint.scrollIntoViewIfNeeded();
  await expect(pgHint).toBeVisible();
  await page.waitForTimeout(300);
  await captureDesktop(app, resolve('.local/postgres-io-timeouts.png'));
  await pgDialog.getByRole('button', { name: '關閉', exact: true }).click();
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  // Exercise Redis heartbeat and the selected text encoding through the shared commands.
  const redis = await call('connection.save', {
    name: 'Heartbeat Redis',
    engine: 'redis',
    host: '127.0.0.1',
    port: 16379,
    database: '0',
    password,
    heartbeatInterval: 1,
    connectionTimeout: 5000,
  });
  await page
    .getByRole('button', { name: 'Connection actions for Heartbeat Redis', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const redisDialog = page.getByRole('dialog');
  await expect(redisDialog.getByLabel('Read timeout (ms)')).toHaveValue('0');
  await redisDialog.getByLabel('Read timeout (ms)').fill('1000');
  await redisDialog.getByLabel('Write timeout (ms)').fill('1500');
  await selectValue(page, redisDialog.getByLabel('Client character set', { exact: true }), 'big5');
  await redisDialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  const redisSaved = (await call('connection.list')).find((item) => item.id === redis.id);
  assert.equal(redisSaved.readTimeout, 1000);
  assert.equal(redisSaved.writeTimeout, 1500);
  assert.equal(redisSaved.charset, 'big5');
  await call('connection.connect', { connectionId: redis.id });
  const redisRef = {
    connectionId: redis.id,
    database: '0',
    key: `dw:charset:desktop:${randomUUID()}:許`,
  };
  try {
    await call('redis.set', { ...redisRef, value: '中文測試' });
    assert.deepEqual((await call('redis.get', redisRef)).items, ['中文測試']);
  } finally {
    await call('redis.delete', redisRef);
  }
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal((await call('connection.status', { connectionId: redis.id })).connected, true);
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await page.getByRole('button', { name: 'Heartbeat Redis 的連線選單', exact: true }).click();
  await page.getByRole('menuitem', { name: '設定', exact: true }).click();
  await expect(redisDialog.getByLabel('讀取逾時（毫秒）')).toHaveValue('1000');
  await redisDialog.getByLabel('寫入逾時（毫秒）').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await expect(redisDialog.getByLabel('用戶端字元集', { exact: true })).toContainText('Big5');
  await captureDesktop(app, resolve('.local/redis-client-charset.png'));
  await redisDialog.getByRole('button', { name: '關閉', exact: true }).click();
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await call('connection.disconnect', { connectionId: redis.id, discard: true });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await call('connection.status', { connectionId: redis.id })).connected, false);
} finally {
  try {
    if (app && page) {
      for (const { connectionId, database } of created) {
        await call('connection.disconnect', { connectionId, discard: true });
        const saved = (await call('connection.list')).find((item) => item.id === connectionId);
        await call('connection.save', {
          ...saved,
          readTimeout: 0,
          writeTimeout: 0,
          heartbeatInterval: 0,
        });
        await call('connection.connect', { connectionId });
        if ((await call('database.list', { connectionId })).includes(database))
          await call('query.execute', { connectionId, sql: `DROP DATABASE ${database}` });
      }
    }
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    await rm(env.DATABASE_WORKSPACE_DATA_DIR, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}
console.log(
  'Connection option persistence, PostgreSQL/MySQL/SQL Server/Redis network deadlines, engine-specific catalog choices, collation filtering/reset, actual database creation, Redis Big5 data, heartbeat lifecycle and fixture cleanup passed.',
);
