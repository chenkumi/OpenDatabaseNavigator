import { _electron as electron, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';

const dataDir = scratchDir('database-ui-iteration-');
const file = join(dataDir, 'ui.sqlite');
const db = new DatabaseSync(file);
db.exec(
  "CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT NOT NULL CHECK(name <> 'reject'),amount REAL DEFAULT 1.5,flag BOOLEAN,note TEXT); INSERT INTO items(name) VALUES ('one'),('two')",
);
db.close();
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', isolatedProfile()], env });
let page;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.getByRole('heading', { name: '探索資料，從這裡開始。' }).waitFor();
  const call = async (name, args = {}) => {
    const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
      name,
      args,
    });
    assert.ok(result.success, result.error);
    return result.data;
  };
  await call('settings.save', { ...(await call('settings.get')), language: 'en', pageSize: 100 });
  const connection = await call('connection.save', {
    name: 'UI SQLite',
    engine: 'sqlite',
    database: file,
  });
  const ref = { connectionId: connection.id, database: file, schema: 'main', table: 'items' };
  await page.getByRole('button', { name: /UI SQLite sqlite/ }).dblclick();
  await page.getByRole('button', { name: '▤ items', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('name row 1', { exact: true }).fill('saved');
  await page.getByLabel('name row 2', { exact: true }).fill('reject');
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Saved 1 rows; 1 rows remain.');
  await expect(page.locator('.cell-modified')).toHaveCount(1);
  const rows = (await call('data.select', { ...ref, limit: 10 })).rows;
  assert.deepEqual(
    rows.map((row) => row.name),
    ['saved', 'two'],
  );
  // A direct design request reuses the tab and preserves the pending row edit.
  await page.getByRole('button', { name: 'Object actions for items', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Design table', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Save or revert row edits');
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.getByLabel('name row 2', { exact: true })).toHaveValue('reject');
  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  await page.locator('.toast button').click();
  console.log('Partial save and direct-design draft protection passed.');

  await page.getByRole('button', { name: '+ Row', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced JSON', exact: true }).click();
  await page.getByLabel('Row JSON').fill('[]');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('JSON object');
  await page.getByLabel('Row JSON').fill('{"name":"reject","flag":true,"note":null}');
  await page.getByRole('button', { name: 'Use field form', exact: true }).click();
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('CHECK');
  await expect(page.getByLabel('Value for name', { exact: true })).toHaveValue('reject');
  await page.getByLabel('Value for name', { exact: true }).fill('three');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const inserted = (
    await call('data.select', {
      ...ref,
      filters: [{ column: 'name', operator: '=', value: 'three' }],
      limit: 10,
    })
  ).rows[0];
  assert.equal(inserted.amount, 1.5);
  // SQLite integers are serialized as strings by the precision-preserving adapter.
  assert.equal(inserted.flag, '1');
  assert.equal(inserted.note, null);
  console.log('Insert validation, failed draft retention, defaults, boolean and NULL passed.');

  await call('app.open_query', {
    connectionId: connection.id,
    database: file,
    sql: 'SELECT * FROM items ORDER BY id',
  });
  await page.getByRole('button', { name: '▶ Run SQL', exact: true }).click();
  await page.locator('.tab-content:visible .data-row').filter({ hasText: 'three' }).waitFor();
  for (const [width, height, theme] of [
    [1280, 720, 'light'],
    [1920, 1080, 'dark'],
  ]) {
    await call('settings.save', { ...(await call('settings.get')), theme });
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(width - 40);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(width);
    // Wait for theme transitions before capturing a hidden Electron compositor.
    await expect
      .poll(() =>
        page
          .locator('.tab-content:visible .data-head button')
          .first()
          .evaluate((node) => getComputedStyle(node).color),
      )
      .toBe(theme === 'light' ? 'rgb(27, 38, 53)' : 'rgb(228, 233, 238)');
    await expect
      .poll(() =>
        page
          .locator('.tab-content:visible .data-head')
          .first()
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      )
      .toBe(theme === 'light' ? 'rgb(232, 238, 245)' : 'rgb(40, 51, 60)');
    await captureDesktop(app, resolve(`.local/ui-iteration-${theme}.png`));
    const boxes = await page.locator('.tab-content:visible').evaluate((element) => {
      const panel =
        element.querySelector('[data-panel="results"]') ??
        element.querySelector('.query-results').parentElement;
      const result = element.querySelector('.query-results').getBoundingClientRect();
      const area = panel.getBoundingClientRect();
      const button = [...element.querySelectorAll('button')]
        .find((node) => node.textContent.includes('Run SQL'))
        .getBoundingClientRect();
      return {
        resultBottom: result.bottom,
        panelBottom: area.bottom,
        buttonRight: button.right,
        viewport: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.ok(Math.abs(boxes.resultBottom - boxes.panelBottom) < 2, JSON.stringify(boxes));
    assert.ok(boxes.buttonRight <= boxes.viewport);
    assert.equal(boxes.overflow, false);
  }
  console.log(
    JSON.stringify({
      success: true,
      verified: [
        'keyboard object opening',
        'partial-save status',
        'existing-tab draft protection',
        'JSON validation and insert retry',
        'default / boolean / NULL insertion',
        '1280×720 light and 1920×1080 dark layouts',
      ],
    }),
  );
} finally {
  await page
    ?.evaluate(async () => {
      const state = (await window.desktop.command('app.get_state')).data;
      for (const tab of state.tabs)
        if (tab.dirty)
          await window.desktop.command('workspace.update', { id: tab.id, patch: { dirty: false } });
    })
    .catch(() => {});
  await app.close();
}
