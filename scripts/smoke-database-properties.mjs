import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
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
  DATABASE_WORKSPACE_DATA_DIR: scratchDir('database-properties-'),
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const created = [];
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
  // Hidden windows can pause exit animations; keep screenshot frames deterministic.
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }',
  });
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  for (const config of [
    { engine: 'mysql', port: 13306, username: 'root', database: 'workspace' },
    { engine: 'sqlserver', port: 11433, username: 'sa', database: 'master' },
    { engine: 'postgres', port: 15432, username: 'workspace', database: 'workspace' },
  ]) {
    const connection = await call('connection.save', {
      ...config,
      name: `Properties ${config.engine}`,
      host: '127.0.0.1',
      password,
    });
    await page.locator(`.connection-main[data-connection-id="${connection.id}"]`).dblclick();
    await expect(
      page.locator(`.connection-main[data-connection-id="${connection.id}"]`),
    ).toHaveAttribute('data-state', 'connected');
    await page.getByRole('button', { name: 'Create database', exact: true }).click();
    const database = 'dw_props_' + randomUUID().replaceAll('-', '').slice(0, 12);
    created.push({ connectionId: connection.id, database });
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Database name').fill(database);
    if (config.engine === 'postgres') {
      await expect(dialog.getByLabel('Character set', { exact: true })).toBeEnabled();
      await selectValue(page, dialog.getByLabel('Character set', { exact: true }), 'UTF8');
      await selectValue(page, dialog.getByLabel('Locale provider', { exact: true }), 'icu');
      await dialog.getByLabel('Locale', { exact: true }).fill('zh-Hant-TW');
      await expect(
        dialog.getByLabel('Character classification (LC_CTYPE)', { exact: true }),
      ).toHaveCount(0);
      await new Promise((r) => setTimeout(r, 300));
      await captureDesktop(app, resolve('.local/database-postgres-locale.png'));
    }
    await dialog.getByRole('button', { name: 'Create database', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page
      .getByRole('button', { name: `Database actions for ${database}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Database properties', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Character set', { exact: true })).toBeVisible();
    if (config.engine === 'postgres') {
      await expect(dialog.getByLabel('Character set', { exact: true })).toHaveValue('UTF8');
      await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
      await expect(
        dialog.getByText('PostgreSQL encoding and locale cannot be changed after creation.', {
          exact: true,
        }),
      ).toBeVisible();
    } else {
      const collation = config.engine === 'mysql' ? 'latin1_bin' : 'Latin1_General_100_CS_AS';
      if (config.engine === 'mysql') {
        await selectValue(page, dialog.getByLabel('Character set', { exact: true }), 'latin1');
        await expect(dialog.getByLabel('Collation', { exact: true })).toContainText(
          'Default collation',
        );
      }
      await dialog.getByLabel('Search collations', { exact: true }).fill(collation);
      await selectValue(page, dialog.getByLabel('Collation', { exact: true }), collation);
      await dialog.getByRole('button', { name: 'Preview SQL', exact: true }).click();
      await expect(dialog.locator('pre')).toContainText('ALTER DATABASE');
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(dialog.locator('pre')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      assert.equal(
        (await call('database.properties.describe', { connectionId: connection.id, database }))
          .collation,
        collation,
      );
      if (config.engine === 'mysql') {
        await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
        await expect(dialog.getByRole('heading', { name: '資料庫屬性' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: '預覽 SQL', exact: true })).toBeVisible();
        await new Promise((r) => setTimeout(r, 300));
        await captureDesktop(app, resolve('.local/database-properties.png'));
        await call('settings.save', { ...(await call('settings.get')), language: 'en' });
      }
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toHaveCount(0);
    await call('connection.disconnect', { connectionId: connection.id, discard: true });
  }
  console.log(
    'PostgreSQL locale creation, database property menu, preview/apply, read-only capabilities and Chinese UI passed.',
  );
} finally {
  try {
    if (app && page)
      for (const target of created) {
        await call('connection.disconnect', { connectionId: target.connectionId, discard: true });
        await call('connection.connect', { connectionId: target.connectionId });
        if (
          (await call('database.list', { connectionId: target.connectionId })).includes(
            target.database,
          )
        )
          await call('query.execute', {
            connectionId: target.connectionId,
            sql: `DROP DATABASE ${target.database}`,
          });
      }
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
  }
}
