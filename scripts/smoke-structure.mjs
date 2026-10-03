import { dismissConfirmation, acceptConfirmation } from './ui-controls.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';
const dataDir = scratchDir('database-structure-');
const file = join(dataDir, 'structure.sqlite');
const db = new DatabaseSync(file);
db.exec(
  "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, score INTEGER); INSERT INTO items VALUES(1,'one',7),(2,'two',NULL); CREATE INDEX item_names ON items(name); CREATE VIEW item_view AS SELECT id,name FROM items",
);
db.close();
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
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  const connection = await call('connection.save', {
    name: 'Structure SQLite',
    engine: 'sqlite',
    database: file,
  });
  const ref = { connectionId: connection.id, database: file, schema: 'main', table: 'items' };
  await page.getByRole('button', { name: /Structure SQLite sqlite/ }).dblclick();
  await page.getByRole('button', { name: '▤ items', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Design table', exact: true }).click();
  const active = () => page.locator('.tab-content:visible');
  const editor = () => active().getByRole('region', { name: 'Structure editor', exact: true });
  const apply = async () => {
    await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
    await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
    await editor().getByRole('status').filter({ hasText: 'Changes applied.' }).waitFor();
  };
  await expect(editor()).toBeVisible();
  const layout = await editor().evaluate((root) => {
    const tabs = root.querySelector('.designer-tabs').getBoundingClientRect();
    const actions = root.querySelector('.designer-actions').getBoundingClientRect();
    const grid = root.querySelector('.designer-grid').getBoundingClientRect();
    return {
      tabsBottom: tabs.bottom,
      actionsTop: actions.top,
      actionsBottom: actions.bottom,
      gridTop: grid.top,
      actionsHeight: actions.height,
    };
  });
  assert.ok(
    layout.actionsTop >= layout.tabsBottom - 1 && layout.gridTop >= layout.actionsBottom - 1,
    'Designer tabs, toolbar and grid must stack vertically',
  );
  assert.ok(layout.actionsHeight < 90, 'Designer toolbar must remain a compact horizontal row');
  await editor().getByRole('button', { name: 'Select column score', exact: true }).focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(editor().getByLabel('Column name', { exact: true })).toHaveValue('score');
  const gridTop = () =>
    editor().evaluate(
      (root) =>
        root.querySelector('.designer-grid').getBoundingClientRect().top -
        root.getBoundingClientRect().top,
    );
  const initialGridTop = await gridTop();
  await expect(editor().getByLabel('Length / precision', { exact: true })).toBeDisabled();
  await editor().getByLabel('Data type', { exact: true }).fill('TE');
  await expect(page.getByRole('option', { name: 'TEXT', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'JSONB', exact: true })).toHaveCount(0);
  await editor().getByLabel('Data type', { exact: true }).fill('INTEGER');
  await page.keyboard.press('Escape');
  await editor().getByLabel('Data type', { exact: true }).fill('REAL');
  await page.keyboard.press('Escape');
  assert.ok(
    Math.abs((await gridTop()) - initialGridTop) < 1,
    'Pending notice must not move the grid',
  );
  const pendingNotice = editor().getByRole('button', {
    name: 'Pending structure change',
    exact: true,
  });
  await pendingNotice.click();
  const changeDetails = page.getByRole('dialog', {
    name: 'Structure change details',
    exact: true,
  });
  await expect(changeDetails).toBeVisible();
  await expect(changeDetails).toContainText('INTEGER');
  await expect(changeDetails).toContainText('REAL');
  await captureDesktop(app, resolve('.local/structure-notice.png'));
  assert.ok(
    Math.abs((await gridTop()) - initialGridTop) < 1,
    'Opening details must not move the grid',
  );
  await page.keyboard.press('Escape');
  await expect(changeDetails).not.toBeVisible();
  await pendingNotice.click();
  await changeDetails.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(pendingNotice).toBeFocused();
  await pendingNotice.click();
  await editor().getByRole('button', { name: 'Select column score', exact: true }).click();
  await expect(changeDetails).not.toBeVisible();
  await expect(editor().getByLabel('Column name', { exact: true })).toBeEnabled();
  assert.ok(
    Math.abs((await gridTop()) - initialGridTop) < 1,
    'Clearing the notice must not move the grid',
  );
  assert.equal(
    (await call('structure.describe', ref)).columns.find((c) => c.name === 'score').type,
    'INTEGER',
  );
  await editor().getByLabel('Data type', { exact: true }).fill('INTEGER');
  await page.keyboard.press('Escape');
  await expect(
    editor().getByRole('button', { name: 'Preview changes', exact: true }),
  ).toBeDisabled();
  await expect(editor().getByLabel('Column name', { exact: true })).toBeEnabled();
  await editor().getByLabel('Data type', { exact: true }).fill('REAL');
  await page.keyboard.press('Escape');
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await captureDesktop(app, resolve('.local/table-designer.png'));
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await apply();
  assert.equal(
    (await call('structure.describe', ref)).columns.find((c) => c.name === 'score').type,
    'REAL',
  );
  await editor().getByRole('button', { name: 'Add column', exact: true }).click();
  await editor().getByLabel('Column name', { exact: true }).fill('notes');
  await editor().getByLabel('Default SQL expression', { exact: true }).fill("'added'");
  await apply();
  await active().getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(active().getByRole('textbox', { name: 'notes row 1', exact: true })).toHaveValue(
    'added',
  );
  await active().getByRole('tab', { name: 'Structure', exact: true }).click();
  await editor().getByRole('button', { name: 'Select column notes', exact: true }).click();
  await editor().getByLabel('Default SQL expression', { exact: true }).fill("'draft'");
  await expect(page.locator('.tab').first()).toContainText('•');
  await page.getByRole('button', { name: 'Close items', exact: true }).click();
  await dismissConfirmation(page);
  assert.equal((await call('app.get_state')).tabs.length, 1);
  await page.reload();
  await expect(editor().getByLabel('Default SQL expression', { exact: true })).toHaveValue(
    "'draft'",
  );
  await apply();
  await editor().getByRole('button', { name: 'Select column score', exact: true }).click();
  await editor().getByRole('checkbox', { name: 'Allow NULL', exact: true }).uncheck();
  // A NULL draft must not lock names/types, including after restoring the workspace.
  const savedTab = (await call('app.get_state')).tabs[0];
  await call('workspace.update', {
    id: savedTab.id,
    patch: {
      sql: JSON.stringify({ action: 'nullable', column: 'score', nullable: false }),
    },
  });
  await page.reload();
  await expect(
    editor().getByRole('checkbox', { name: 'Allow NULL', exact: true }),
  ).not.toBeChecked();
  await editor().getByLabel('Column name', { exact: true }).fill('points');
  await editor().getByLabel('Data type', { exact: true }).fill('NUMERIC');
  await page.keyboard.press('Escape');
  await editor().getByRole('button', { name: 'Select column notes', exact: true }).click();
  await editor().getByLabel('Default SQL expression', { exact: true }).fill("'combined'");
  await editor().getByRole('button', { name: 'Select column score', exact: true }).click();
  await expect(editor().getByLabel('Column name', { exact: true })).toHaveValue('points');
  await expect(editor().getByLabel('Data type', { exact: true })).toHaveValue('NUMERIC');
  await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(editor().getByRole('alert')).toBeVisible();
  assert.equal(
    (await call('structure.describe', ref)).columns.find((c) => c.name === 'score').nullable,
    true,
  );
  assert.equal(
    (await call('structure.describe', ref)).columns.find((c) => c.name === 'score').type,
    'REAL',
  );
  // Reverting just NULL preserves the other edits and permits the combined apply.
  await editor().getByRole('checkbox', { name: 'Allow NULL', exact: true }).check();
  await expect(editor().getByLabel('Column name', { exact: true })).toHaveValue('points');
  await apply();
  assert.equal(
    (await call('structure.describe', ref)).columns.find((c) => c.name === 'points').type,
    'NUMERIC',
  );
  assert.equal(
    (await call('structure.describe', ref)).columns.find((c) => c.name === 'notes').defaultSql,
    "'combined'",
  );
  await editor().getByLabel('Column name', { exact: true }).fill('score');
  await apply();
  await editor().getByRole('checkbox', { name: 'Allow NULL', exact: true }).uncheck();
  await editor().getByRole('button', { name: 'Revert changes', exact: true }).click();
  await acceptConfirmation(page);
  await editor().getByRole('button', { name: 'Select column notes', exact: true }).click();
  await editor().getByLabel('Column name', { exact: true }).fill('memo');
  await apply();
  await expect(
    editor().getByRole('button', { name: 'Select column memo', exact: true }),
  ).toBeVisible();
  await editor().getByRole('button', { name: 'Drop column', exact: true }).click();
  await expect(
    editor().locator('.column-deleted').getByLabel('Column name · memo', { exact: true }),
  ).toHaveValue('memo');
  await apply();
  assert.ok(!(await call('structure.describe', ref)).columns.some((c) => c.name === 'memo'));
  // Edit directly in the grid, with independent precision and scale and inline PK/NULL.
  await editor().getByLabel('Data type · name', { exact: true }).fill('VARCHAR');
  await page.keyboard.press('Escape');
  await editor().getByLabel('Length / precision · name', { exact: true }).fill('80');
  await editor().getByLabel('Data type · score', { exact: true }).fill('DECIMAL');
  await page.keyboard.press('Escape');
  await editor().getByLabel('Length / precision · score', { exact: true }).fill('12');
  await editor().getByLabel('Decimal places · score', { exact: true }).fill('2');
  await editor().getByRole('checkbox', { name: 'Allow NULL for name', exact: true }).uncheck();
  await editor().getByRole('checkbox', { name: 'Primary key column name', exact: true }).check();
  await editor().getByRole('checkbox', { name: 'Primary key column name', exact: true }).uncheck();
  await expect(
    editor().getByRole('checkbox', { name: 'Allow NULL for name', exact: true }),
  ).not.toBeChecked();
  await editor().getByRole('checkbox', { name: 'Primary key column name', exact: true }).check();
  await expect(
    editor().getByRole('checkbox', { name: 'Allow NULL for name', exact: true }),
  ).not.toBeChecked();
  await expect(
    editor().getByRole('checkbox', { name: 'Allow NULL for name', exact: true }),
  ).toBeDisabled();
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await captureDesktop(app, resolve('.local/table-designer-grid.png'));
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await apply();
  const designed = await call('structure.describe', ref);
  assert.equal(designed.columns.find((c) => c.name === 'name').type, 'VARCHAR(80)');
  assert.equal(designed.columns.find((c) => c.name === 'score').type, 'DECIMAL(12,2)');
  assert.deepEqual(
    designed.columns.filter((c) => c.primaryKey).map((c) => c.name),
    ['id', 'name'],
  );
  await editor().getByRole('checkbox', { name: 'Primary key column name', exact: true }).uncheck();
  await editor().getByRole('checkbox', { name: 'Allow NULL for name', exact: true }).check();
  await apply();
  await editor().getByRole('tab', { name: 'Fields', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(editor().getByRole('tab', { name: 'Primary key', exact: true })).toBeFocused();
  await editor().getByRole('checkbox', { name: 'Primary key column name', exact: true }).check();
  await apply();
  assert.deepEqual(
    (await call('structure.describe', ref)).columns.filter((c) => c.primaryKey).map((c) => c.name),
    ['id', 'name'],
  );
  await editor().getByRole('checkbox', { name: 'Primary key column name', exact: true }).uncheck();
  await apply();
  await editor().getByRole('tab', { name: 'Fields', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 720));
  await call('settings.save', {
    ...(await call('settings.get')),
    theme: 'light',
    language: 'zh-TW',
  });
  await captureDesktop(app, resolve('.local/table-designer-light.png'));
  await call('settings.save', { ...(await call('settings.get')), theme: 'dark', language: 'en' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  const viewRef = { ...ref, table: 'item_view' };
  await page.getByRole('button', { name: /Structure SQLite sqlite/ }).dblclick();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: '◈ item_view', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Design view', exact: true }).click();
  await expect(page.locator('.tab.active')).toContainText('item_view');
  await active().getByRole('tab', { name: 'Structure', exact: true }).click();
  await expect(editor().getByLabel('View definition', { exact: true })).toHaveValue(/CREATE VIEW/);
  const sql = 'CREATE VIEW item_view AS SELECT id,name FROM items WHERE id=1';
  await editor().getByLabel('View definition', { exact: true }).fill(sql);
  await apply();
  assert.equal(
    (await call('query.read', { connectionId: connection.id, sql: 'SELECT * FROM item_view' }))
      .rowCount,
    1,
  );
  await active().getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(active().locator('.data-row').getByText('one', { exact: true })).toBeVisible();
  await expect(active().locator('.data-row').getByText('two', { exact: true })).toHaveCount(0);
  await active().getByRole('tab', { name: 'Structure', exact: true }).click();
  await editor().getByLabel('View definition', { exact: true }).fill(sql.replace('id=1', 'id=2'));
  const current = await call('structure.describe', viewRef);
  await call('structure.apply', {
    ...viewRef,
    version: current.version,
    change: { action: 'view', sql: sql.replace('id=1', 'id>0') },
  });
  await editor().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await editor().getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(editor().getByRole('alert')).toContainText('changed since');
  await editor().getByRole('button', { name: 'Refresh structure', exact: true }).click();
  await acceptConfirmation(page);
  await expect(editor().getByLabel('View definition', { exact: true })).toHaveValue(/id>0/);
  await page.getByRole('button', { name: /Structure SQLite sqlite/ }).dblclick();
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await captureDesktop(app, resolve('.local/structure-editor.png'));
  // Accept the real native shutdown confirmation, then inspect persisted drafts.
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  await editor().getByLabel('View definition', { exact: true }).fill(sql.replace('id=1', 'id=2'));
  await expect(page.locator('.tab.active')).toContainText('•');
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 1;
    setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0);
  });
  await closed;
  const persisted = JSON.parse(await readFile(join(dataDir, 'workspace.json'), 'utf8'));
  assert.ok(persisted.tabs.every((tab) => !tab.objectVersion && !tab.dirty));
  console.log(
    JSON.stringify(
      {
        success: true,
        verified: [
          'Right-click Design table and direct column properties',
          'Draft grid, per-property reset and combined column edits',
          'Restored legacy NULL draft keeps name/type editable',
          'Engine type suggestions, separate precision/scale and inline NULL/composite PK',
          'Toolbar change notice and floating before/after details without layout shift',
          'Table type/add/default/rename/drop and primary-key editing',
          'SQL preview and apply',
          'data columns refresh',
          'dirty close confirmation and draft restoration',
          'failed rebuild preserves data and draft',
          'View editing and data refresh',
          'stale view conflict detection',
          'native discard clears persisted structure drafts',
        ],
        screenshot: '.local/structure-editor.png',
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  await captureDesktop(app, resolve('.local/structure-editor-failure.png')).catch(() => {});
  const page = await app.firstWindow();
  console.error(
    await page.locator('.tab-content').evaluateAll((nodes) =>
      nodes.map((node) => ({
        display: getComputedStyle(node).display,
        height: node.getBoundingClientRect().height,
        width: node.getBoundingClientRect().width,
        text: node.textContent?.slice(0, 200),
      })),
    ),
  );
  throw error;
} finally {
  // A failed assertion must not hang on the app's unsaved-changes shutdown prompt.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
