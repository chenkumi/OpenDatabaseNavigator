import { _electron as electron } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { scratchDir, isolatedProfile } from './support.mjs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const bounded = (task, ms) => {
  let timer;
  return Promise.race([
    task,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cleanup deadline exceeded')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const local = { ...parseEnv(readFileSync('.local/sybase.env', 'utf8')), ...process.env };
for (const key of ['ASE_HOST', 'ASE_USERNAME', 'ASE_PASSWORD'])
  if (!local[key]) throw new Error(`Missing ${key}`);
const safe = (error) => {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of [local.ASE_PASSWORD, local.ASE_USERNAME])
    if (secret) text = text.replaceAll(secret, '[REDACTED]');
  return text;
};
const stages = [];
const record = (stage, data = {}) => {
  const item = { stage, ...data };
  stages.push(item);
  console.log(JSON.stringify(item));
  mkdirSync('research/evidence', { recursive: true });
  writeFileSync(
    'research/evidence/ase-bi-sale-desktop-fixed.json',
    JSON.stringify(
      {
        scope: 'Real Electron/IPC/BIdb.dbo.BI_Sale, two-row pages; no business values retained',
        stages,
      },
      null,
      2,
    ),
  );
};
const env = { ...process.env, DATABASE_WORKSPACE_DATA_DIR: scratchDir('dw-bisale-live-') };
delete env.ELECTRON_RUN_AS_NODE;
const tick = setInterval(() => console.log('Real Electron Sybase diagnosis is running...'), 5000);
let app;
let page;
let connectionId;
let forcedStop = false;
const stopOwned = () => {
  if (!app || forcedStop) return;
  forcedStop = true;
  spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
  record('owned Electron force-stop', { requested: true });
};
const deadline = setTimeout(() => {
  record('hard deadline', { exceeded: true });
  process.exitCode = 1;
  stopOwned();
}, 120000);
try {
  record('launch', { status: 'running' });
  app = await electron.launch({ args: ['.', isolatedProfile()], env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.locator('.app-shell').waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.setBackgroundThrottling(false);
      w.setSize(1280, 720);
      w.show();
    }
  });
  await app.evaluate((_, root) => {
    const requireFrom = process
      .getBuiltinModule('node:module')
      .createRequire(process.getBuiltinModule('node:path').join(root, 'package.json'));
    const driver = requireFrom('msnodesqlv8');
    const open = driver.open.bind(driver);
    globalThis.__aseQueryProbe = [];
    driver.open = (options, callback) =>
      open(options, (error, session) => {
        if (session) {
          const raw = session.queryRaw.bind(session);
          const close = session.close.bind(session);
          const jobs = [];
          session.close = (callback) => {
            for (const stats of jobs) stats.closeCalls++;
            return close((error) => {
              for (const stats of jobs) {
                stats.closeCallbacks++;
                if (error) stats.closeErrors++;
              }
              callback?.(error);
            });
          };
          session.queryRaw = (query, params) => {
            const job = raw(query, params);
            if (
              query.query_str.includes('BI_Sale') &&
              !query.query_str.includes('dbo.syscolumns') &&
              !query.query_str.includes('dbo.sysobjects')
            ) {
              const stats = {
                meta: 0,
                rows: 0,
                done: 0,
                free: 0,
                errors: 0,
                pause: 0,
                cancel: 0,
                resume: 0,
                closeCalls: 0,
                closeCallbacks: 0,
                closeErrors: 0,
              };
              globalThis.__aseQueryProbe.push(stats);
              jobs.push(stats);
              for (const [event, key] of [
                ['meta', 'meta'],
                ['row', 'rows'],
                ['done', 'done'],
                ['free', 'free'],
                ['error', 'errors'],
              ])
                job.on(event, () => stats[key]++);
              for (const [method, key] of [
                ['pauseQuery', 'pause'],
                ['cancelQuery', 'cancel'],
                ['resumeQuery', 'resume'],
              ]) {
                const original = job[method].bind(job);
                job[method] = (...args) => {
                  stats[key]++;
                  return original(...args);
                };
              }
            }
            return job;
          };
        }
        callback(error, session);
      });
  }, resolve('.'));
  let rendererErrors = 0;
  page.on('pageerror', () => rendererErrors++);
  await page.evaluate(async () => {
    const settings = await window.desktop.command('settings.get', {});
    if (!settings.success) throw new Error('settings.get failed');
    const result = await window.desktop.command('settings.save', {
      ...settings.data,
      language: 'en',
      pageSize: 2,
      queryTimeout: 15000,
    });
    if (!result.success) throw new Error(result.error);
  });
  connectionId = await page.evaluate(
    async (args) => {
      const result = await window.desktop.command('connection.save', args);
      if (!result.success) throw new Error(result.error);
      return result.data.id;
    },
    {
      name: 'ASE BI_Sale live verification',
      engine: 'sybase',
      host: local.ASE_HOST,
      port: Number(local.ASE_PORT || 5000),
      database: 'BIdb',
      username: local.ASE_USERNAME,
      password: local.ASE_PASSWORD,
      aseDriver: local.ASE_DRIVER,
      tls: local.ASE_TLS === '1',
      aseTrustedFile: local.ASE_TRUSTED_FILE,
      readTimeout: Number(local.ASE_READ_TIMEOUT || 0),
      writeTimeout: Number(local.ASE_WRITE_TIMEOUT || 0),
    },
  );
  await page.locator(`.connection-main[data-connection-id="${connectionId}"]`).dblclick();
  await page.getByRole('button', { name: 'Database BIdb', exact: true }).waitFor();
  if (
    (await page
      .getByRole('button', { name: 'Database BIdb', exact: true })
      .getAttribute('aria-expanded')) !== 'true'
  )
    await page.getByRole('button', { name: 'Database BIdb', exact: true }).click();
  await page.getByRole('button', { name: 'Owner dbo', exact: true }).waitFor();
  const dbo = page
    .locator('.owner-node')
    .filter({ has: page.getByRole('button', { name: 'Owner dbo', exact: true }) });
  if (
    (await page
      .getByRole('button', { name: 'Owner dbo', exact: true })
      .getAttribute('aria-expanded')) !== 'true'
  )
    await page.getByRole('button', { name: 'Owner dbo', exact: true }).click();
  await dbo
    .locator('button.table-node')
    .filter({ hasText: /^▤\s*BI_Sale$/ })
    .dblclick();
  record(
    'pre-UI IPC diagnostic',
    await page.evaluate(async (connectionId) => {
      const r = await window.desktop.command('data.select', {
        connectionId,
        database: 'BIdb',
        schema: 'dbo',
        table: 'BI_Sale',
        limit: 2,
        offset: 0,
        filters: [],
        sort: [],
      });
      return r.success
        ? { success: true, rows: r.data.rows.length, columns: r.data.columns.length }
        : {
            success: false,
            categories: ['cleanup', 'cancel', 'numeric', 'clone', 'timed', 'connection'].filter(
              (s) => String(r.error).toLowerCase().includes(s),
            ),
          };
    }, connectionId),
  );
  record(
    'UI presence diagnostic',
    await page.evaluate(() => ({
      grids: document.querySelectorAll('.grid-wrap').length,
      controls: document.querySelectorAll('.column-controls').length,
      tables: document.querySelectorAll('.table-view').length,
      busy: [...document.querySelectorAll('.table-operation')].map((e) =>
        e.getAttribute('aria-busy'),
      ),
      categories: ['cleanup', 'cancel', 'numeric', 'clone', 'timed', 'connection', 'error'].filter(
        (s) =>
          [...document.querySelectorAll('[role="alert"],.notice')].some((e) =>
            e.textContent.toLowerCase().includes(s),
          ),
      ),
    })),
  );
  record('renderer errors before grid', { count: rendererErrors });
  await page.locator('.grid-wrap .column-controls').waitFor({ timeout: 10000 });
  await page.locator('.table-operation[aria-busy="false"]').waitFor();
  await page.waitForTimeout(1000);
  record(
    'actual table UI',
    await page.evaluate(() => {
      const pane = document.querySelector('.workspace-pane:not([hidden])') || document;
      const grid = pane.querySelector('.grid-wrap');
      const cells = [...(grid?.querySelectorAll('.data-row .result-cell-content > span') || [])];
      return {
        gridPresent: !!grid,
        renderedRows: grid?.querySelectorAll('.data-row').length || 0,
        cells: cells.length,
        nonEmptyCells: cells.filter((c) => c.textContent.trim() !== '').length,
        gridHeight: grid?.getBoundingClientRect().height || 0,
        viewportHeight: innerHeight,
        statistics: grid?.querySelector('.column-controls > span')?.textContent,
        noRowsMessage: !!grid?.querySelector('.empty-small'),
        filtersApplied: !!pane.querySelector('.applied-filters'),
      };
    }),
  );
  record(
    'direct shared IPC page',
    await page.evaluate(async (connectionId) => {
      const r = await window.desktop.command('data.select', {
        connectionId,
        database: 'BIdb',
        schema: 'dbo',
        table: 'BI_Sale',
        limit: 2,
        offset: 0,
        filters: [],
        sort: [],
      });
      if (!r.success) return { success: false, error: r.error };
      const d = r.data;
      const types = {};
      let populated = 0,
        missing = 0,
        nulls = 0,
        keyMismatches = 0;
      for (const row of d.rows) {
        for (const key of Object.keys(row)) if (!d.columns.includes(key)) keyMismatches++;
        for (const name of d.columns) {
          const value = row[name];
          types[typeof value] = (types[typeof value] || 0) + 1;
          if (value === undefined) missing++;
          else if (value === null) nulls++;
          else if (String(value) !== '') populated++;
        }
      }
      return {
        success: true,
        rows: d.rows.length,
        rowCount: d.rowCount,
        columns: d.columns.length,
        hasMore: d.hasMore,
        populated,
        missing,
        nulls,
        keyMismatches,
        types,
      };
    }, connectionId),
  );
  const firstUI = stages.find((s) => s.stage === 'actual table UI');
  const ipc = stages.find((s) => s.stage === 'direct shared IPC page');
  assert.equal(firstUI.renderedRows, 2, 'Initial page must render two rows.');
  assert.ok(firstUI.nonEmptyCells > 0, 'Initial page must contain visible values.');
  assert.equal(ipc.success, true, 'Shared IPC read must succeed.');
  assert.equal(ipc.rows, 2);
  assert.equal(ipc.columns, 19);
  assert.equal(ipc.missing, 0);
  assert.equal(ipc.keyMismatches, 0);
  assert.equal(ipc.hasMore, true);
  const table = page.locator('.table-view');
  for (const [stage, button] of [
    ['UI next page', 'Next →'],
    ['UI refresh', 'Refresh'],
    ['UI previous page', '← Previous'],
  ]) {
    await table.getByRole('button', { name: button, exact: true }).click();
    await page.locator('.table-operation[aria-busy="false"]').waitFor({ timeout: 30000 });
    const stats = await page.evaluate(() => ({
      rows: document.querySelectorAll('.grid-wrap .data-row').length,
      nonEmptyCells: [
        ...document.querySelectorAll('.grid-wrap .data-row .result-cell-content > span'),
      ].filter((c) => c.textContent.trim() !== '').length,
    }));
    record(stage, stats);
    assert.equal(stats.rows, 2);
    assert.ok(stats.nonEmptyCells > 0);
  }
  const queries = await app.evaluate(() => globalThis.__aseQueryProbe);
  record('native lifecycle counts', { queries });
  assert.ok(queries.length >= 5);
  assert.ok(
    queries.every(
      (q) =>
        q.pause === 1 &&
        q.cancel === 1 &&
        q.closeCalls === 1 &&
        q.closeCallbacks === 1 &&
        q.closeErrors === 0,
    ),
    'Each native business query must release its statement after deferred cancellation.',
  );
  record('renderer errors', { count: rendererErrors });
  assert.equal(rendererErrors, 0);
} catch (error) {
  if (app)
    try {
      record('native lifecycle counts', {
        queries: await app.evaluate(() => globalThis.__aseQueryProbe),
      });
    } catch {}
  record('error', { error: safe(error) });
  if (page && connectionId)
    try {
      record(
        'catalog diagnostic',
        await page.evaluate(async (connectionId) => {
          const r = await window.desktop.command('schema.list', { connectionId, database: 'BIdb' });
          return {
            success: r.success,
            ownerCount: r.success ? r.data.length : undefined,
            error: r.error,
          };
        }, connectionId),
      );
    } catch {}
  process.exitCode = 1;
} finally {
  if (page && connectionId)
    try {
      await bounded(
        page.evaluate(async (connectionId) => {
          const r = await window.desktop.command('connection.disconnect', { connectionId });
          if (!r.success) throw new Error(r.error);
        }, connectionId),
        5000,
      );
      record('disconnect', { success: true });
    } catch (error) {
      record('disconnect', { success: false, error: safe(error) });
      process.exitCode = 1;
    }
  if (app)
    try {
      await bounded(app.close(), 5000);
      record('close', { success: true });
    } catch (error) {
      record('close', { success: false, error: safe(error) });
      process.exitCode = 1;
      stopOwned();
    }
  clearInterval(tick);
  clearTimeout(deadline);
}
