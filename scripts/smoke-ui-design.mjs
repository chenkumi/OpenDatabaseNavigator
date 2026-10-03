import { _electron as electron, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { selectValue } from './ui-controls.mjs';
import { scratchDir, isolatedProfile } from './support.mjs';

const dataDir = scratchDir('database-ui-design-');
const file = join(dataDir, 'design.sqlite');
const db = new DatabaseSync(file);
db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, note TEXT);
  INSERT INTO items VALUES(1,'Sample',NULL);
  CREATE VIEW visible_items AS SELECT id,name FROM items;
  CREATE INDEX items_name ON items(name);
  CREATE TRIGGER items_insert AFTER INSERT ON items BEGIN UPDATE items SET note='Created' WHERE id=NEW.id; END;`);
db.close();
const env = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', isolatedProfile()], env });
let page;
const call = async (name, args = {}) => {
  const result = await page.evaluate(({ name, args }) => window.desktop.command(name, args), {
    name,
    args,
  });
  assert.ok(result.success, result.error);
  return result.data;
};
const active = () => page.locator('.tab-content:visible');
async function noPageOverflow() {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'App must not overflow horizontally.',
  );
}
async function menuGeometry(menu) {
  for (const item of await menu.getByRole('menuitem').all()) {
    const metrics = await item.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        height: node.offsetHeight,
        top: parseFloat(style.paddingTop),
        bottom: parseFloat(style.paddingBottom),
        font: style.fontSize,
      };
    });
    assert.ok(
      metrics.height >= 36 && metrics.top >= 8 && metrics.bottom >= 8,
      JSON.stringify(metrics),
    );
    assert.equal(metrics.font, '13px');
  }
}
async function iconGeometry() {
  const buttons = await page.locator('.ui-button[data-size^="icon"]:visible').evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return {
        label: node.getAttribute('aria-label') || node.textContent.trim(),
        size: node.dataset.size,
        width: node.offsetWidth,
        height: node.offsetHeight,
        padding: style.padding,
        radius: style.borderRadius,
        font: style.fontSize,
      };
    }),
  );
  assert.ok(buttons.length > 0);
  for (const button of buttons) {
    const expected = { icon: 32, 'icon-sm': 28, 'icon-xs': 24, 'icon-lg': 36 }[button.size];
    assert.deepEqual(
      [button.width, button.height, button.padding, button.radius],
      [expected, expected, '0px', '6px'],
      JSON.stringify(button),
    );
    assert.equal(button.font, button.size === 'icon-xs' ? '12px' : '13px', JSON.stringify(button));
  }
  for (const group of await page.locator('.object-group-heading').all()) {
    const create = group.locator('.create-object-entry');
    const more = group.locator('.object-actions > button:last-child');
    for (const button of [create, more]) {
      await expect(button).toHaveAttribute('data-size', 'icon-sm');
      await expect(button).toHaveAttribute('data-variant', 'ghost');
    }
  }
  await expect(page.locator('.object-group-heading')).toHaveCount(4);
}
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
  );
  await page.locator('.app-shell').waitFor();
  await call('settings.save', { ...(await call('settings.get')), language: 'en' });
  const connection = await call('connection.save', {
    name: 'Design SQLite',
    engine: 'sqlite',
    database: file,
  });
  await page.getByRole('button', { name: /Design SQLite sqlite/ }).dblclick();
  const ref = {
    connectionId: connection.id,
    database: file,
    schema: 'main',
    table: 'visible_items',
  };
  await expect(page.locator('.create-object-entry')).toHaveCount(4);
  // Exercise the actual group entry points, including their disabled submit state.
  for (const kind of ['table', 'view', 'index', 'trigger']) {
    const create = page.getByRole('button', { name: `Create ${kind}`, exact: true });
    const group = create.locator('..');
    await group.locator('.object-actions > button:last-child').click();
    await menuGeometry(page.locator('[data-slot="dropdown-menu-content"]:visible'));
    await page.keyboard.press('Escape');
    await create.click();
    await expect(active().locator('.toolbar > strong').first()).toHaveText(`Create ${kind}`);
    const submit = active().getByRole('button', { name: 'Create object', exact: true });
    await expect(submit).toBeDisabled();
    assert.deepEqual(
      await submit.evaluate((node) => [node.offsetHeight, getComputedStyle(node).paddingLeft]),
      [32, '12px'],
    );
  }
  // Dense grid selection, Set NULL and composed combobox triggers share 24px squares.
  await call('app.open_table', { ...ref, table: 'items' });
  await expect(active().locator('.cell-null').first()).toBeVisible();
  await iconGeometry();
  await active().getByRole('tab', { name: 'Structure', exact: true }).click();
  await expect(active().locator('.designer-name > button').first()).toBeVisible();
  const typeTrigger = active().locator('.type-cell .ui-button[data-size="icon-xs"]').first();
  await expect(typeTrigger).toBeVisible();
  assert.equal(
    await typeTrigger.evaluate((node) => node.closest('[data-slot="input-group"]').offsetHeight),
    24,
  );
  await iconGeometry();
  await typeTrigger.click();
  await expect(page.locator('[data-slot="combobox-content"]:visible')).toBeVisible();
  await page.keyboard.press('Escape');
  await call('app.open_table', ref);
  await expect(active().locator('[data-slot="breadcrumb-page"]')).toHaveText('visible_items');
  await active().getByRole('tab', { name: 'Structure', exact: true }).click();
  const view = () => active().locator('.view-designer');
  await expect(view().getByRole('tab', { name: 'Definition', exact: true })).toBeVisible();
  await expect(view().getByRole('tab', { name: 'Advanced', exact: true })).toHaveCount(0);
  const definition = await view().locator('textarea').inputValue();
  await view()
    .locator('textarea')
    .fill(definition + '\n-- preserved draft');
  await view().getByRole('tab', { name: 'Columns', exact: true }).click();
  await expect(view().getByRole('cell', { name: 'name', exact: true })).toBeVisible();
  await expect(view().locator('textarea')).toHaveCount(0);
  await view().getByRole('tab', { name: 'Definition', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(view().getByRole('tab', { name: 'Columns', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await view().getByRole('tab', { name: 'Definition', exact: true }).click();
  await expect(view().locator('textarea')).toHaveValue(definition + '\n-- preserved draft');
  await active().getByRole('button', { name: 'Preview changes', exact: true }).click();
  await expect(active().getByRole('region', { name: 'SQL preview', exact: true })).toContainText(
    'preserved draft',
  );
  await active().getByRole('button', { name: 'Cancel', exact: true }).click();
  await view().locator('textarea').fill(definition);
  const toolbarMetrics = await active()
    .locator('.designer-toolbar')
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        height: node.offsetHeight,
        gap: style.gap,
        x: style.paddingLeft,
        y: style.paddingTop,
      };
    });
  assert.ok(toolbarMetrics.height >= 48);
  assert.deepEqual(
    [toolbarMetrics.gap, toolbarMetrics.x, toolbarMetrics.y],
    ['8px', '16px', '8px'],
  );
  assert.equal(await page.locator('.sidebar .search').evaluate((node) => node.offsetHeight), 32);

  await mkdir('.local/ui-design', { recursive: true });
  for (const [width, height, language, theme] of [
    [1280, 720, 'en', 'light'],
    [1280, 720, 'zh-TW', 'dark'],
    [1920, 1080, 'en', 'dark'],
    [1920, 1080, 'zh-TW', 'light'],
  ]) {
    await call('settings.save', { ...(await call('settings.get')), language, theme });
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await noPageOverflow();
    await iconGeometry();
    // The translated accessible name is sourced from the existing connection action trigger.
    const trigger = page.locator('.connection .tab-actions button');
    await trigger.click();
    const menu = page.locator('[data-slot="dropdown-menu-content"]:visible');
    await menuGeometry(menu);
    await expect(menu.getByRole('menuitem').first()).toBeVisible();
    await captureDesktop(app, resolve(`.local/ui-design/menu-${width}-${language}-${theme}.png`));
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await captureDesktop(app, resolve(`.local/ui-design/view-${width}-${language}-${theme}.png`));
    // Context menus use identical spacing as the dropdown actions.
    await page.locator('.connection .tab-actions').click({ button: 'right' });
    await menuGeometry(page.locator('[data-slot="context-menu-content"]:visible'));
    await page.keyboard.press('Escape');
  }
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await call('settings.save', { ...(await call('settings.get')), theme: 'system' });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(scheme === 'dark');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe(scheme === 'dark' ? 'rgb(17, 22, 25)' : 'rgb(247, 249, 252)');
  }
  await call('settings.save', { ...(await call('settings.get')), language: 'en', theme: 'light' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 720));
  await call('app.open_object', {
    ...ref,
    table: 'items',
    type: 'index',
    objectName: 'items_name',
  });
  await expect(active().locator('.toolbar > strong')).toHaveText('Index: items_name');
  await active().getByRole('tab', { name: 'Definition', exact: true }).click();
  await expect(active().locator('.object-definition-editor')).toBeVisible();
  await active().getByRole('tab', { name: 'Original definition', exact: true }).click();
  await expect(
    active().getByRole('tabpanel', { name: 'Original definition', exact: true }),
  ).toContainText('items_name');
  await call('app.open_object', {
    ...ref,
    table: 'items',
    type: 'trigger',
    objectName: 'items_insert',
  });
  await expect(active().locator('.toolbar > strong')).toHaveText('Trigger: items_insert');
  await active().getByRole('tab', { name: 'Original definition', exact: true }).click();
  await expect(
    active().getByRole('tabpanel', { name: 'Original definition', exact: true }),
  ).toContainText('items_insert');
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await selectValue(page, dialog.getByLabel('Database type', { exact: true }), 'sybase');
  await dialog.locator('.connection-content').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const save = dialog.getByRole('button', { name: 'Save connection', exact: true });
  await expect(save).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  await iconGeometry();
  await noPageOverflow();
  await captureDesktop(app, resolve('.local/ui-design/connection-1280-light.png'));
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: '⚙ Settings', exact: true }).click();
  await page.locator('.settings-content').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Save settings', exact: true }),
  ).toBeInViewport();
  await captureDesktop(app, resolve('.local/ui-design/settings-1280-light.png'));
  console.log(
    'UI design: square icon sizes, all four create/more entry points, disabled submit, dense grid/combobox, menu geometry, light/dark + en/zh-TW, 720p/1080p, View sections/draft/keyboard/preview, Index/Trigger sections, dialog scrolling passed.',
  );
} catch (error) {
  await mkdir('.local/ui-design', { recursive: true });
  if (page) await captureDesktop(app, resolve('.local/ui-design/failure.png')).catch(() => {});
  throw error;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
