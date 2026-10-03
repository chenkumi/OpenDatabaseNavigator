import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';
const password = integrationPassword();
const dataDir = scratchDir('database-workspace-scopes-');
const environment = {
  ...process.env,
  DATABASE_WORKSPACE_DATA_DIR: dataDir,
  DATABASE_WORKSPACE_HEADLESS: '1',
};
delete environment.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({
  args: ['.', isolatedProfile()],
  env: environment,
  timeout: 30000,
});
let call;
let id;
const name = 'dw_' + randomUUID().replaceAll('-', '');
const schema = name + '_schema';
const createdDatabase = name + '_db';
let databaseCreated = false;
try {
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(20000);
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.setBackgroundThrottling(false);
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: '探索資料，從這裡開始。' }).waitFor();
  await page.evaluate(async () => {
    const settings = (await window.desktop.command('settings.get')).data;
    await window.desktop.command('settings.save', { ...settings, language: 'en' });
  });
  await page.getByRole('heading', { name: 'A workspace for every question.' }).waitFor();
  call = async (command, args) => {
    const result = await page.evaluate(
      async ({ command, args }) => window.desktop.command(command, args),
      { command, args },
    );
    assert.ok(result.success, `${command}: ${result.error}`);
    return result.data;
  };
  id = (
    await call('connection.save', {
      name: 'Scope PostgreSQL',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15432,
      username: 'workspace',
      password,
      database: 'workspace',
      agentAccess: 'read',
    })
  ).id;
  const execute = (database, sql) => call('query.execute', { connectionId: id, database, sql });
  await execute('workspace', `CREATE SCHEMA ${schema}`);
  for (const [database, namespace, value] of [
    ['workspace', 'public', 'Workspace row'],
    ['postgres', 'public', 'Postgres row'],
    ['workspace', schema, 'Schema row'],
  ]) {
    await execute(database, `CREATE TABLE ${namespace}.${name}(id INTEGER PRIMARY KEY,name TEXT)`);
    await execute(database, `INSERT INTO ${namespace}.${name} VALUES (1,'${value}')`);
  }
  await execute('workspace', `CREATE VIEW public.${name}_view AS SELECT * FROM public.${name}`);
  await page.getByRole('button', { name: /Scope PostgreSQL postgres/ }).dblclick();
  const openTable = async (value, namespace = 'public') => {
    await page
      .locator('.database-node')
      .filter({ has: page.locator('.tree-branch.selected') })
      .locator('.table-node')
      .filter({ has: page.locator(`[title="${namespace}.${name}"]`) })
      .dblclick();
    await page.waitForFunction((expected) => {
      const tabs = [...document.querySelectorAll('.tab-content')];
      const tab = tabs.find((tab) => getComputedStyle(tab).display !== 'none');
      return tab?.querySelector('input[aria-label="name row 1"]')?.value === expected;
    }, value);
  };
  assert.equal(await page.locator('.schema-node').count(), 0);
  const selectedDatabase = page
    .locator('.database-node')
    .filter({ has: page.locator('.tree-branch.selected') });
  await selectedDatabase.getByRole('button', { name: 'Table', exact: true }).waitFor();
  await selectedDatabase.getByRole('button', { name: 'View', exact: true }).waitFor();
  await openTable('Workspace row');
  assert.equal(await page.locator('.database-sidebar select').count(), 0);
  await page.getByRole('button', { name: 'Database postgres', exact: true }).click();
  await openTable('Postgres row');
  await page.getByRole('button', { name: 'Database workspace', exact: true }).click();
  await openTable('Schema row', schema);
  const state = await call('app.get_state', {});
  assert.deepEqual(
    state.tabs.map((tab) => tab.database),
    ['workspace', 'postgres', 'workspace'],
  );
  assert.deepEqual(
    state.tabs.map((tab) => tab.schema),
    ['public', 'public', schema],
  );
  await page.locator('.tab').first().locator('button').first().click();
  await page.waitForFunction(() => document.querySelector('.tab')?.classList.contains('active'));
  assert.equal(
    await page
      .locator('.tab-content:visible')
      .getByLabel('name row 1', { exact: true })
      .inputValue(),
    'Workspace row',
  );
  const workspaceTree = page
    .locator('.database-node')
    .filter({ has: page.getByRole('button', { name: 'Database workspace', exact: true }) });
  assert.equal(
    await workspaceTree
      .locator('[data-kind="table"] .table-node')
      .filter({ hasText: `${name}_view` })
      .count(),
    0,
  );
  await workspaceTree.getByRole('button', { name: 'View', exact: true }).click();
  await workspaceTree
    .locator('[data-kind="view"] .table-node')
    .filter({ hasText: `${name}_view` })
    .dblclick();
  await page.locator('.tab-content:visible').getByLabel('name row 1', { exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.tab-content:visible')
      .getByLabel('name row 1', { exact: true })
      .inputValue(),
    'Workspace row',
  );
  await page.getByRole('button', { name: 'Query postgres', exact: true }).click();
  const queryState = await call('app.get_state', {});
  assert.equal(queryState.tabs.find((tab) => tab.id === queryState.activeTab).database, 'postgres');
  assert.equal(queryState.tabs.find((tab) => tab.id === queryState.activeTab).type, 'query');
  await captureDesktop(desktop, resolve('.local/database-object-tree.png'));
  await page.getByRole('button', { name: 'Create database', exact: true }).click();
  await page.getByLabel('Database name', { exact: true }).fill(createdDatabase);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create database', exact: true })
    .click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  databaseCreated = true;
  await page.getByRole('button', { name: `Database ${createdDatabase}`, exact: true }).waitFor();
  assert.ok((await call('database.list', { connectionId: id })).includes(createdDatabase));
  await captureDesktop(desktop, resolve('.local/database-scopes.png'));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        success: true,
        verified: [
          'database / Table / View hierarchy without duplicate schema nodes',
          'GUI database creation and refreshed tree',
          'Query node opens SQL editor in its own database',
          'Table and View groups isolate object kinds and views open correctly',
          'schema-qualified duplicate names open correct table data',
          'existing tab remains pinned to original scope',
          'App Context database and schema',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (call && id) {
    if (databaseCreated) {
      await call('connection.disconnect', { connectionId: id });
      await call('connection.connect', { connectionId: id });
      await call('query.execute', { connectionId: id, sql: `DROP DATABASE ${createdDatabase}` });
    }
    await call('query.execute', {
      connectionId: id,
      database: 'workspace',
      sql: `DROP VIEW IF EXISTS public.${name}_view`,
    }).catch(() => undefined);
    for (const database of ['workspace', 'postgres'])
      await call('query.execute', {
        connectionId: id,
        database,
        sql: `DROP TABLE IF EXISTS public.${name}`,
      }).catch(() => undefined);
    await call('query.execute', {
      connectionId: id,
      database: 'workspace',
      sql: `DROP SCHEMA IF EXISTS ${schema} CASCADE`,
    }).catch(() => undefined);
  }
  await desktop.close();
}
