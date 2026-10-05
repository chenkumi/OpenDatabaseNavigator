import { selectValue } from './ui-controls.mjs';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { scratchDir, isolatedProfile } from './support.mjs';

// This verifies the real desktop and missing-driver path, not an ASE server.
const dataDir = scratchDir('database-workspace-ase-');
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', isolatedProfile()], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
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
  await selectValue(page, page.getByLabel('Database type', { exact: true }), 'sybase');
  assert.equal(await page.getByLabel('Port', { exact: true }).inputValue(), '5000');
  assert.equal(
    await page.getByLabel('ASE ODBC driver', { exact: true }).inputValue(),
    'Adaptive Server Enterprise',
  );
  await page.getByLabel('Name', { exact: true }).fill('ASE desktop validation');
  await page.getByLabel('Password', { exact: true }).fill('test-secret-do-not-persist');
  await page.getByRole('checkbox', { name: 'TLS', exact: true }).check();
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Trusted certificates file' }).waitFor();
  await page
    .getByLabel('Trusted certificates file', { exact: true })
    .fill('C:\\certs\\ase-root.pem');
  // Intentionally nonexistent driver: deterministic failure even if ASE is later installed.
  await page
    .getByLabel('ASE ODBC driver', { exact: true })
    .fill('DatabaseWorkspace_Missing_ASE_Driver');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'ASE' }).waitFor();
  assert.ok(
    !(await page.locator('.connection-message').innerText()).includes('test-secret-do-not-persist'),
  );
  await page.getByLabel('Read timeout (ms)').fill('1200');
  await page.getByLabel('Write timeout (ms)').fill('1500');
  await page.getByLabel('Heartbeat interval (seconds)').fill('30');
  await selectValue(page, page.getByLabel('Client character set', { exact: true }), 'big5');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'jconn4.jar' }).waitFor();
  await page.getByLabel('Java path for ASE', { exact: true }).fill('C:\\Java\\bin\\java.exe');
  await page
    .getByLabel('SAP DDLGen.jar path', { exact: true })
    .fill('C:\\SAP\\ASE-16_0\\lib\\DDLGen.jar');
  await page
    .getByLabel('SAP jconn4.jar path', { exact: true })
    .fill('C:\\SAP\\jConnect-16_0\\classes\\jconn4.jar');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  const saved = (await call('connection.list'))[0];
  assert.equal(saved.engine, 'sybase');
  assert.equal(saved.readTimeout, 1200);
  assert.equal(saved.writeTimeout, 1500);
  assert.equal(saved.heartbeatInterval, 30);
  assert.equal(saved.charset, 'big5');
  assert.equal(saved.aseJavaPath, 'C:\\Java\\bin\\java.exe');
  assert.equal(saved.aseDdlgenPath, 'C:\\SAP\\ASE-16_0\\lib\\DDLGen.jar');
  assert.equal(saved.aseJconnectPath, 'C:\\SAP\\jConnect-16_0\\classes\\jconn4.jar');
  assert.equal(saved.aseTrustedFile, 'C:\\certs\\ase-root.pem');
  await page
    .getByRole('button', { name: 'Connection actions for ASE desktop validation', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  assert.match(await page.getByLabel('Database type', { exact: true }).innerText(), /Sybase ASE/);
  assert.equal(await page.getByLabel('Read timeout (ms)').inputValue(), '1200');
  assert.equal(await page.getByLabel('Write timeout (ms)').inputValue(), '1500');
  assert.equal(await page.getByLabel('Heartbeat interval (seconds)').inputValue(), '30');
  assert.match(
    await page.getByLabel('Client character set', { exact: true }).innerText(),
    /Big5 \(JDBC\)/,
  );
  assert.equal(
    await page.getByLabel('Java path for ASE', { exact: true }).inputValue(),
    saved.aseJavaPath,
  );
  assert.equal(
    await page.getByLabel('SAP DDLGen.jar path', { exact: true }).inputValue(),
    saved.aseDdlgenPath,
  );
  assert.equal(
    await page.getByLabel('SAP jconn4.jar path', { exact: true }).inputValue(),
    saved.aseJconnectPath,
  );
  assert.equal(
    await page.getByLabel('Trusted certificates file', { exact: true }).inputValue(),
    saved.aseTrustedFile,
  );
  assert.ok(
    !(await readFile(join(dataDir, 'connections.json'), 'utf8')).includes(
      'test-secret-do-not-persist',
    ),
  );
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Java' }).waitFor();
  assert.ok(
    !(await page.locator('.connection-message').innerText()).includes('test-secret-do-not-persist'),
  );
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await page.getByText('ASE Java 路徑', { exact: true }).waitFor();
  console.log('Checking ASE read-only restrictions before native login...');
  for (const sql of [
    'UPDATE t SET x=1',
    'SELECT * INTO other FROM t',
    'SELECT dbo.write$probe()',
  ]) {
    const result = await page.evaluate(
      ({ connectionId, sql }) => window.desktop.command('query.execute', { connectionId, sql }),
      { connectionId: saved.id, sql },
    );
    assert.equal(result.success, false);
    assert.match(result.error, /read-only/i);
  }
  for (const language of ['en', 'zh-TW']) {
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of [
        [1280, 720],
        [1920, 1080],
      ]) {
        console.log(`Checking ASE form: ${language}/${theme}/${width}x${height}...`);
        await call('settings.save', { ...(await call('settings.get')), language, theme });
        await page.setViewportSize({ width, height });
        const notice =
          language === 'en'
            ? 'Sybase is read-only. ASE 11.x is the current test target; ASE 16.x remains unverified. Writes, DDL, SQL file execution and native SQL export are disabled. SQL Anywhere and IQ are not supported.'
            : 'Sybase 僅提供唯讀功能。目前以 ASE 11.x 為實測目標，16.x 尚未驗證。已停用寫入、DDL、SQL 檔案執行及原生 SQL 匯出。不支援 SQL Anywhere 與 IQ。';
        await page.getByText(notice, { exact: true }).waitFor();
        const connectionLabel = page.locator('.connection-main small').filter({
          hasText: language === 'en' ? 'sybase · Read-only' : 'sybase · 唯讀',
        });
        await connectionLabel.waitFor({ state: 'attached' });
        const geometry = await page.evaluate(() => {
          const modal =
            document.querySelector('.connection-form') || document.querySelector('[role="dialog"]');
          const save = [...document.querySelectorAll('button')].find((button) =>
            /Save connection|儲存連線/.test(button.textContent || ''),
          );
          return {
            documentWidth: document.documentElement.scrollWidth,
            viewport: innerWidth,
            dialogWidth: modal?.getBoundingClientRect().width,
            saveHeight: save?.offsetHeight,
          };
        });
        assert.ok(geometry.documentWidth <= geometry.viewport + 1);
        assert.equal(geometry.saveHeight, 32);
        await page.screenshot({ path: `.local/ase-readonly-${language}-${theme}-${width}.png` });
      }
    }
  }
  console.log(
    'ASE desktop smoke passed: read-only rejection, form, TLS validation, missing ODBC/JDBC tools, encoding save/edit, language/theme/size matrix and credential protection. No ASE server was used.',
  );
} finally {
  await app.close();
}
