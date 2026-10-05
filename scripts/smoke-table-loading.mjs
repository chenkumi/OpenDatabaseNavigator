import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { scratchDir, isolatedProfile } from './support.mjs';

console.log('Starting table loading verification (controlled IPC, no database)...');
const progress = setInterval(() => console.log('Table loading verification is running...'), 5000);
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 0 },
});
let app;
try {
  await server.listen();
  const url = server.resolvedUrls.local[0] + 'scripts/fixtures/table-loading.html';
  const main = join(scratchDir('table-loading-'), 'main.cjs');
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');
    app.whenReady().then(()=>{const win=new BrowserWindow({width:1280,height:720,show:false});
    win.webContents.setBackgroundThrottling(false);win.loadURL(process.env.LOADING_FIXTURE_URL);});`,
    'utf8',
  );
  const env = { ...process.env, LOADING_FIXTURE_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [main, isolatedProfile()], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const status = page.locator('.table-loading-status');
  const operation = page.locator('.table-operation');
  const release = (empty = false, fail = false) =>
    page.evaluate(({ empty, fail }) => window.loadingTest.release(empty, fail), { empty, fail });
  async function pending(count = 1) {
    await expect.poll(() => page.evaluate(() => window.loadingTest.pending)).toBe(count);
    await expect(status).toBeVisible();
    await expect(operation).toHaveAttribute('aria-busy', 'true');
  }
  async function settled(rows = 2) {
    await expect(status).toHaveCount(0);
    await expect(operation).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.data-row')).toHaveCount(rows);
  }
  for (const language of ['en', 'zh-TW'])
    for (const theme of ['light', 'dark'])
      for (const [width, height] of [
        [1280, 720],
        [1920, 1080],
      ]) {
        console.log(`Checking loading ${language}/${theme}/${width}x${height}...`);
        await app.evaluate(
          ({ BrowserWindow }, { width, height }) =>
            BrowserWindow.getAllWindows()[0].setSize(width, height),
          { width, height },
        );
        await page.goto(`${url}?language=${language}&theme=${theme}`);
        await pending();
        await expect(status).toHaveText(language === 'en' ? 'Loading data…' : '資料讀取中…');
        await expect(status).toHaveAttribute('role', 'status');
        assert.equal(await status.evaluate((node) => !!node.closest('[aria-busy="true"]')), false);
        const metrics = await status.evaluate((node) => {
          const style = getComputedStyle(node),
            rect = node.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            font: style.fontSize,
            padding: style.paddingTop,
            spin: getComputedStyle(node.querySelector('svg')).animationName,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.ok(metrics.top >= 0 && metrics.bottom <= height && metrics.width > 100);
        assert.equal(metrics.font, '13px');
        assert.equal(metrics.padding, '16px');
        assert.notEqual(metrics.spin, 'none');
        assert.equal(metrics.overflow, false);
        await expect(
          page.getByRole('button', {
            name: language === 'en' ? 'Refresh' : '重新整理',
            exact: true,
          }),
        ).toBeDisabled();
        await expect(
          page.getByText(language === 'en' ? 'No rows to display' : '沒有可顯示的資料', {
            exact: true,
          }),
        ).toHaveCount(0);
        await release();
        await settled();
        const refresh = page.getByRole('button', {
          name: language === 'en' ? 'Refresh' : '重新整理',
          exact: true,
        });
        const before = await refresh.boundingBox();
        await refresh.click();
        await pending();
        await expect(page.locator('.data-row')).toHaveCount(2);
        const during = await refresh.boundingBox();
        assert.equal(before.height, during.height);
        assert.equal(before.width, during.width);
        await release();
        await settled();
      }
  console.log('Checking next/previous pages, failure, empty results and overlapping reads...');
  await page.goto(`${url}?language=en`);
  await pending();
  await release();
  await settled();
  for (const label of ['Next →', '← Previous']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await pending();
    await release();
    await settled();
  }
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await pending();
  await release(false, true);
  await settled();
  await expect(page.getByRole('alert')).toHaveText('Fixture read failed');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await pending();
  await release(true);
  await settled(0);
  await expect(page.getByText('No rows to display', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await pending();
  await page.evaluate(() => window.loadingTest.changed());
  await pending(2);
  await release();
  await pending(1); // Old completion must not hide the latest pending request.
  await release();
  await settled();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await pending();
  assert.equal(
    await status.locator('svg').evaluate((node) => getComputedStyle(node).animationName),
    'none',
  );
  await expect(status).toHaveText('Loading data…');
  await release();
  await settled();
  assert.deepEqual(errors, []);
  console.log(
    'Table loading passed: initial/refresh/paging, success/error/empty, latest-read state, reduced motion and eight language/theme/size combinations.',
  );
} finally {
  try {
    if (app) await app.close();
  } finally {
    await server.close();
    clearInterval(progress);
  }
}
