import { dismissConfirmation, selectValue, acceptConfirmation } from './ui-controls.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';

const dataDir = scratchDir('database-workspace-smoke-');
const mac = process.platform === 'darwin';
const modifier = mac ? 'Meta' : 'Control';
const environment = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete environment.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({
  executablePath: process.env.DATABASE_WORKSPACE_EXECUTABLE,
  args: process.env.DATABASE_WORKSPACE_EXECUTABLE ? [isolatedProfile()] : ['.', isolatedProfile()],
  env: environment,
  timeout: 30000,
});
const errors = [];
let page;
try {
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false);
      // WSLg can suspend compositor frames in hidden windows even when JS
      // throttling is disabled. Real pointer/drag checks need a visible surface.
      if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME) window.show();
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: '探索資料，從這裡開始。' }).waitFor();
  const menu = await desktop.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().items.map((item) => ({
      role: item.role,
      items: item.submenu?.items.map((child) => ({
        id: child.id,
        role: child.role,
        type: child.type,
      })),
    })),
  );
  assert.ok(!menu.some((item) => item.role === 'windowmenu'));
  const fileMenu = menu.find((item) => item.items?.some((child) => child.id === 'settings'));
  assert.deepEqual(
    fileMenu.items.map((item) => item.id || item.role || item.type),
    ['create-connection', 'settings', 'separator', 'minimize', 'close'],
  );
  await desktop.evaluate(({ Menu, BrowserWindow }) =>
    Menu.getApplicationMenu()
      .getMenuItemById('create-connection')
      .click(undefined, BrowserWindow.getAllWindows()[0]),
  );
  await page.locator('.modal:not(.settings)').waitFor();
  await page.locator('.modal header button').click();
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1000, 650),
  );
  const handle = page.getByRole('separator', { name: '調整連線清單寬度', exact: true });
  const leftBefore = (await page.locator('.sidebar').boundingBox()).width;
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.ok((await page.locator('.sidebar').boundingBox()).width > leftBefore + 5);
  const secondHandle = page.getByRole('separator', { name: '調整資料庫瀏覽器寬度', exact: true });
  const explorerBefore = (await page.locator('.database-sidebar').boundingBox()).width;
  await secondHandle.focus();
  await page.keyboard.press('ArrowRight');
  assert.ok((await page.locator('.database-sidebar').boundingBox()).width > explorerBefore);
  const layout = await page.evaluate(() => ({
    header: document.querySelector('.app-header').getBoundingClientRect().bottom,
    tabs: document.querySelector('.workspace-tabbar').getBoundingClientRect().top,
  }));
  assert.ok(Math.abs(layout.header - layout.tabs) <= 1);
  await desktop.evaluate(({ Menu, BrowserWindow }) =>
    Menu.getApplicationMenu()
      .getMenuItemById('settings')
      .click(undefined, BrowserWindow.getAllWindows()[0]),
  );
  await page.getByRole('dialog').waitFor();
  // Visibility precedes completion of the dialog's opening zoom animation.
  // Measure the settled layout so scrolling is the only variable below.
  await page.locator('.settings').evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const measure = () =>
    page.locator('.settings').evaluate((element) => ({
      header: element.querySelector('header').getBoundingClientRect().top,
      footer: element.querySelector('footer').getBoundingClientRect().bottom,
      height: element.getBoundingClientRect().height,
      viewport: innerHeight,
    }));
  const before = await measure();
  assert.ok(before.height <= before.viewport - 46);
  await page.locator('.settings-content').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const after = await measure();
  assert.equal(before.header, after.header);
  assert.equal(before.footer, after.footer);
  assert.ok(await page.locator('.settings-content').evaluate((element) => element.scrollTop > 0));
  await captureDesktop(desktop, resolve('.local/settings-layout.png'));
  await page.getByRole('button', { name: '儲存設定', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect
    .poll(() =>
      page.getByRole('dialog').evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 940),
  );
  await page.getByRole('button', { name: '⚙ 設定' }).click();
  await selectValue(page, page.getByLabel('語言', { exact: true }), 'en');
  await page.getByRole('button', { name: '儲存設定', exact: true }).click();
  await page.getByRole('heading', { name: 'A workspace for every question.' }).waitFor();
  await page.getByRole('button', { name: 'Create your first connection' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Smoke SQLite');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Please select a database file.');
  const messageGap = await page
    .locator('.connection-message')
    .evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        document.querySelector('.form-grid').getBoundingClientRect().bottom,
    );
  assert.ok(messageGap >= 16);
  for (const engine of ['mysql', 'postgres', 'sqlserver', 'redis']) {
    await selectValue(page, page.getByLabel('Database type', { exact: true }), engine);
    await page.getByLabel(engine === 'redis' ? 'DB index' : 'Database', { exact: true }).fill('');
    const saved = await page.evaluate(
      async (engine) =>
        window.desktop.command('connection.save', { name: `Optional ${engine}`, engine }),
      engine,
    );
    assert.equal(saved.success, true, saved.error);
    assert.equal(saved.data.database, '');
    await page.evaluate(
      async (id) => window.desktop.command('connection.delete', { connectionId: id }),
      saved.data.id,
    );
  }
  await selectValue(page, page.getByLabel('Database type', { exact: true }), 'sqlite');
  await page.getByLabel('Database file').fill(join(dataDir, 'smoke.sqlite'));
  await page.getByLabel('Group', { exact: true }).fill('Smoke group');
  await page.getByRole('checkbox', { name: 'Favorite', exact: true }).check();
  await page.getByLabel('Connection color', { exact: true }).fill('#ff5500');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.getByRole('heading', { name: 'Smoke group', exact: true }).waitFor();
  await page.getByPlaceholder('Search connections…').fill('no-matching-connection');
  assert.equal(await page.locator('.connection-main').count(), 0);
  await page.getByPlaceholder('Search connections…').fill('Smoke');
  await page.locator('.connection-main').waitFor();
  // The status colour comes from theme tokens now, so assert the state, not a colour code.
  assert.equal(
    await page.locator('.connection-main .connection-dot').getAttribute('data-state'),
    'disconnected',
  );
  assert.notEqual(
    await page
      .locator('.connection-main .connection-dot')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  assert.match(await page.locator('.connection-main strong').textContent(), /★/);
  await page.getByRole('button', { name: /Smoke SQLite sqlite/ }).dblclick();
  const connectionMenu = page.getByRole('button', {
    name: 'Connection actions for Smoke SQLite',
    exact: true,
  });
  await connectionMenu.click();
  await expect(page.getByRole('menuitem')).toHaveText([
    'Reconnect',
    'Disconnect',
    'Delete connection',
    'Settings',
  ]);
  assert.equal(await page.getByRole('menu').getByRole('separator').count(), 1);
  await page.keyboard.press('Escape');
  await expect(connectionMenu).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await connectionMenu.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Edit connection', exact: true })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Smoke SQLite');
  await page.locator('.modal').getByRole('button', { name: 'Close', exact: true }).click();
  await connectionMenu.click();
  await page.getByPlaceholder('Search connections…').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await connectionMenu.click();
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await connectionMenu.click();
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  const connectionId = await page.evaluate(
    async () => (await window.desktop.command('connection.list')).data[0].id,
  );
  const seed = await page.evaluate(async (id) => {
    const results = [];
    for (const sql of [
      'CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,score REAL DEFAULT 1.5,note TEXT)',
      "INSERT INTO users(name) VALUES ('Alice'), ('Bob')",
      'CREATE INDEX users_name_idx ON users(name)',
    ])
      results.push(await window.desktop.command('query.execute', { connectionId: id, sql }));
    return results;
  }, connectionId);
  assert.ok(
    seed.every((result) => result.success),
    JSON.stringify(seed),
  );
  await page.getByRole('button', { name: /Smoke SQLite sqlite/ }).dblclick();
  await page.getByRole('button', { name: 'Index', exact: true }).click();
  await page.locator('.metadata-object').filter({ hasText: 'users_name_idx' }).dblclick();
  await expect(
    page.locator('.tab-content:visible').getByLabel('SQL definition', { exact: true }),
  ).toHaveValue(/CREATE INDEX/);
  assert.equal(await page.locator('.database-tree .metadata-object pre').count(), 0);
  await page.getByRole('button', { name: 'Close users_name_idx', exact: true }).click();
  await page.getByRole('button', { name: 'Trigger', exact: true }).click();
  await page
    .locator('[data-kind="trigger"]')
    .getByText('No objects found.', { exact: true })
    .waitFor();
  await page.getByLabel('Search tables…', { exact: true }).fill('not-a-table');
  assert.equal(await page.getByRole('button', { name: '▤ users', exact: true }).count(), 0);
  await page.getByLabel('Search tables…', { exact: true }).fill('users');
  await page.getByRole('button', { name: 'Columns of users', exact: true }).click();
  await page.locator('.column-tree').getByText('◆ id', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const settings = (await window.desktop.command('settings.get')).data;
    await window.desktop.command('settings.save', { ...settings, pageSize: 1 });
  });
  await page.getByRole('button', { name: '▤ users', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Design table', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Structure editor', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await page.getByLabel('name row 1', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('name row 1', { exact: true }).inputValue(), 'Alice');
  await page.getByLabel('name row 1', { exact: true }).fill('Alice edited');
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('button', { name: 'Save changes' }).waitFor({ state: 'hidden' });
  await page.getByLabel('score row 1', { exact: true }).fill('2.75');
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await page.getByRole('button', { name: 'Set note row 1 to empty string', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('button', { name: 'Save changes' }).waitFor({ state: 'hidden' });
  const typed = await page.evaluate(
    async (id) =>
      (
        await window.desktop.command('query.execute', {
          connectionId: id,
          sql: 'SELECT score,typeof(score) AS storage,note FROM users WHERE id=1',
        })
      ).data.rows[0],
    connectionId,
  );
  assert.equal(typed.score, 2.75);
  assert.equal(typed.storage, 'real');
  assert.equal(typed.note, '');
  await page.getByRole('button', { name: 'Set note row 1 to NULL', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('button', { name: 'Save changes' }).waitFor({ state: 'hidden' });
  const nulled = await page.evaluate(
    async (id) =>
      (
        await window.desktop.command('query.execute', {
          connectionId: id,
          sql: 'SELECT note FROM users WHERE id=1',
        })
      ).data.rows[0],
    connectionId,
  );
  assert.equal(nulled.note, null);
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="name row 1"]')?.value === 'Bob',
  );
  await page.getByRole('button', { name: '← Previous', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="name row 1"]')?.value === 'Alice edited',
  );
  await page.getByRole('button', { name: '+ Row', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await selectValue(page, page.getByLabel('Value mode for name', { exact: true }), 'value');
  await page.getByLabel('Value for name', { exact: true }).fill('Charlie');
  await selectValue(page, page.getByLabel('Value mode for note', { exact: true }), 'value');
  // Empty text is explicit; score and id remain omitted to use server defaults.
  await page.getByRole('button', { name: 'Advanced JSON', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Row JSON').inputValue()), {
    name: 'Charlie',
    note: '',
  });
  await page.getByRole('button', { name: 'Use field form', exact: true }).click();
  await expect(page.getByLabel('Value for name', { exact: true })).toHaveValue('Charlie');
  await captureDesktop(desktop, resolve('.local/insert-row-form.png'));
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  // A click only submits: InsertRowDialog closes after data.insert and load().
  // Wait for unmount (including its focus trap), then the table's refresh, so
  // dialog focus restoration cannot steal the filter's ArrowDown below.
  await expect(page.locator('.insert-row-dialog')).toHaveCount(0);
  await expect(page.locator('.table-view .table-operation')).toHaveAttribute('aria-busy', 'false');
  await selectValue(page, page.getByLabel('Filter column', { exact: true }), 'name');
  await page.getByLabel('Filter value', { exact: true }).fill('Charlie');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="name row 1"]')?.value === 'Charlie',
  );
  await page.getByRole('checkbox', { name: 'Select row 1', exact: true }).check();
  await page.locator('.table-view').getByRole('button', { name: 'Delete', exact: true }).click();
  await acceptConfirmation(page);
  await page.getByText('No rows to display', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
  await expect(page.getByText('Applied filter:', { exact: false })).toHaveCount(0);
  await page.getByLabel('name row 1', { exact: true }).waitFor();
  await page.getByLabel('name row 1', { exact: true }).fill('Unsaved SQL draft');
  await page.getByRole('button', { name: '◷ History', exact: true }).click();
  await page.getByRole('button', { name: '← Workspace', exact: true }).click();
  assert.equal(
    await page.getByLabel('name row 1', { exact: true }).inputValue(),
    'Unsaved SQL draft',
  );
  await page.getByRole('button', { name: 'Close users', exact: true }).click();
  await dismissConfirmation(page);
  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="name row 1"]')?.value === 'Alice edited',
  );
  await page.locator('.data-head').getByRole('button', { name: 'name', exact: true }).click();
  await page.locator('.data-head').getByRole('button', { name: 'name', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="name row 1"]')?.value === 'Bob',
  );
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Columns', exact: true })
    .getByRole('checkbox', { name: 'note', exact: true })
    .uncheck();
  assert.equal(await page.getByLabel('note row 1', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('button', { name: 'Hide connections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show connections', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show connections', exact: true }).click();
  await page.getByRole('button', { name: '＋ SQL query' }).click();
  await page.locator('.monaco-editor').waitFor();
  await expect(page.getByRole('button', { name: '▶ Run SQL', exact: true })).toBeDisabled();
  const querySeparator = page.getByRole('separator', {
    name: 'Resize SQL editor and results',
    exact: true,
  });
  const editorHeight = (await page.locator('.monaco-editor').boundingBox()).height;
  await querySeparator.focus();
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => (await page.locator('.monaco-editor').boundingBox()).height)
    .toBeGreaterThan(editorHeight);
  await expect(page.getByLabel('Workspace scope', { exact: true }).last()).toContainText(
    'Smoke SQLite',
  );
  const beforeDrag = await page.locator('.tab > button:first-child').allTextContents();
  await page.locator('.tab').last().dragTo(page.locator('.tab').first());
  await page.waitForFunction(
    (expected) => document.querySelector('.tab > button')?.textContent === expected,
    beforeDrag.at(-1),
  );
  await page.evaluate(async () => {
    const state = (await window.desktop.command('app.get_state')).data;
    await window.desktop.command('workspace.update', {
      id: state.activeTab,
      patch: { sql: 'SELECT * FROM us' },
    });
  });
  await page.locator('.tab-content:visible .monaco-editor .view-line').first().click();
  await page.keyboard.press(mac ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.press('Control+Space');
  await page
    .locator('.suggest-widget.visible')
    .getByText('users', { exact: true })
    .first()
    .waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${modifier}+f`);
  await page.getByPlaceholder('Find', { exact: true }).fill('SELECT');
  await page.keyboard.press('Escape');
  await page.locator('.tab-content:visible .monaco-editor .view-line').first().click();
  await page.keyboard.press(mac ? 'Meta+Alt+f' : 'Control+h');
  await page.getByPlaceholder('Replace', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const state = (await window.desktop.command('app.get_state')).data;
    await window.desktop.command('workspace.update', {
      id: state.activeTab,
      patch: { sql: 'SELECT * FROM users ORDER BY id' },
    });
  });
  await page.getByRole('button', { name: '▶ Run SQL' }).click();
  await page.getByText('Alice edited', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next result page →', exact: true }).click();
  await page.getByText('Bob', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const state = (await window.desktop.command('app.get_state')).data;
    await window.desktop.command('workspace.update', {
      id: state.activeTab,
      patch: { sql: 'SELECT 21 AS selected_value;\nSELECT 42 AS ignored_value;' },
    });
  });
  await page.locator('.tab-content:visible .monaco-editor .view-line').first().click();
  await page.keyboard.press(mac ? 'Meta+ArrowUp' : 'Control+Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.getByRole('button', { name: '▶ Run selection', exact: true }).click();
  await page.locator('.tab-content:visible .data-row').filter({ hasText: '21' }).waitFor();
  const selectedSql = await page.evaluate(
    async () =>
      (await window.desktop.command('history.list', { search: 'selected_value' })).data[0].sql,
  );
  assert.equal(selectedSql.trim(), 'SELECT 21 AS selected_value;');
  await page.locator('.tab-content:visible .monaco-editor .view-line').first().click();
  await page.keyboard.press(mac ? 'Meta+ArrowUp' : 'Control+Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press(`${modifier}+Enter`);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            async () =>
              (await window.desktop.command('history.list', { search: 'selected_value' })).data,
          )
        ).length,
    )
    .toBe(2);
  const executions = await page.evaluate(
    async () => (await window.desktop.command('history.list', { search: 'selected_value' })).data,
  );
  assert.equal(executions[0].sql, executions[1].sql);
  await page.getByRole('button', { name: '◷ History', exact: true }).click();
  await page
    .locator('.log-entry')
    .filter({ hasText: 'SELECT * FROM users ORDER BY id' })
    .first()
    .getByRole('button', { name: 'Re-run', exact: true })
    .click();
  await page.getByText('Alice edited', { exact: true }).waitFor();
  await page.locator('.tab.active').click({ button: 'right' });
  await expect(page.locator('.tab .tab-actions')).toHaveCount(0);
  assert.ok((await page.locator('.tab').count()) > 1);
  await page.getByRole('menuitem', { name: 'Close other tabs', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1);
  assert.equal(await page.locator('.tab').count(), 1);
  await mkdir(resolve('.local'), { recursive: true });
  await captureDesktop(desktop, resolve('.local/desktop-smoke.png'));
  await page.getByRole('button', { name: '⚙ Settings' }).click();
  await selectValue(page, page.getByLabel('Language', { exact: true }), 'zh-TW');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('button', { name: '▶ 執行 SQL' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '⚙ 設定' }).waitFor();
  await page.locator('.tab-content:visible .monaco-editor .view-line').first().waitFor();
  await captureDesktop(desktop, resolve('.local/desktop-zh-TW.png'));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        success: true,
        dataDir,
        screenshot: '.local/desktop-smoke.png',
        verified: [
          'Electron launch',
          'resizable columns via mouse and keyboard',
          'Index detail tab and empty Trigger group',
          'separate database explorer and table search',
          'native File menu actions and no Window menu',
          'settings fixed header/footer, content scrolling, focus loop and Escape',
          'tabs directly below global toolbar at minimum window size',
          'isolated preload IPC',
          'SQLite connection form',
          'schema explorer',
          'editable virtualized table',
          'numeric value / empty string / SQL NULL roundtrip',
          'English and Traditional Chinese settings persistence',
          'connection group / favorite / color / search / reconnect',
          'insert / filter / delete / sort / hide column',
          'dirty edit survives History and rejected close',
          'SQL editor',
          'tab drag reorder, schema autocomplete, find / replace',
          'shared query result',
          'Explorer columns',
          'table pagination',
          'opaque SQL cursor pagination',
          'Run button and Ctrl+Enter execute identical selected SQL',
          'object context menu opens structure',
          'insert field form and JSON roundtrip',
          'clear filter, connection collapse and query split resize',
          'tab menu does not close tabs until an action is chosen',
          'history re-run',
          'close other tabs',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  await captureDesktop(desktop, resolve('.local/desktop-smoke-failure.png')).catch(() => {});
  throw error;
} finally {
  // Only this isolated test profile is cleaned; avoid blocking failed tests on
  // Electron's native unsaved-work dialog.
  await page
    ?.evaluate(async () => {
      const result = await window.desktop.command('app.get_state');
      for (const tab of result.data.tabs)
        if (tab.dirty)
          await window.desktop.command('workspace.update', { id: tab.id, patch: { dirty: false } });
    })
    .catch(() => {});
  await desktop.close();
}
