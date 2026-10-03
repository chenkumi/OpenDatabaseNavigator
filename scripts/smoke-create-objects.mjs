import { selectValue } from './ui-controls.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { scratchDir } from './support.mjs';
const dataDir = scratchDir('create-objects-smoke-');
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({
  args: ['.', '--user-data-dir=' + join(dataDir, 'chromium')],
  env,
});
try {
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(20000);
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setBackgroundThrottling(false);
  });
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
  const connection = await call('connection.save', {
    name: 'Create SQLite',
    engine: 'sqlite',
    database: join(dataDir, 'objects.sqlite'),
  });
  await page.locator(`[data-connection-id="${connection.id}"]`).dblclick();
  const form = page.locator('.create-object-view:visible');
  await page.getByRole('button', { name: 'Create table', exact: true }).click();
  await expect(form).toHaveAttribute('aria-label', 'Create table');
  await form.getByLabel('Object name', { exact: true }).fill('created_table');
  await form.getByRole('button', { name: 'Add column', exact: true }).click();
  await form.getByLabel('Column name 2', { exact: true }).fill('message');
  const workspace = await call('app.get_state');
  const dirtyId = workspace.activeTab;
  const rejected = await page.evaluate(
    (id) => window.desktop.command('workspace.close', { id }),
    dirtyId,
  );
  assert.equal(rejected.success, false);
  await page.reload();
  await expect(form.getByLabel('Object name', { exact: true })).toHaveValue('created_table');
  await expect(form.getByLabel('Column name 2', { exact: true })).toHaveValue('message');
  let creationCount = 0;
  const create = async () => {
    await form.getByRole('button', { name: 'Preview SQL', exact: true }).click();
    await expect(form.locator('.create-preview pre')).toBeVisible();
    await mkdir('.local', { recursive: true });
    await captureDesktop(
      desktop,
      creationCount++ === 0 ? '.local/create-table-form.png' : '.local/create-object-form.png',
    );
    await form.getByRole('button', { name: 'Create object', exact: true }).click();
    await expect(form.getByRole('status')).toHaveText('Object created.');
  };
  await create();
  await expect(
    page.locator('.database-sidebar .table-node').filter({ hasText: 'created_table' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create view', exact: true }).click();
  await expect(form).toHaveAttribute('aria-label', 'Create view');
  await form.getByLabel('Object name', { exact: true }).fill('created_view');
  await form
    .getByLabel('SELECT query', { exact: true })
    .fill('SELECT id,message FROM main.created_table');
  await create();
  await page.getByRole('button', { name: 'Create index', exact: true }).click();
  await expect(form).toHaveAttribute('aria-label', 'Create index');
  await form.getByLabel('Object name', { exact: true }).fill('created_index');
  await selectValue(page, form.getByLabel('Target table / view', { exact: true }), 'created_table');
  await form.getByRole('checkbox', { name: 'message', exact: true }).check();
  await selectValue(page, form.getByLabel('Index type', { exact: true }), 'UNIQUE');
  await create();
  await page.getByRole('button', { name: 'Trigger', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Create trigger', exact: true }).click();
  await expect(form).toHaveAttribute('aria-label', 'Create trigger');
  await form.getByLabel('Object name', { exact: true }).fill('created_trigger');
  await selectValue(page, form.getByLabel('Target table / view', { exact: true }), 'created_table');
  await form
    .getByLabel('Trigger body', { exact: true })
    .fill("UPDATE created_table SET message='trigger fired' WHERE id=NEW.id;");
  await create();
  await call('query.execute', {
    connectionId: connection.id,
    sql: 'INSERT INTO created_table (id) VALUES (1)',
  });
  const result = await call('query.read', {
    connectionId: connection.id,
    sql: 'SELECT * FROM created_view',
  });
  assert.equal(result.rows[0].message, 'trigger fired');
  const objects = await call('trigger.list', { connectionId: connection.id });
  assert.ok(objects.some((item) => item.name === 'created_trigger'));
  await form.getByRole('button', { name: 'Open created object', exact: true }).click();
  await page.locator('.database-object-view:visible textarea').waitFor();
  // Context-menu deletion: cancel keeps the object; dirty tabs require explicit discard.
  for (const [kind, name] of [
    ['trigger', 'created_trigger'],
    ['index', 'created_index'],
    ['view', 'created_view'],
    ['table', 'created_table'],
  ]) {
    const group = page.locator(`.object-group[data-kind="${kind}"]`);
    const heading = group.getByRole('button', {
      name: kind[0].toUpperCase() + kind.slice(1),
      exact: true,
    });
    if ((await heading.getAttribute('aria-expanded')) !== 'true') await heading.click();
    const node = group.locator('.table-node').filter({ hasText: name });
    await node.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete ' + kind, exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Delete ' + kind, exact: true });
    await expect(dialog.locator('pre')).toContainText('DROP ' + kind.toUpperCase());
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(node).toBeVisible();
    if (kind === 'trigger') {
      const state = await call('app.get_state');
      const tab = state.tabs.find((tab) => tab.type === 'trigger' && tab.objectName === name);
      await call('workspace.update', { id: tab.id, patch: { dirty: true } });
    }
    await node.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete ' + kind, exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Delete ' + kind, exact: true });
    await expect(dialog.locator('pre')).toBeVisible();
    if (kind === 'trigger') {
      await expect(
        dialog.getByRole('button', { name: 'Delete object', exact: true }),
      ).toBeDisabled();
      await dialog
        .getByRole('checkbox', { name: 'Discard unsaved changes in these tabs', exact: true })
        .check();
      await captureDesktop(desktop, '.local/delete-object-confirm.png');
    }
    await dialog.getByRole('button', { name: 'Delete object', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // The group may collapse when metadata is refreshed, verify the authoritative list too.
    const items = await call(kind === 'table' || kind === 'view' ? 'table.list' : kind + '.list', {
      connectionId: connection.id,
    });
    assert.ok(!items.some((item) => item.name === name));
  }
  await call('settings.save', { ...(await call('settings.get')), language: 'zh-TW' });
  await mkdir('.local', { recursive: true });
  await captureDesktop(desktop, '.local/create-objects.png');
  console.log(
    JSON.stringify({
      success: true,
      verified: [
        'four group create entries',
        'trigger context menu',
        'table draft restored after reload',
        'dirty close guard',
        'SQL preview and create',
        'table tree auto refresh',
        'real trigger executes',
        'open created definition',
        'four context-menu deletions and cancel',
        'dirty object tab discard guard',
      ],
      screenshot: '.local/create-objects.png',
    }),
  );
} finally {
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
