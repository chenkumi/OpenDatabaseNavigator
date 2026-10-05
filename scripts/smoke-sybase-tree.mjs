import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { scratchDir, isolatedProfile } from './support.mjs';

// Isolated Electron renderer using real components and mocked catalog IPC only.
// No credentials, native drivers, database connections or writes are used.
console.log('Starting owner tree renderer verification (mock catalogs only)...');
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 0 },
});
let app;
try {
  await server.listen();
  const url = server.resolvedUrls.local[0] + 'scripts/fixtures/sybase-tree.html';
  const main = join(scratchDir('ase-tree-'), 'main.cjs');
  await writeFile(
    main,
    `const { app, BrowserWindow } = require('electron');
    app.whenReady().then(() => { const win = new BrowserWindow({ width: 1280, height: 720, show: false });
    win.webContents.setBackgroundThrottling(false); win.loadURL(process.env.TREE_FIXTURE_URL); });`,
    'utf8',
  );
  const env = { ...process.env, TREE_FIXTURE_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [main, isolatedProfile()], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const owner = (name) => page.locator(`.owner-node[data-owner="${name}"]`);
  const group = (name, kind) => owner(name).locator(`.object-group[data-kind="${kind}"]`);
  await page.getByRole('button', { name: 'Database sample', exact: true }).click();
  await expect(page.locator('.owner-node')).toHaveCount(3);
  await expect(group('dbo', 'table').locator('.table-node')).toHaveText(['▤orders']);
  assert.equal(
    await page.evaluate(
      () =>
        window.treeTest.calls.filter(
          (call) => call.name === 'table.list' && call.args.schema === 'reporting',
        ).length,
    ),
    0,
  );
  await owner('reporting').getByRole('button', { name: 'Owner reporting', exact: true }).click();
  await expect(group('reporting', 'table').locator('.table-node')).toHaveText(['▤orders']);
  for (const name of ['dbo', 'reporting']) {
    for (const kind of ['view', 'index', 'trigger']) {
      await group(name, kind).locator('.tree-branch').click();
      await expect(group(name, kind).locator('.table-node')).toHaveCount(1);
    }
    await group(name, 'table').locator('.table-node').dblclick();
    await group(name, 'index').locator('.table-node').dblclick();
    await expect(group(name, 'table').locator('.create-object-entry')).toBeDisabled();
    await group(name, 'table')
      .locator('.object-group-heading .object-actions > button:last-child')
      .click();
    await expect(page.getByRole('menuitem', { name: 'Create table', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
  }
  const opened = await page.evaluate(() => window.treeTest.opened);
  assert.deepEqual(
    opened.map((item) => [item.schema, item.name]),
    [
      ['dbo', 'orders'],
      ['dbo', 'orders_idx'],
      ['reporting', 'orders'],
      ['reporting', 'orders_idx'],
    ],
  );
  await page.locator('input.search').fill('reporting.orders');
  await expect(group('dbo', 'table').locator('.table-node')).toHaveCount(0);
  await expect(group('reporting', 'table').locator('.table-node')).toHaveCount(1);
  await expect(group('dbo', 'index').locator('.table-node')).toHaveCount(0);
  await expect(group('reporting', 'index').locator('.table-node')).toHaveCount(1);
  await page.locator('input.search').fill('');
  await owner('empty').getByRole('button', { name: 'Owner empty', exact: true }).click();
  await expect(group('empty', 'table').locator('.navigation-empty')).toBeVisible();
  await page.evaluate(() => {
    window.treeTest.failOwner = 'reporting';
    window.treeTest.refresh();
  });
  await expect(owner('reporting').getByRole('alert')).toHaveText('Fixture catalog unavailable');
  await expect(group('dbo', 'table').locator('.table-node')).toHaveCount(1);
  await page.evaluate(() => {
    window.treeTest.failOwner = '';
    window.treeTest.extra = true;
    window.treeTest.refresh();
  });
  await expect(owner('reporting').getByRole('alert')).toHaveCount(0);
  await expect(group('dbo', 'table').locator('.table-node')).toHaveCount(2);

  await mkdir('.local/ase-tree', { recursive: true });
  for (const language of ['en', 'zh-TW'])
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of [
        [1280, 720],
        [1920, 1080],
      ]) {
        console.log(`Checking owner tree ${language}/${theme}/${width}x${height}...`);
        await page.setViewportSize({ width, height });
        await page.goto(`${url}?language=${language}&theme=${theme}`);
        await page.locator('.database-node > .object-actions .tree-branch').click();
        await expect(group('dbo', 'table').locator('.table-node')).toHaveCount(1);
        await expect(owner('dbo').locator('> button')).toHaveAttribute(
          'aria-label',
          language === 'en' ? 'Owner dbo' : '擁有者 dbo',
        );
        for (const heading of await owner('dbo').locator('.object-group-heading').all()) {
          const create = heading.locator('.create-object-entry');
          await expect(create).toBeDisabled();
          for (const button of [create, heading.locator('.object-actions > button:last-child')]) {
            assert.deepEqual(
              await button.evaluate((node) => {
                const style = getComputedStyle(node);
                return [node.offsetWidth, node.offsetHeight, style.padding, style.borderRadius];
              }),
              [28, 28, '0px', '6px'],
            );
          }
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `.local/ase-tree/${language}-${theme}-${width}.png` });
      }
    }
  for (const engine of ['mysql', 'postgres', 'sqlserver', 'sqlite']) {
    console.log(`Checking unchanged flat ${engine} navigation...`);
    await page.goto(`${url}?engine=${engine}`);
    await page.locator('.database-node > .object-actions .tree-branch').click();
    await expect(page.locator('.object-group-heading')).toHaveCount(4);
    await expect(page.locator('.owner-node')).toHaveCount(0);
    await expect(page.locator('.object-group[data-kind="table"] .table-node')).toHaveCount(2);
  }
  console.log(
    'Owner tree passed: owner isolation, duplicate names, lazy loading, scope, search, refresh/error recovery, empty owners, read-only actions, layout matrix and unchanged other engines. No ASE server used.',
  );
} finally {
  if (app) await app.close();
  await server.close();
}
