// Packaged acceptance uses REAL persisted synthetic credentials and the normal
// native artifact lifecycle. No builds, integration.env, services, screenshots,
// production password hooks/IPC, backend overrides, or AppImage extraction.
import { existsSync, createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  launchNativeElectron,
  NativeLaunchError,
  removeIsolatedRoot,
} from './native-electron-launch.mjs';

const args = process.argv.slice(2);
const executableIndex = args.indexOf('--executable');
const executable =
  executableIndex >= 0
    ? args[executableIndex + 1]
    : args.length === 1 && !args[0].startsWith('--')
      ? args[0]
      : undefined;
const development = args.includes('--development');
if (
  !(args.length === 1 && (args[0] === '--development' || executable)) &&
  !(args.length === 2 && executableIndex === 0 && executable && !executable.startsWith('--'))
) {
  console.error(
    'Usage: npm run test:packaged:credentials -- PATH | node scripts/smoke-packaged-credentials.mjs --development',
  );
  process.exit(2);
}
if (development && !existsSync(resolve('dist/main/index.js'))) {
  console.error('Built dist required. Run npm run build separately first.');
  process.exit(2);
}

// No assertions ever include command results, inspector expressions, plaintext,
// paths containing secrets, or screenshots. Report only fixed stage IDs/booleans.
let stage = 'launch';
let active;
let timedOut = false;
let ownedRoot;
let launchCleanupConfirmed = true;
const syntheticSecret = `synthetic-${randomBytes(32).toString('hex')}`;
const replacementSecret = `synthetic-replacement-${randomBytes(32).toString('hex')}`;
const allSecrets = [
  syntheticSecret,
  replacementSecret,
  'credential-smoke-public-synthetic-sentinel',
];
class BlockedCheck extends Error {}
class SmokeAssertion extends Error {}
const requireTrue = (value, code) => {
  if (!value) throw new SmokeAssertion(code);
};
const statusSelector = '[data-testid="secure-storage-status"]';
const guidanceSelector = '[data-testid="secure-storage-guidance"]';
const recheckName = /Recheck secure storage|重新檢查/;
const closeName = /^(Close|關閉)$/;
async function command(page, name, args = {}) {
  const result = await page.evaluate(async ({ name, args }) => window.desktop.command(name, args), {
    name,
    args,
  });
  requireTrue(result?.success === true, 'formal-command-failed');
  return result.data;
}
function validateStatus(status) {
  requireTrue(
    status &&
      Object.keys(status).sort().join(',') ===
        'available,backend,platform,reason,restartRequired,selectionSource',
    'status-nonsecret-schema',
  );
  requireTrue(
    typeof status.platform === 'string' &&
      typeof status.backend === 'string' &&
      typeof status.available === 'boolean' &&
      typeof status.restartRequired === 'boolean' &&
      ['explicit', 'native', 'wsl-libsecret'].includes(status.selectionSource) &&
      ['not-checked', 'available', 'unavailable', 'basic-text', 'restart-required'].includes(
        status.reason,
      ),
    'status-types',
  );
  requireTrue(
    !status.available ||
      (!status.restartRequired && status.reason === 'available' && status.backend !== 'basic_text'),
    'status-health-consistency',
  );
  return status;
}

// Test-only debugger probe: pause the REAL registered IPC handler and use its
// lexical Application, not a separate synthetic Command Bus. No credentials get,
// password read IPC, MCP token creation, or encrypt/decrypt hooks are used.
// The MCP catalog assertion complements the backend unit tests without creating
// an MCP access token (which would write a credential / touch the real keyring).
async function agentBoundary(run) {
  const main = run.main;
  await main.send('Debugger.enable');
  const handler = await main.send('Runtime.evaluate', {
    expression: `__credentialSmokeElectron.ipcMain._invokeHandlers.get('application:command')`,
  });
  requireTrue(handler.result.objectId, 'ipc-handler-missing');
  const { breakpointId } = await main.send('Debugger.setBreakpointOnFunctionCall', {
    objectId: handler.result.objectId,
  });
  let unsubscribe;
  const paused = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error('agent-probe-timeout'));
    }, 15000);
    unsubscribe = main.on('Debugger.paused', (event) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
  const trigger = command(run.page, 'credentials.status');
  // Attach a handler immediately so a failed pause does not create an unhandled rejection.
  trigger.catch(() => {});
  try {
    const event = await paused;
    const probe = await main.send('Debugger.evaluateOnCallFrame', {
      callFrameId: event.callFrames[0].callFrameId,
      expression: `(async () => {
        const actor = {kind:'agent', id:'credential-smoke-agent', name:'Credential smoke'};
        const catalog = new McpToolCatalog(core.commands, () => 'execute');
        const hidden = !core.commands.tools().some(t => t.name === 'credentials.status') &&
          !catalog.list().some(t => t.name === 'credentials.status');
        const denied = await core.commands.dispatch('credentials.status', {}, actor);
        const toolDenied = await catalog.call('credentials.status', {}, actor);
        return {hidden, denied: denied.success === false && !('data' in denied),
          toolDenied: toolDenied.success === false && !('data' in toolDenied)};
      })()`,
    });
    requireTrue(!probe.exceptionDetails && probe.result.objectId, 'agent-runtime-probe');
    await main.send('Debugger.removeBreakpoint', { breakpointId });
    await main.send('Debugger.resume');
    const result = await main.send('Runtime.awaitPromise', {
      promiseObjectId: probe.result.objectId,
      returnByValue: true,
    });
    requireTrue(
      !result.exceptionDetails &&
        result.result.value?.hidden &&
        result.result.value?.denied &&
        result.result.value?.toolDenied,
      'agent-boundary',
    );
    await trigger;
  } finally {
    unsubscribe?.();
    await main.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
    await main.send('Debugger.resume').catch(() => {});
    await main.send('Debugger.disable').catch(() => {});
  }
}

// A narrowly scoped response fixture, only for this isolated renderer and this
// nonsecret command. All other IPC calls still use the production handler.
// Electron contextBridge freezes the renderer bridge; do NOT monkeypatch it.
// _invokeHandlers is an Electron internal test dependency; fail closed if absent.
async function installFixture(run, status) {
  await resetFixture(run);
  const installed = await run.main.evaluate(`(() => {
    const {ipcMain, BrowserWindow} = __credentialSmokeElectron;
    const original = ipcMain._invokeHandlers.get('application:command');
    const target = BrowserWindow.getAllWindows()[0].webContents.id;
    if (typeof original !== 'function') return false;
    globalThis.__credentialSmokeFixture = {original, target, hits:0};
    ipcMain.removeHandler('application:command');
    ipcMain.handle('application:command', (event, name, args) => {
      if (name === 'credentials.status' && event.sender.id === target &&
          event.senderFrame === event.sender.mainFrame && event.senderFrame.url === 'workspace://app/index.html') {
        __credentialSmokeFixture.hits++;
        return {success:true, data:${JSON.stringify(status)}};
      }
      return original(event, name, args);
    });
    return true;
  })()`);
  requireTrue(installed, 'fixture-install');
}
async function resetFixture(run) {
  await run.main.evaluate(`(() => {
    if (!globalThis.__credentialSmokeFixture) return true;
    const {ipcMain} = __credentialSmokeElectron;
    ipcMain.removeHandler('application:command');
    ipcMain.handle('application:command', __credentialSmokeFixture.original);
    delete globalThis.__credentialSmokeFixture;
    return true;
  })()`);
}
async function closeDialog(page) {
  await page.getByRole('dialog').getByRole('button', { name: closeName }).first().click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
async function settledDialog(page) {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });
  return dialog;
}
async function inspectDialog(page, dialog, { available, settings, language, reason }) {
  // Keyboard focus styling is meaningful only in the ACTUAL foreground page.
  // CDP attachment alone does not guarantee native-window activation. Request
  // normal activation and verify it; never fake focus, CSS, or key modality.
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus());
  const status = dialog.locator(statusSelector);
  await status.waitFor();
  await page.waitForFunction(
    ({ selector, available }) =>
      document.querySelector(selector)?.getAttribute('data-available') === String(available),
    { selector: statusSelector, available },
  );
  const recheck = dialog.getByRole('button', { name: recheckName });
  await recheck.scrollIntoViewIfNeeded();
  requireTrue((await recheck.isVisible()) && (await recheck.isEnabled()), 'recheck-action-visible');
  await recheck.focus();
  requireTrue(await recheck.evaluate((node) => document.activeElement === node), 'recheck-focus');
  await page.keyboard.press('Tab');
  requireTrue(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
    'dialog-focus-contained',
  );
  await page.keyboard.press('Shift+Tab');
  // Wait for the same complete focus/ring predicate to settle after key events,
  // rather than sampling before the next renderer paint/React focus update.
  // A missing keyboard focus or missing real style still fails the same check.
  const recheckHandle = await recheck.elementHandle();
  try {
    await page.waitForFunction((node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return (
        document.hasFocus() &&
        document.activeElement === node &&
        node.matches(':focus-visible') &&
        (style.boxShadow !== 'none' ||
          (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0))
      );
    }, recheckHandle);
  } catch {
    throw new SmokeAssertion('keyboard-focus-visible');
  } finally {
    await recheckHandle?.dispose().catch(() => {});
  }
  await recheck.click();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute('aria-busy') === 'false',
    statusSelector,
  );
  if (reason)
    requireTrue((await status.getAttribute('data-reason')) === reason, 'status-reason-visible');
  if (!available) {
    const guidance = dialog.locator(guidanceSelector);
    await guidance.scrollIntoViewIfNeeded();
    requireTrue(
      (await guidance.isVisible()) && (await guidance.textContent()).trim().length > 0,
      'unavailable-guidance-visible',
    );
    const hint = dialog.getByTestId('secure-storage-restart-hint');
    requireTrue(await hint.isVisible(), 'restart-guidance-visible');
    if (reason === 'restart-required')
      requireTrue(
        /Restart the app|請重新啟動程式/.test(await hint.textContent()),
        'restart-required-guidance',
      );
  } else
    requireTrue(
      (await dialog.locator(guidanceSelector).count()) === 0,
      'healthy-no-unavailable-guidance',
    );
  if (settings && language === 'en') {
    requireTrue(
      await dialog
        .getByRole('heading', { name: 'Secure credential storage', exact: true })
        .isVisible(),
      'secure-storage-heading',
    );
  }
  const measurements = await dialog.evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const actions = [...node.querySelectorAll('button.ui-button')].map((button) => {
      const css = getComputedStyle(button);
      const token =
        {
          xs: '--ui-control-dense',
          sm: '--ui-control-small',
          lg: '--ui-control-large',
          'icon-xs': '--ui-control-dense',
          'icon-sm': '--ui-control-small',
          'icon-lg': '--ui-control-large',
        }[button.dataset.size] ?? '--ui-control';
      return Math.abs(button.offsetHeight - parseFloat(css.getPropertyValue(token))) <= 1;
    });
    const scrollAreas = [...node.querySelectorAll('*')].filter((element) => {
      const css = getComputedStyle(element);
      return /(auto|scroll)/.test(css.overflowY) && element.scrollHeight > element.clientHeight;
    });
    for (const element of scrollAreas) element.scrollTop = element.scrollHeight;
    return {
      inViewport:
        rect.left >= 15 && rect.right <= innerWidth - 15 && rect.height <= innerHeight - 46,
      noOverflow:
        document.documentElement.scrollWidth <= innerWidth &&
        node.scrollWidth <= node.clientWidth + 1,
      tokens:
        actions.length > 0 &&
        actions.every(Boolean) &&
        style.getPropertyValue('--ui-control').trim() === '32px',
      scroll: scrollAreas.every((element) => element.scrollTop > 0),
    };
  });
  requireTrue(Object.values(measurements).every(Boolean), 'dialog-layout-tokens-scroll');
  const save = dialog.getByRole('button', {
    name: settings ? /^(Save settings|儲存設定)$/ : /^(Save connection|儲存連線)$/,
  });
  await save.scrollIntoViewIfNeeded();
  requireTrue(await save.isVisible(), 'save-action-reachable');
  // Check after scrolling, not just whether Playwright considers it attached.
  requireTrue(
    await save.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.top >= 0 && r.bottom <= innerHeight && (hit === node || node.contains(hit));
    }),
    'save-action-unobscured',
  );
}
async function uiMatrix(run, realStatus) {
  // The healthy fixture is ONLY a UI state if the native session is unhealthy.
  // It never authorizes credential saving or changes the actual encryption provider.
  const states = [
    {
      ...realStatus,
      available: true,
      backend: 'test-ui-secure-backend',
      reason: 'available',
      restartRequired: false,
    },
    { ...realStatus, available: false, reason: 'unavailable', restartRequired: false },
    { ...realStatus, available: false, reason: 'restart-required', restartRequired: true },
  ];
  try {
    for (const language of ['zh-TW', 'en'])
      for (const theme of ['light', 'dark'])
        for (const [width, height] of [
          [1280, 720],
          [1920, 1080],
        ]) {
          stage = `ui-${language}-${theme}-${width}`;
          const settings = await command(run.page, 'settings.get');
          await command(run.page, 'settings.save', { ...settings, language, theme });
          await run.main.evaluate(
            `__credentialSmokeElectron.BrowserWindow.getAllWindows()[0].setContentSize(${width},${height}); true`,
          );
          for (const fixture of states) {
            const caseStage = `ui-${language}-${theme}-${width}-${fixture.reason}`;
            stage = `${caseStage}-reload`;
            await installFixture(run, fixture);
            await run.page.reload();
            await run.page.waitForFunction(
              ({ theme, width, height }) =>
                document.documentElement.dataset.theme === theme &&
                innerWidth === width &&
                innerHeight === height,
              { theme, width, height },
            );
            stage = `${caseStage}-settings`;
            await run.page.getByRole('button', { name: /⚙ (Settings|設定)/ }).click();
            await inspectDialog(run.page, await settledDialog(run.page), {
              available: fixture.available,
              settings: true,
              language,
              reason: fixture.reason,
            });
            await closeDialog(run.page);
            stage = `${caseStage}-connection`;
            await run.page
              .getByRole('button', { name: /Create your first connection|建立第一個連線/ })
              .click();
            const dialog = await settledDialog(run.page);
            // SQLite hides password fields; switch to a password-bearing engine.
            const { selectValue } = await import('./ui-controls.mjs');
            await selectValue(
              run.page,
              run.page.getByLabel(language === 'en' ? 'Database type' : '資料庫類型', {
                exact: true,
              }),
              'postgres',
            );
            await inspectDialog(run.page, dialog, {
              available: fixture.available,
              settings: false,
              language,
              reason: fixture.reason,
            });
            // Escape uses onOpenChange/requestClose; the header Close button
            // directly closes this form and does not open a discard prompt.
            stage = `${caseStage}-discard`;
            await run.page.keyboard.press('Escape');
            // Changing engine makes this form dirty: use its real discard prompt.
            await run.page
              .getByRole('alertdialog')
              .getByRole('button', { name: /^(Continue|繼續)$/ })
              .click();
            await dialog.waitFor({ state: 'hidden' });
            requireTrue(
              await run.main.evaluate('__credentialSmokeFixture.hits > 0'),
              'fixture-used',
            );
            await resetFixture(run);
            requireTrue(
              JSON.stringify(validateStatus(await command(run.page, 'credentials.status'))) ===
                JSON.stringify(realStatus),
              'real-status-restored-after-fixture',
            );
          }
        }
  } finally {
    await resetFixture(run);
    await run.page.reload();
  }
}
async function credentialBytes(dataDir) {
  try {
    return await readFile(join(dataDir, 'credentials.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('credential-file-read');
  }
}
async function fileFingerprint(dataDir, name) {
  try {
    const info = await stat(join(dataDir, name), { bigint: true });
    // Reads can update atime. Inode, size, mtime and ctime detect any write or
    // replacement even if an implementation rewrites byte-identical content.
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function negativeAndSqlite(run, { basic = false, existing } = {}) {
  // Both packaged and development modes use a NEW real unreachable-D-Bus
  // child, or the separately requested explicit-basic child. No method stubs.
  if (!basic) requireTrue(run.unavailable === true, 'actual-unavailable-child-required');
  const status = validateStatus(await command(run.page, 'credentials.status'));
  requireTrue(status.available === false, 'negative-status');
  if (basic)
    requireTrue(
      status.reason === 'basic-text' && status.selectionSource === 'explicit',
      'basic-explicit-rejected',
    );
  const before = await credentialBytes(run.dataDir);
  const credentialFingerprint = await fileFingerprint(run.dataDir, 'credentials.json');
  const connectionFingerprint = await fileFingerprint(run.dataDir, 'connections.json');
  const connectionsBefore = await readFile(join(run.dataDir, 'connections.json')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const baseline = await command(run.page, 'connection.list');
  if (existing) {
    const overwritten = await run.page.evaluate(
      async ({ existing, replacementSecret }) => {
        const result = await window.desktop.command('connection.save', {
          ...existing,
          password: replacementSecret,
        });
        return (
          result.success === false &&
          typeof result.error === 'string' &&
          /secure credential storage.*unavailable/i.test(result.error)
        );
      },
      { existing, replacementSecret },
    );
    requireTrue(overwritten, 'existing-credential-overwrite-refused');
    requireTrue(
      before !== null && before.equals(await credentialBytes(run.dataDir)),
      'existing-ciphertext-unchanged',
    );
  }
  // Fixed public synthetic sentinel, never output. The formal IPC exercise
  // returns ONLY a boolean so assertion failure cannot echo it.
  const refused = await run.page.evaluate(async () => {
    const result = await window.desktop.command('connection.save', {
      name: 'Synthetic refused credential',
      engine: 'postgres',
      host: '127.0.0.1',
      username: 'synthetic',
      password: 'credential-smoke-public-synthetic-sentinel',
    });
    return (
      result.success === false &&
      typeof result.error === 'string' &&
      /secure credential storage.*unavailable/i.test(result.error)
    );
  });
  requireTrue(refused, 'credential-save-refused');
  // Exercise the HUMAN form too, while the real provider is unavailable. Even
  // a renderer bug cannot save via the keyring here. No screenshot/trace exists.
  const settings = await command(run.page, 'settings.get');
  await command(run.page, 'settings.save', { ...settings, language: 'en' });
  await run.page.reload();
  await run.page.getByRole('button', { name: /⚙ (Settings|設定)/ }).click();
  await inspectDialog(run.page, await settledDialog(run.page), {
    available: false,
    settings: true,
    language: 'en',
    reason: status.reason,
  });
  await closeDialog(run.page);
  await run.page.getByRole('button', { name: 'New connection', exact: true }).click();
  const dialog = await settledDialog(run.page);
  const { selectValue } = await import('./ui-controls.mjs');
  await selectValue(run.page, run.page.getByLabel('Database type', { exact: true }), 'postgres');
  await inspectDialog(run.page, dialog, {
    available: false,
    settings: false,
    language: 'en',
    reason: status.reason,
  });
  await run.page.getByLabel('Name', { exact: true }).fill('Synthetic UI refused credential');
  await run.page
    .getByLabel('Password', { exact: true })
    .fill('credential-smoke-public-synthetic-sentinel');
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  await dialog
    .getByText(
      'Cannot save password: secure credential storage is unavailable. Follow the guidance below, then recheck.',
      { exact: true },
    )
    .waitFor();
  requireTrue(
    JSON.stringify(await command(run.page, 'connection.list')) === JSON.stringify(baseline),
    'ui-save-refused',
  );
  const connectionsAfter = await readFile(join(run.dataDir, 'connections.json')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  requireTrue(
    connectionsBefore === null
      ? connectionsAfter === null
      : connectionsAfter !== null && connectionsBefore.equals(connectionsAfter),
    'refused-save-no-connection-file-change',
  );
  await run.page.getByLabel('Password', { exact: true }).fill('');
  // Exercise the guarded dismissal path, not the direct header Close action.
  await run.page.keyboard.press('Escape');
  await run.page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Continue', exact: true })
    .click();
  await dialog.waitFor({ state: 'hidden' });
  const after = await credentialBytes(run.dataDir);
  requireTrue(
    before === null ? after === null : after !== null && before.equals(after),
    'negative-credential-file-unchanged',
  );
  requireTrue(
    credentialFingerprint === (await fileFingerprint(run.dataDir, 'credentials.json')) &&
      connectionFingerprint === (await fileFingerprint(run.dataDir, 'connections.json')),
    'refused-save-no-file-write-or-replacement',
  );
  const sqlite = await command(run.page, 'connection.save', {
    name: 'Credential smoke SQLite',
    engine: 'sqlite',
    database: join(run.dataDir, 'synthetic.sqlite'),
  });
  await command(run.page, 'connection.connect', { connectionId: sqlite.id });
  const query = await command(run.page, 'query.execute', {
    connectionId: sqlite.id,
    sql: 'SELECT 42 AS credential_smoke',
  });
  // The SQLite adapter reads integers as BigInt and normalizes them to exact
  // decimal strings for IPC; assert that contract rather than a JS number.
  requireTrue(
    query.success === true &&
      query.rowCount === 1 &&
      query.rows?.length === 1 &&
      query.columns?.length === 1 &&
      query.columns[0] === 'credential_smoke' &&
      query.rows[0].credential_smoke === '42',
    'sqlite-usable',
  );
  await command(run.page, 'connection.delete', { connectionId: sqlite.id });
  await assertDiskAndLogs(run);
}

function ipcNonsecret(value) {
  if (
    JSON.stringify(value)?.includes(syntheticSecret) ||
    JSON.stringify(value)?.includes(replacementSecret)
  )
    return false;
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, child]) => !/password|ciphertext|encryptedCredential/i.test(key) && ipcNonsecret(child),
  );
}
async function assertDiskAndLogs(run) {
  requireTrue(
    !run.logs.plaintextFound && run.logs.bounded && run.logs.scrubbed,
    'bounded-child-logs-no-plaintext',
  );
  const overlap = Math.max(...allSecrets.map((secret) => Buffer.byteLength(secret))) - 1;
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        let tail = Buffer.alloc(0);
        try {
          for await (const chunk of createReadStream(path)) {
            const combined = Buffer.concat([tail, chunk]);
            requireTrue(
              !allSecrets.some((secret) => combined.includes(Buffer.from(secret))),
              'no-plaintext-in-data-or-profile',
            );
            tail = combined.subarray(Math.max(0, combined.length - overlap));
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  };
  await visit(run.root);
}
async function packagedIdentity(run) {
  const identity = await run.main.evaluate(`(() => {
    const {app} = __credentialSmokeElectron;
    const crypto = process.getBuiltinModule('crypto');
    // Electron's patched fs views app.asar as a directory; hash the real archive.
    const fs = process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('original-fs');
    return {packaged:app.isPackaged, name:app.getName(), version:app.getVersion(),
      applicationHash:app.isPackaged ? crypto.createHash('sha256').update(fs.readFileSync(app.getAppPath())).digest('hex') : 'development',
      data:process.env.DATABASE_WORKSPACE_DATA_DIR, profile:app.getPath('userData'), mainPid:process.pid};
  })()`);
  requireTrue(identity.packaged === !development, 'actual-packaged-mode');
  requireTrue(
    identity.data === run.dataDir &&
      identity.profile === run.profile &&
      identity.mainPid === run.mainPid,
    'isolated-main-identity',
  );
  requireTrue(
    !run.args.some((arg) => /password-store|no-sandbox|extract-and-run/.test(arg)),
    'normal-backend-selection-unmodified',
  );
  requireTrue(
    await run.page.evaluate(
      () =>
        Object.keys(window.desktop).sort().join(',') ===
        'chooseDatabase,command,platform,subscribe',
    ),
    'no-password-bridge',
  );
  return identity;
}
async function verifyActualUnavailableProvider(run, positiveIdentity) {
  requireTrue(
    run.unavailable === true && typeof run.unavailableBusAddress === 'string',
    'unreachable-session-bus-provenance',
  );
  const identity = await packagedIdentity(run);
  requireTrue(
    ['name', 'version', 'applicationHash', 'data', 'profile'].every(
      (key) => identity[key] === positiveIdentity[key],
    ),
    'same-product-profile-real-negative',
  );
  const status = validateStatus(await command(run.page, 'credentials.status'));
  const probe = await run.main.evaluate(`({
    busAddressMatches: process.env.DBUS_SESSION_BUS_ADDRESS === ${JSON.stringify(run.unavailableBusAddress)},
    fixtureAbsent: !globalThis.__credentialSmokeFixture,
    nativeAvailable: __credentialSmokeElectron.safeStorage.isEncryptionAvailable()
  })`);
  requireTrue(probe.busAddressMatches && probe.fixtureAbsent, 'actual-unavailable-not-ui-fixture');
  // This is an actual environmental outcome, never grounds for installing a
  // replacement method/provider. Reject even a cached/native available result.
  if (status.available || probe.nativeAvailable !== false)
    throw new BlockedCheck('unreachable-dbus-provider-still-available');
  requireTrue(status.reason === 'unavailable', 'actual-secret-service-unavailable-reason');
  return status;
}
async function positiveSave(run) {
  const settings = await command(run.page, 'settings.get');
  await command(run.page, 'settings.save', { ...settings, language: 'en' });
  await run.page.reload();
  await run.page.getByRole('button', { name: 'New connection', exact: true }).click();
  const dialog = await settledDialog(run.page);
  const { selectValue } = await import('./ui-controls.mjs');
  await selectValue(run.page, run.page.getByLabel('Database type', { exact: true }), 'postgres');
  await run.page.getByLabel('Name', { exact: true }).fill('Packaged synthetic credential');
  await run.page.getByLabel('Username', { exact: true }).fill('synthetic');
  await run.page.getByLabel('Password', { exact: true }).fill(syntheticSecret);
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const connections = await command(run.page, 'connection.list');
  requireTrue(connections.length === 1 && ipcNonsecret(connections), 'positive-list-no-password');
  const saved = connections[0];
  requireTrue(
    typeof saved.id === 'string' &&
      /^[a-f0-9-]{36}$/.test(saved.id) &&
      saved.name === 'Packaged synthetic credential',
    'positive-saved-id',
  );
  // Also exercise the actual password-bearing formal save response. Resend only
  // OUR random synthetic password, never any password read from the application.
  const passwordSave = await command(run.page, 'connection.save', {
    ...saved,
    password: syntheticSecret,
  });
  requireTrue(
    passwordSave.id === saved.id && ipcNonsecret(passwordSave),
    'password-bearing-save-response-no-password',
  );
  requireTrue(ipcNonsecret(await command(run.page, 'app.get_state')), 'app-state-no-password');
  const bytes = await credentialBytes(run.dataDir);
  const record = JSON.parse(bytes.toString('utf8'));
  requireTrue(
    Object.keys(record).length === 1 &&
      typeof record[saved.id] === 'string' &&
      Buffer.from(record[saved.id], 'base64').length > 0 &&
      !Buffer.from(record[saved.id], 'base64').includes(Buffer.from(syntheticSecret)),
    'actual-persisted-ciphertext',
  );
  // A metadata-only save must leave the actual saved ciphertext unchanged.
  const response = await command(run.page, 'connection.save', saved);
  requireTrue(response.id === saved.id && ipcNonsecret(response), 'formal-save-no-password');
  requireTrue(
    bytes.equals(await credentialBytes(run.dataDir)),
    'metadata-save-ciphertext-unchanged',
  );
  await assertDiskAndLogs(run);
  return { saved, bytes };
}
// Pause only the real IPC callback, resolve its actual Application, and compare
// the REAL CredentialService.get of OUR saved synthetic ID to OUR random secret.
// No replacement classes, synthetic roundtrip, production read IPC, or password
// hooks. Runtime exceptions and values are never printed; only a boolean exits.
async function realPersistedCredentialGet(run, saved) {
  const main = run.main;
  await main.send('Debugger.enable');
  const handler = await main.send('Runtime.evaluate', {
    expression: `__credentialSmokeElectron.ipcMain._invokeHandlers.get('application:command')`,
  });
  requireTrue(handler.result.objectId, 'synthetic-get-handler');
  const { breakpointId } = await main.send('Debugger.setBreakpointOnFunctionCall', {
    objectId: handler.result.objectId,
  });
  let unsubscribe, timer;
  const paused = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      unsubscribe?.();
      reject(new SmokeAssertion('synthetic-get-pause-timeout'));
    }, 15000);
    unsubscribe = main.on('Debugger.paused', (event) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
  const trigger = command(run.page, 'credentials.status');
  trigger.catch(() => {});
  try {
    const event = await paused;
    const result = await main.send('Debugger.evaluateOnCallFrame', {
      callFrameId: event.callFrames[0].callFrameId,
      returnByValue: true,
      expression: `(() => {
        const connection = core.connections.get(${JSON.stringify(saved.id)});
        if (connection.name !== 'Packaged synthetic credential' || connection.username !== 'synthetic') return false;
        const service = core.connections.credentials;
        return service.constructor.name === 'CredentialService' && service.get(${JSON.stringify(saved.id)}) === ${JSON.stringify(syntheticSecret)};
      })()`,
    });
    requireTrue(
      !result.exceptionDetails && result.result.value === true,
      'real-main-persisted-credential-get',
    );
  } finally {
    clearTimeout(timer);
    unsubscribe?.();
    await main.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
    await main.send('Debugger.resume').catch(() => {});
    await main.send('Debugger.disable').catch(() => {});
  }
  await trigger;
}
const launchedRuns = [];
async function startRun(options = {}) {
  requireTrue(!timedOut, 'watchdog-timeout');
  let run;
  try {
    run = await launchNativeElectron({
      executable,
      root: ownedRoot,
      keepRoot: true,
      secrets: allSecrets,
      ...options,
    });
  } catch (error) {
    // A launch may fail BEFORE a run handle is returned. Do not discard its
    // retained-root/unknown-termination result in the harness finally block.
    if (error.cleanupConfirmed !== true) launchCleanupConfirmed = false;
    throw error;
  }
  launchedRuns.push(run);
  active = run;
  if (timedOut) {
    await run.stop({ failure: true }).catch(() => {});
    throw new SmokeAssertion('watchdog-timeout');
  }
  run.pageErrors = false;
  run.page?.on('pageerror', () => {
    run.pageErrors = true;
  });
  return run;
}
async function closeRun(run) {
  requireTrue(!run.pageErrors, 'renderer-no-errors');
  await assertDiskAndLogs(run);
  const proof = await run.stop();
  requireTrue(
    proof.exitZero &&
      proof.ownedProcessesExited &&
      proof.plaintextAbsent &&
      proof.logsBounded &&
      proof.logsScrubbed,
    'owned-normal-exit-zero',
  );
  await assertDiskAndLogs(run);
  active = undefined;
  return proof;
}

const watchdog = setTimeout(() => {
  timedOut = true;
  void active?.stop({ failure: true }).catch(() => {});
}, 480000);
const signalHandler = () => {
  timedOut = true;
  void active?.stop({ failure: true }).catch(() => {});
};
process.once('SIGINT', signalHandler);
process.once('SIGTERM', signalHandler);
try {
  if (process.platform !== 'linux')
    throw new BlockedCheck('packaged-acceptance-linux-runtime-required');
  if (executable && !existsSync(resolve(executable))) throw new BlockedCheck('artifact-not-found');
  ownedRoot = await mkdtemp(join(tmpdir(), 'workspace-packaged-credential-acceptance-'));
  active = await startRun();
  stage = 'human-formal-status';
  const real = validateStatus(await command(active.page, 'credentials.status'));
  if (!development && !real.available) throw new BlockedCheck('native-secure-storage-unavailable');
  stage = 'actual-packaged-product-identity';
  const identity = await packagedIdentity(active);
  stage = 'agent-runtime-boundary';
  await agentBoundary(active);
  stage = 'real-status-ui';
  await active.page.getByRole('button', { name: /⚙ (Settings|設定)/ }).click();
  await inspectDialog(active.page, await settledDialog(active.page), {
    available: real.available,
    settings: true,
    language: 'zh-TW',
  });
  await closeDialog(active.page);
  // The empty-workspace UI matrix MUST precede any created connection.
  await uiMatrix(active, real);
  let persisted;
  if (!development) {
    stage = 'positive-real-form-save';
    persisted = await positiveSave(active);
    stage = 'positive-close-before-restart';
    await closeRun(active);
    stage = 'same-artifact-profile-restart';
    active = await startRun();
    const restartedIdentity = await packagedIdentity(active);
    requireTrue(
      restartedIdentity.name === identity.name &&
        restartedIdentity.version === identity.version &&
        restartedIdentity.applicationHash === identity.applicationHash &&
        restartedIdentity.data === identity.data &&
        restartedIdentity.profile === identity.profile,
      'same-product-and-isolation-after-restart',
    );
    const restartedStatus = validateStatus(await command(active.page, 'credentials.status'));
    if (!restartedStatus.available) throw new BlockedCheck('restart-secure-storage-unavailable');
    const list = await command(active.page, 'connection.list');
    requireTrue(
      list.length === 1 && list[0].id === persisted.saved.id && ipcNonsecret(list),
      'restart-list-no-password',
    );
    requireTrue(
      persisted.bytes.equals(await credentialBytes(active.dataDir)),
      'exact-existing-ciphertext-after-restart',
    );
    stage = 'real-main-persisted-decrypt';
    await realPersistedCredentialGet(active, persisted.saved);
  }
  stage = 'positive-close-before-real-unavailable-child';
  await closeRun(active);
  stage = 'unreachable-session-bus-child-launch';
  active = await startRun({ unavailable: true });
  stage = 'actual-unavailable-provider-status';
  const unavailableStatus = await verifyActualUnavailableProvider(active, identity);
  if (persisted)
    requireTrue(
      persisted.bytes.equals(await credentialBytes(active.dataDir)),
      'unavailable-launch-existing-bytes-preserved',
    );
  stage = 'actual-unavailable-existing-refusal';
  await negativeAndSqlite(active, { existing: persisted?.saved });
  await verifyActualUnavailableProvider(active, identity);
  if (persisted)
    requireTrue(
      persisted.bytes.equals(await credentialBytes(active.dataDir)),
      'unavailable-existing-bytes-preserved',
    );
  await closeRun(active);
  // Restore availability by launching another NORMAL process with the original
  // inherited session-bus environment, not by restoring a patched function.
  stage = 'positive-provider-restored-after-real-negative';
  active = await startRun();
  const restoredIdentity = await packagedIdentity(active);
  requireTrue(
    ['name', 'version', 'applicationHash', 'data', 'profile'].every(
      (key) => restoredIdentity[key] === identity[key],
    ),
    'same-product-profile-restored',
  );
  const restoredStatus = validateStatus(await command(active.page, 'credentials.status'));
  requireTrue(
    restoredStatus.available === real.available &&
      restoredStatus.backend === real.backend &&
      restoredStatus.selectionSource === real.selectionSource,
    'real-provider-restored',
  );
  if (persisted) {
    requireTrue(
      persisted.bytes.equals(await credentialBytes(active.dataDir)),
      'restored-existing-bytes-preserved',
    );
    await realPersistedCredentialGet(active, persisted.saved);
  }
  stage = 'native-graceful-close';
  await closeRun(active);
  stage = 'explicit-basic-existing-refusal';
  active = await startRun({ basic: true });
  await negativeAndSqlite(active, { basic: true, existing: persisted?.saved });
  if (persisted)
    requireTrue(
      persisted.bytes.equals(await credentialBytes(active.dataDir)),
      'basic-existing-bytes-preserved',
    );
  await closeRun(active);
  let normalClose;
  if (!development) {
    stage = 'no-debug-normal-visible-window-close';
    active = await startRun({ debugging: false, inspector: false });
    requireTrue(
      !active.args.some((arg) => /remote-debugging|inspect|password-store|no-sandbox/.test(arg)),
      'no-debug-normal-launch-flags',
    );
    normalClose = await closeRun(active);
    requireTrue(normalClose.normalWindowClose, 'owned-visible-window-protocol-close');
    const workspace = JSON.parse(await readFile(join(ownedRoot, 'data', 'workspace.json'), 'utf8'));
    requireTrue(
      Array.isArray(workspace.tabs) && workspace.tabs.length === 0 && !workspace.activeTab,
      'normal-close-workspace-cleanup',
    );
  }
  requireTrue(!timedOut, 'watchdog-timeout');
  for (const run of launchedRuns)
    requireTrue(
      !run.logs.plaintextFound && run.logs.bounded && run.logs.scrubbed,
      'all-lifecycle-logs-no-plaintext',
    );
  // Remove all synthetic metadata/ciphertext/profile files before reporting pass.
  await removeIsolatedRoot(ownedRoot, launchedRuns, launchCleanupConfirmed);
  requireTrue(!existsSync(ownedRoot), 'owned-scratch-removed');
  ownedRoot = undefined;
  console.log(
    JSON.stringify({
      success: true,
      developmentHarness: development,
      packagedCertification: !development,
      realBackendAvailable: real.available,
      realBackend: real.backend,
      selectionSource: real.selectionSource,
      actualUnavailableProvider: true,
      unavailableProvenance: 'child-DBUS_SESSION_BUS_ADDRESS-unreachable-owned-socket',
      unavailableBackend: unavailableStatus.backend,
      unavailableSelectionSource: unavailableStatus.selectionSource,
      unavailableReason: unavailableStatus.reason,
      unavailableNativeEncryptionAvailable: false,
      providerMethodsPatched: false,
      actualPackaged: !development,
      formalHumanStatus: true,
      runtimeAgentDenied: true,
      mcpCatalogHidden: true,
      uiMatrix: true,
      uiMatrixCases: 8,
      uiStatesPerCase: 3,
      uiFixtures: true,
      uiFixturesOnlyNonsecretStatus: true,
      positiveFormSave: !!persisted,
      savedIdVerified: !!persisted,
      ipcPasswordsAbsent: true,
      passwordBearingSaveResponseNonsecret: !!persisted,
      persistedCiphertext: !!persisted,
      sameArtifactProfileRestart: !!persisted,
      realMainCredentialServiceGet: !!persisted,
      unavailableSaveRefused: true,
      existingOverwriteRefused: !!persisted,
      existingCiphertextPreserved: !!persisted,
      failedSaveFileMetadataUnchanged: true,
      sqliteUsable: true,
      plaintextAbsent: true,
      childLogsBoundedAndScrubbed: true,
      basicNegative: true,
      loopbackOwnedMainVerified: true,
      noDebugVisibleWindowClose: !!normalClose,
      normalCloseMechanism: normalClose
        ? 'owned-X11-WM_DELETE_WINDOW'
        : 'development-not-requested',
      exitZero: true,
      ownedProcessesExited: true,
      ownershipLedger: 'observed-pid-proc-starttime',
      identityVerifiedFailureSignals: 'pidfd-original-group-members-and-escaped-descendants',
      scratchRemovalRequiresOwnedTermination: true,
      workspaceCleanup: !!normalClose,
      scratchRemoved: true,
    }),
  );
} catch (error) {
  const blocked =
    error instanceof BlockedCheck || (error instanceof NativeLaunchError && error.blocked);
  console.error(
    JSON.stringify({
      success: false,
      result: blocked ? 'BLOCKED' : 'FAILED',
      stage,
      timedOut,
      check:
        error instanceof SmokeAssertion ||
        error instanceof BlockedCheck ||
        error instanceof NativeLaunchError
          ? error.message
          : 'suppressed',
      detailsSuppressed: true,
      errorKind:
        error?.name === 'TimeoutError'
          ? 'timeout'
          : error?.name === 'TargetClosedError'
            ? 'target-closed'
            : 'other',
    }),
  );
  process.exitCode = blocked ? 2 : 1;
} finally {
  clearTimeout(watchdog);
  process.off('SIGINT', signalHandler);
  process.off('SIGTERM', signalHandler);
  for (const run of launchedRuns) await run.stop({ failure: true }).catch(() => {});
  if (ownedRoot) {
    try {
      await removeIsolatedRoot(ownedRoot, launchedRuns, launchCleanupConfirmed);
      ownedRoot = undefined;
    } catch {
      // Never claim successful cleanup, or delete data still used by a child.
      console.error(
        JSON.stringify({
          success: false,
          result: 'FAILED',
          stage: 'owned-root-cleanup',
          check: 'owned-cleanup-not-proven-or-root-removal-failed',
          scratchRetained: existsSync(ownedRoot),
          scratchRemoved: false,
          detailsSuppressed: true,
        }),
      );
      process.exitCode = 1;
    }
  }
}
