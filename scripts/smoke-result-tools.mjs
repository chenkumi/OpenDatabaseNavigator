import { _electron as electron, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { selectValue } from './ui-controls.mjs';
import { captureDesktop } from './capture-desktop.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomInt } from 'node:crypto';
import { scratchDir, isolatedProfile } from './support.mjs';

const dir = scratchDir('dw-result-tools-');
const file = join(dir, 'results.sqlite');
const payload =
  '{"precise":9223372036854775807,"decimal":1.123456789012345678901,"nested":{"label":"中文"}}';
const db = new DatabaseSync(file);
db.exec(
  'CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, score INTEGER, note TEXT, payload TEXT)',
);
const insert = db.prepare('INSERT INTO items VALUES(?,?,?,?,?)');
insert.run(1, 'alpha', 1, null, payload);
insert.run(2, 'beta', 2, '', '{}');
insert.run(3, 'alpha', 3, '中文,"quote"\r\nline', payload);
insert.run(4, 'alpha', 4, '長文字'.repeat(1000), 'not JSON');
db.close();
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: join(dir, 'app'),
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ args: ['.', isolatedProfile()], env });
let page;
const active = () => page.locator('.tab-content:visible');
async function call(name, args = {}) {
  const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
    name,
    args,
  });
  assert.ok(result.success, result.error);
  return result.data;
}
try {
  page = await desktop.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.locator('.app-shell').waitFor();
  await page.addStyleTag({
    content:
      '*,*::before,*::after {animation-duration:0s !important;transition-duration:0s !important;}',
  });
  await call('settings.save', { ...(await call('settings.get')), language: 'en', pageSize: 2 });
  const connection = await call('connection.save', {
    name: 'Result tools',
    engine: 'sqlite',
    database: file,
  });
  await page.locator(`.connection-main[data-connection-id="${connection.id}"]`).dblclick();
  await page.getByRole('button', { name: '▤ items', exact: true }).dblclick();
  await expect(active().getByLabel('name row 1', { exact: true })).toHaveValue('alpha');
  const tableTabId = (await call('app.get_state')).activeTab;

  await selectValue(page, active().getByLabel('Filter column', { exact: true }), 'name');
  await active().getByLabel('Filter value', { exact: true }).fill('alpha');
  await active().getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(active().getByLabel('id row 2', { exact: true })).toHaveValue('3');
  await active().getByRole('button', { name: 'Add condition', exact: true }).click();
  await selectValue(page, active().getByLabel('Filter column 2', { exact: true }), 'score');
  await selectValue(page, active().getByLabel('Filter operator 2', { exact: true }), '>=');
  await active().getByLabel('Filter value 2', { exact: true }).fill('3');
  await active().getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(active().getByLabel('id row 1', { exact: true })).toHaveValue('3');
  await expect(active().getByLabel('id row 2', { exact: true })).toHaveValue('4');
  await expect(active().getByRole('button', { name: 'Next →', exact: true })).toBeDisabled();
  await active().getByRole('button', { name: 'Add condition', exact: true }).click();
  await selectValue(page, active().getByLabel('Filter column 3', { exact: true }), 'note');
  await selectValue(page, active().getByLabel('Filter operator 3', { exact: true }), 'IS NULL');
  await expect(active().getByLabel('Filter value 3', { exact: true })).toBeDisabled();
  await active().getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(active().getByText('No rows to display', { exact: true })).toBeVisible();
  await expect(active().getByRole('button', { name: 'Export page', exact: true })).toBeDisabled();
  await active().getByLabel('Remove applied condition 3', { exact: true }).click();
  await expect(active().getByLabel('id row 1', { exact: true })).toHaveValue('3');
  await active().getByRole('button', { name: 'Clear filter', exact: true }).click();
  await expect(active().getByLabel('id row 1', { exact: true })).toHaveValue('1');

  // Inspect JSON from a horizontally scrolled column and preserve numeric literals.
  await active().getByLabel('View payload row 1', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Full cell value')).toHaveValue(/9223372036854775807/);
  await dialog.getByRole('button', { name: 'Raw text', exact: true }).click();
  await expect(dialog.getByLabel('Full cell value')).toHaveValue(payload);
  await dialog.getByRole('button', { name: 'Copy value', exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(payload);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await active().getByLabel('Select row 2', { exact: true }).check();
  await active().getByRole('button', { name: 'Copy selected rows', exact: true }).click();
  const selected = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(selected.includes('"beta"') && !selected.includes('"alpha"'));
  await active().getByRole('button', { name: 'Copy page', exact: true }).click();
  await expect
    .poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('"alpha"');

  await active().getByLabel('name row 1', { exact: true }).fill('draft,中文');
  await active().getByRole('button', { name: 'Copy page', exact: true }).click();
  await expect(active().getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await expect(active().getByRole('button', { name: 'Clear filter', exact: true })).toBeDisabled();
  await expect(
    active().getByRole('button', { name: 'Remove condition 1', exact: true }),
  ).toBeDisabled();
  await active().getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('checkbox', { name: 'payload', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await desktop.evaluate(({ dialog }, dir) => {
    dialog.showSaveDialog = async (options) => ({
      canceled: false,
      filePath: dir + '/' + options.defaultPath,
    });
  }, dir);
  await active().getByRole('button', { name: 'Export page', exact: true }).click();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(active().getByText('Current page exported', { exact: true })).toBeVisible();
  const exported = JSON.parse(await readFile(join(dir, 'query-results.json'), 'utf8'));
  assert.deepEqual(exported, [
    { id: '1', name: 'draft,中文', score: '1', note: null },
    { id: '2', name: 'beta', score: '2', note: '' },
  ]);
  await page.keyboard.press('Escape');
  await active().getByRole('button', { name: 'Export page', exact: true }).click();
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  await expect
    .poll(async () => readFile(join(dir, 'query-results.csv'), 'utf8').catch(() => ''))
    .toContain('"draft,中文"');
  assert.ok(!(await readFile(join(dir, 'query-results.csv'), 'utf8')).includes('payload'));
  const audit = await call('audit.list');
  const entry = audit.find((entry) => entry.command === 'file.result.save');
  assert.ok(entry && !entry.summary.includes('draft') && entry.summary.includes('bytes'));
  await page.keyboard.press('Escape');
  await desktop.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await active().getByRole('button', { name: 'Export page', exact: true }).click();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(active().getByText('Current page exported', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await active().getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(active().getByLabel('name row 1', { exact: true })).toHaveValue('alpha');

  // Query results also support selection; it must reset when a new page arrives.
  const tab = await call('app.open_query', {
    connectionId: connection.id,
    database: file,
    sql: 'SELECT * FROM items ORDER BY id',
    title: 'Results',
  });
  await call('query.read', {
    connectionId: connection.id,
    database: file,
    sql: tab.sql,
    showInApp: true,
    tabId: tab.id,
    limit: 2,
  });
  await expect(
    active().getByRole('button', { name: 'Copy selected rows', exact: true }),
  ).toBeDisabled();
  await active().getByLabel('Select row 1', { exact: true }).check();
  await expect(
    active().getByRole('button', { name: 'Copy selected rows', exact: true }),
  ).toBeEnabled();
  await active().getByRole('button', { name: 'Next result page →', exact: true }).click();
  await expect(
    active().getByRole('button', { name: 'Copy selected rows', exact: true }),
  ).toBeDisabled();

  await call('workspace.activate', { id: tableTabId });
  await selectValue(page, active().getByLabel('Filter column', { exact: true }), 'name');
  await active().getByLabel('Filter value', { exact: true }).fill('alpha');
  await active().getByRole('button', { name: 'Add condition', exact: true }).click();
  await selectValue(page, active().getByLabel('Filter column 2', { exact: true }), 'score');
  await selectValue(page, active().getByLabel('Filter operator 2', { exact: true }), '>=');
  await active().getByLabel('Filter value 2', { exact: true }).fill('3');
  await active().getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(active().getByLabel('id row 1', { exact: true })).toHaveValue('3');
  await mkdir(resolve('.local/result-tools'), { recursive: true });
  for (const language of ['en', 'zh-TW'])
    for (const theme of ['light', 'dark'])
      for (const size of [
        [1280, 720],
        [1920, 1080],
      ]) {
        await call('workspace.activate', { id: tab.id });
        await call('settings.save', { ...(await call('settings.get')), language, theme });
        await desktop.evaluate(
          ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
          size,
        );
        const viewLabel = language === 'en' ? 'View note row 2' : '查看第 2 列的 note';
        await active().getByLabel(viewLabel, { exact: true }).click();
        const viewer = page.getByRole('dialog');
        await expect(
          viewer.getByLabel(language === 'en' ? 'Full cell value' : '完整儲存格內容'),
        ).toHaveValue('長文字'.repeat(1000));
        const geometry = await viewer.evaluate((node) => {
          const rect = node.getBoundingClientRect(),
            text = node.querySelector('textarea').getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            textBottom: text.bottom,
            textHeight: text.height,
            width: innerWidth,
            height: innerHeight,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.ok(
          geometry.left >= 16 &&
            geometry.right <= geometry.width - 16 &&
            geometry.bottom <= geometry.height - 16 &&
            geometry.textBottom <= geometry.bottom &&
            geometry.textHeight >= 100 &&
            !geometry.overflow,
          JSON.stringify(geometry),
        );
        await captureDesktop(
          desktop,
          resolve(`.local/result-tools/viewer-${language}-${theme}-${size[0]}.png`),
        );
        await page.keyboard.press('Escape');
        await captureDesktop(
          desktop,
          resolve(`.local/result-tools/query-${language}-${theme}-${size[0]}.png`),
        );
        await call('workspace.activate', { id: tableTabId });
        await expect(active().getByLabel('id row 1', { exact: true })).toHaveValue('3');
        const metrics = await active().evaluate((node) => {
          const controls = [
            ...node.querySelectorAll('.table-filters button, .column-controls button'),
          ].filter((button) => button.getBoundingClientRect().width > 0);
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            controls: controls.map((button) => ({
              right: button.getBoundingClientRect().right,
              bottom: button.getBoundingClientRect().bottom,
              height: button.offsetHeight,
              size: button.dataset.size,
            })),
            width: innerWidth,
            height: innerHeight,
          };
        });
        assert.equal(metrics.overflow, false);
        for (const button of metrics.controls) {
          assert.ok(
            button.right <= metrics.width && button.bottom <= metrics.height,
            JSON.stringify(metrics),
          );
          assert.equal(
            button.height,
            button.size === 'icon-xs'
              ? 24
              : button.size === 'sm' || button.size === 'icon-sm'
                ? 28
                : 32,
          );
        }
        await captureDesktop(
          desktop,
          resolve(`.local/result-tools/filters-${language}-${theme}-${size[0]}.png`),
        );
      }
  assert.deepEqual(errors, []);
  const port = randomInt(30000, 50000);
  const settings = await call('settings.get');
  await call('settings.save', { ...settings, mcp: { ...settings.mcp, enabled: true, port } });
  const { token } = await call('mcp.token');
  const client = new Client({ name: 'Result Tools Agent', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 16);
    assert.ok(
      !tools.some(
        (tool) => tool.name === 'file.result.save' || tool.name === 'clipboard.result.copy',
      ),
    );
    for (const name of ['file.result.save', 'clipboard.result.copy'])
      assert.equal(
        (await client.callTool({ name, arguments: { content: 'blocked', format: 'json' } }))
          .isError,
        true,
      );
  } finally {
    await client.close();
  }
  console.log(
    JSON.stringify({
      success: true,
      verified: [
        'AND filters and individual removal',
        'NULL and empty results',
        'draft protection',
        'lossless JSON viewer and clipboard',
        'selected/page clipboard',
        'CSV/JSON native save, hidden columns, cancel and audit redaction',
        'query selection reset',
        'eight language/theme/size combinations',
        '16 MCP tools and desktop-only file/clipboard commands',
      ],
      directory: dir,
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
    .catch(() => undefined);
  await desktop.close();
}
