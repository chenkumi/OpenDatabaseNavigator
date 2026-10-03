import { dismissConfirmation, acceptConfirmation } from './ui-controls.mjs';
import { _electron as electron } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { captureDesktop } from './capture-desktop.mjs';
import { integrationPassword, scratchDir, isolatedProfile } from './support.mjs';
const password = integrationPassword();
const dataDir = scratchDir('database-workspace-agent-smoke-');
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
let client;
let page;
const prefix = `desktop:${Date.now()}:`;
let redisId;
try {
  page = await desktop.firstWindow();
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
  const call = async (name, args = {}) => {
    const result = await page.evaluate(
      async ({ name, args }) => window.desktop.command(name, args),
      { name, args },
    );
    assert.ok(result.success, `${name}: ${result.error}`);
    return result.data;
  };
  const connection = await call('connection.save', {
    name: 'Desktop Redis',
    engine: 'redis',
    host: '127.0.0.1',
    port: 16379,
    database: '0',
    password,
    agentAccess: 'write',
  });
  redisId = connection.id;
  for (const [operation, args] of [
    ['set', { key: prefix + 'string', value: 'Hello Redis' }],
    ['hset', { key: prefix + 'hash', field: 'name', value: 'Alice' }],
    ['rpush', { key: prefix + 'list', value: 'first' }],
    ['sadd', { key: prefix + 'set', member: 'member' }],
    ['zadd', { key: prefix + 'zset', member: 'member', score: 5 }],
  ])
    await call('redis.' + operation, { connectionId: redisId, ...args });
  await page.getByRole('button', { name: /Desktop Redis redis/ }).dblclick();
  await page.getByLabel('Key pattern').fill(prefix + '*');
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await page.getByRole('button', { name: prefix + 'string', exact: true }).click();
  assert.equal(await page.getByLabel('Redis value').inputValue(), 'Hello Redis');
  await page.getByLabel('Redis value').fill('Edited in the desktop');
  await page.getByRole('button', { name: 'Save value', exact: true }).click();
  await page.getByLabel('TTL seconds').fill('120');
  await page.getByRole('button', { name: 'Set TTL', exact: true }).click();
  await page.getByText(/TTL 1\d\d seconds/).waitFor();
  for (const type of ['hash', 'list', 'set', 'zset']) {
    await page.getByRole('button', { name: prefix + type, exact: true }).click();
    await page.locator('.redis-value .badge').filter({ hasText: type }).waitFor();
    await page
      .getByRole('cell', {
        name:
          type === 'hash' ? 'Alice' : type === 'list' ? 'first' : type === 'zset' ? '5' : 'member',
        exact: true,
      })
      .waitFor();
  }
  await page.getByRole('button', { name: prefix + 'zset', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.getByLabel('Redis value').getAttribute('readonly'), '');
  await page.getByLabel('Score', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Save value', exact: true }).click();
  await page.getByRole('cell', { name: '7', exact: true }).waitFor();
  await page.getByRole('button', { name: prefix + 'string', exact: true }).click();
  await page.getByLabel('Redis value').fill('Unsaved Redis draft');
  await page.getByRole('button', { name: prefix + 'hash', exact: true }).click();
  await dismissConfirmation(page);
  assert.equal(await page.getByLabel('Redis value').inputValue(), 'Unsaved Redis draft');
  const dirtyContext = await call('app.get_state');
  assert.equal(dirtyContext.tabs.find((tab) => tab.id === dirtyContext.activeTab).dirty, true);
  await page.locator('.redis-value').getByRole('button', { name: 'Refresh', exact: true }).click();
  await acceptConfirmation(page);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Redis value"]')?.value === 'Edited in the desktop',
  );
  await mkdir(resolve('.local'), { recursive: true });
  await captureDesktop(desktop, resolve('.local/redis-smoke.png'));
  const port = await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
  const settings = await call('settings.get');
  await call('settings.save', { ...settings, mcp: { ...settings.mcp, enabled: true, port } });
  const { token } = await call('mcp.token');
  client = new Client({ name: 'Desktop Smoke Agent', version: '1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  await page
    .locator('.status-bar')
    .getByText(/1 agent connected/)
    .waitFor();
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 16);
  assert.ok(tools.tools.some((tool) => tool.name === 'redis.write'));
  assert.ok(!tools.tools.some((tool) => tool.name === 'redis.set'));
  const pending = await client.callTool({
    name: 'redis.write',
    arguments: {
      action: 'set',
      connectionId: redisId,
      key: prefix + 'string',
      value: 'Approved in desktop',
    },
  });
  assert.ok(pending.structuredContent.approvalId);
  await page.getByRole('heading', { name: 'Desktop Smoke Agent requests update' }).waitFor();
  await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  await page.locator('.approval-panel').waitFor({ state: 'detached' });
  const result = await client.callTool({
    name: 'redis.read',
    arguments: { action: 'get', connectionId: redisId, key: prefix + 'string' },
  });
  assert.deepEqual(result.structuredContent.data.items, ['Approved in desktop']);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Redis value"]')?.value === 'Approved in desktop',
  );
  const temporary = await client.callTool({
    name: 'redis.write',
    arguments: {
      action: 'set',
      connectionId: redisId,
      key: prefix + 'string',
      value: 'Temporary grant',
    },
  });
  assert.ok(temporary.structuredContent.approvalId);
  await page.getByRole('button', { name: 'Approve for 10 min', exact: true }).click();
  await page.locator('.approval-panel').waitFor({ state: 'detached' });
  // Wait for the approved command to finish before exercising its new grant.
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Redis value"]')?.value === 'Temporary grant',
  );
  const granted = await client.callTool({
    name: 'redis.write',
    arguments: {
      action: 'set',
      connectionId: redisId,
      key: prefix + 'string',
      value: 'Granted second write',
    },
  });
  assert.equal(granted.structuredContent.success, true);
  assert.equal(granted.structuredContent.approvalId, undefined);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Redis value"]')?.value === 'Granted second write',
  );
  const sqlite = await call('connection.save', {
    name: 'Agent SQLite',
    engine: 'sqlite',
    database: join(dataDir, 'shared.sqlite'),
    agentAccess: 'read',
  });
  await client.callTool({
    name: 'app.open',
    arguments: {
      action: 'query',
      connectionId: sqlite.id,
      title: 'Agent shared query',
      sql: 'SELECT 42 AS answer',
    },
  });
  await page.getByRole('tab', { name: '⌘ Agent shared query', exact: true }).waitFor();
  await client.callTool({
    name: 'query.manage',
    arguments: {
      action: 'read',
      connectionId: sqlite.id,
      sql: 'SELECT 42 AS answer',
      showInApp: true,
    },
  });
  await page.getByText('42', { exact: true }).waitFor();
  await page
    .locator('.tab-content:visible .workspace-scope')
    .getByText(/Agent SQLite/)
    .waitFor();
  await captureDesktop(desktop, resolve('.local/agent-shared-workspace.png'));
  const longQuery = client.callTool({
    name: 'query.manage',
    arguments: {
      action: 'read',
      connectionId: sqlite.id,
      showInApp: true,
      sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n',
    },
  });
  await page
    .locator('.status-bar')
    .getByText('Desktop Smoke Agent is running a query…', { exact: true })
    .waitFor();
  await page
    .locator('.tab-content:visible')
    .getByRole('button', { name: 'Stop', exact: true })
    .click();
  assert.equal((await longQuery).isError, true);
  const recovered = await client.callTool({
    name: 'query.manage',
    arguments: { action: 'read', connectionId: sqlite.id, sql: 'SELECT 1 AS alive' },
  });
  assert.equal(recovered.structuredContent.success, true);
  assert.deepEqual(errors, []);
  assert.ok(!(await readFile(join(dataDir, 'credentials.json'), 'utf8')).includes(password));
  console.log(
    JSON.stringify(
      {
        success: true,
        dataDir,
        verified: [
          'Redis five-type desktop workspace',
          'Redis value editing',
          'TTL editing',
          'OS-encrypted credentials',
          'real MCP client to running Electron',
          'human approval UI',
          'temporary scoped approval UI',
          'Redis dirty guard and agent write synchronization',
          'agent-created query tab',
          'agent result visible in GUI',
          'agent connected / running indicators and desktop query cancellation',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await client?.close().catch(() => undefined);
  if (page && redisId)
    for (const type of ['string', 'hash', 'list', 'set', 'zset'])
      await page
        .evaluate(async (args) => window.desktop.command('redis.delete', args), {
          connectionId: redisId,
          key: prefix + type,
        })
        .catch(() => undefined);
  await desktop.close();
}
