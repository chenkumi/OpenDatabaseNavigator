import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
} from 'electron';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Application, HUMAN } from './application/application';
import { JsonStore } from './application/services/store';
import { CredentialService } from './credentials/credential-service';
import { bootstrapSecureStorage } from './credentials/storage-bootstrap';
import { SecureStorageService, registerSecureStorageCommands } from './credentials/secure-storage-service';
import { createAdapter } from './database/factory';
import { McpGateway, validateMcpConfig } from './mcp/server/mcp-server';
import { DEFAULT_SETTINGS } from '../shared/types';
import { settingsSchema } from '../shared/schemas';
import { installMenu } from './menu';
import { readSqlFile } from './application/services/sql-file';
import { writeFile } from 'node:fs/promises';

// Select synchronously, before app ready or any safeStorage initialization.
const storageSelection = bootstrapSecureStorage(app);

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'workspace',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const location = dirname(fileURLToPath(import.meta.url));
let core: Application;
let gateway: McpGateway;
let quitting = false;
function allowDiscard() {
  if (!core?.workspace.get().tabs.some((tab) => tab.dirty)) return true;
  const chinese = core.getSettings().language === 'zh-TW';
  const accepted =
    dialog.showMessageBoxSync({
      type: 'question',
      title: chinese ? '尚未儲存的變更' : 'Unsaved changes',
      message: chinese
        ? '關閉工作區並捨棄尚未儲存的資料修改？'
        : 'Close the workspace and discard unsaved data edits?',
      detail: chinese
        ? '查詢 SQL 文字會自動儲存。尚未套用的資料列、結構與 Redis 修改會被捨棄。'
        : 'Query SQL text is saved automatically. Unapplied row, structure and Redis changes will be discarded.',
      buttons: chinese ? ['繼續編輯', '捨棄並關閉'] : ['Keep working', 'Discard and close'],
      defaultId: 0,
      cancelId: 0,
    }) === 1;
  if (accepted)
    for (const tab of core.workspace.get().tabs)
      if (tab.dirty)
        core.workspace.update(tab.id, {
          dirty: false,
          ...(tab.objectVersion ? { sql: '', objectVersion: '' } : {}),
        });
  return accepted;
}
async function boot() {
  const data = process.env.DATABASE_WORKSPACE_DATA_DIR || app.getPath('userData');
  const secureStorage = new SecureStorageService(safeStorage, storageSelection);
  const credentials = new CredentialService(
    new JsonStore(join(data, 'credentials.json'), {}), secureStorage,
  );
  core = new Application(
    {
      connections: new JsonStore(join(data, 'connections.json'), []),
      workspace: new JsonStore(join(data, 'workspace.json'), { tabs: [] }),
      settings: new JsonStore(join(data, 'settings.json'), DEFAULT_SETTINGS),
      history: new JsonStore(join(data, 'history.json'), []),
      audit: new JsonStore(join(data, 'audit.json'), []),
    },
    credentials,
    createAdapter,
  );
  registerSecureStorageCommands(core.commands, secureStorage);
  // Tabs do not survive a restart; this also clears what an abnormal exit left behind.
  core.workspace.reset();
  gateway = new McpGateway(core, credentials);
  core.commands.register('clipboard.result.copy', {
    schema: z.object({ content: z.string().max(16 * 1024 * 1024) }).strict(),
    humanOnly: true,
    risk: 'read',
    description: 'Copy displayed result content to the desktop clipboard.',
    auditArguments: ({ content }) => ({ bytes: Buffer.byteLength(content, 'utf8') }),
    execute: ({ content }) => {
      if (Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024)
        throw new Error('Clipboard content exceeds 16 MiB.');
      clipboard.writeText(content);
      return { copied: true };
    },
  });
  core.commands.register('file.result.save', {
    schema: z
      .object({ format: z.enum(['csv', 'json']), content: z.string().max(16 * 1024 * 1024) })
      .strict(),
    humanOnly: true,
    risk: 'read',
    description: 'Save the current result page through the native desktop picker.',
    auditArguments: ({ format, content }) => ({
      format,
      bytes: Buffer.byteLength(content, 'utf8'),
    }),
    execute: async ({ format, content }) => {
      if (Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024)
        throw new Error('Result export exceeds 16 MiB.');
      const selected = await dialog.showSaveDialog({
        title: core.getSettings().language === 'zh-TW' ? '匯出目前頁結果' : 'Export current page',
        defaultPath: `query-results.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (selected.canceled || !selected.filePath) return null;
      await writeFile(selected.filePath, content, 'utf8');
      return { saved: true };
    },
  });
  core.commands.register('file.sql.open', {
    schema: z.object({}).strict(),
    humanOnly: true,
    risk: 'workspace',
    description: 'Choose and read a local SQL file using the native desktop picker.',
    execute: async () => {
      const selected = await dialog.showOpenDialog({
        title: core.getSettings().language === 'zh-TW' ? '選擇 SQL 檔案' : 'Choose SQL file',
        properties: ['openFile'],
        filters: [{ name: 'SQL', extensions: ['sql'] }],
      });
      return selected.canceled || !selected.filePaths[0]
        ? null
        : readSqlFile(selected.filePaths[0]);
    },
  });
  core.commands.register('file.sql.save-export', {
    schema: z.object({ id: z.string().uuid() }).strict(),
    humanOnly: true,
    risk: 'read',
    description: 'Save a completed SQL export using the native desktop picker.',
    execute: async ({ id }, actor) => {
      const progress = core.exports.status(id, actor);
      if (progress.state !== 'completed') throw new Error('SQL export is not ready.');
      const selected = await dialog.showSaveDialog({
        title: core.getSettings().language === 'zh-TW' ? '儲存 SQL 匯出檔' : 'Save SQL export',
        defaultPath: 'database-export.sql',
        filters: [{ name: 'SQL', extensions: ['sql'] }],
      });
      return selected.canceled || !selected.filePath
        ? null
        : core.exports.save(id, selected.filePath, actor);
    },
  });
  core.commands.register('mcp.status', {
    schema: z.object({}).strict(),
    humanOnly: true,
    risk: 'read',
    description: 'MCP status',
    execute: () => gateway.status(),
  });
  core.commands.register('mcp.token', {
    schema: z.object({}).strict(),
    humanOnly: true,
    risk: 'read',
    description: 'Reveal local access token to desktop user',
    execute: () => ({ token: gateway.token() }),
  });
  core.commands.register('mcp.rotate_token', {
    schema: z.object({}).strict(),
    humanOnly: true,
    risk: 'workspace',
    description: 'Revoke the previous token and all agent sessions',
    execute: async () => {
      const token = await gateway.rotateToken();
      await gateway.start(core.getSettings().mcp);
      return { token };
    },
  });
  const rendererRoot = resolve(location, '../renderer');
  protocol.handle('workspace', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Forbidden', { status: 403 });
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const path = resolve(rendererRoot, '.' + pathname);
    if (!path.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(path).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  const createWindow = () => {
    const window = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 1000,
      minHeight: 650,
      show: false,
      backgroundColor: '#11151d',
      title: 'Database Workspace',
      webPreferences: {
        preload: join(location, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (!quitting && !allowDiscard()) event.preventDefault();
    });
    window.once('ready-to-show', () => {
      if (!process.env.DATABASE_WORKSPACE_HEADLESS) window.show();
    });
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
      void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadURL('workspace://app/index.html');
    return window;
  };
  const validSender = (event: Electron.IpcMainInvokeEvent) => {
    const expected =
      !app.isPackaged && process.env.ELECTRON_RENDERER_URL
        ? new URL(process.env.ELECTRON_RENDERER_URL).origin
        : 'workspace://app';
    const url = event.senderFrame?.url ?? '';
    return (
      event.senderFrame === event.sender.mainFrame &&
      (url === `${expected}/index.html` || url === `${expected}/`)
    );
  };
  let settingsQueue: Promise<unknown> = Promise.resolve();
  ipcMain.handle('application:command', async (event, name, args) => {
    if (!validSender(event) || typeof name !== 'string')
      return { success: false, error: 'Untrusted IPC sender.' };
    if (name === 'settings.save') {
      try {
        validateMcpConfig(settingsSchema.parse(args).mcp);
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
      // Saves run one at a time so a rollback can never overwrite a newer save.
      const run = settingsQueue.then(async () => {
        const previous = core.getSettings();
        const result = await core.commands.dispatch(name, args, HUMAN);
        if (
          result.success &&
          JSON.stringify(core.getSettings().mcp) !== JSON.stringify(previous.mcp)
        ) {
          // Restarting drops every agent session, so do it only when MCP itself changed.
          try {
            await gateway.start(core.getSettings().mcp);
          } catch (error) {
            await core.commands.dispatch('settings.save', previous, HUMAN);
            await gateway.start(previous.mcp).catch(() => undefined);
            return { success: false, error: (error as Error).message };
          }
        }
        return result;
      });
      settingsQueue = run.catch(() => undefined);
      return run;
    }
    return core.commands.dispatch(name, args, HUMAN);
  });
  ipcMain.handle('application:choose-database', async (event) => {
    if (!validSender(event)) throw new Error('Untrusted IPC sender.');
    const selected = await dialog.showOpenDialog({
      title: 'Open SQLite database',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return selected.filePaths[0];
  });
  core.events.subscribe((event) => {
    if (event.type === 'SettingsChanged') installMenu(core.getSettings().language);
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send('application:event', event);
  });
  installMenu(core.getSettings().language);
  createWindow();
  await gateway
    .start(core.getSettings().mcp)
    .catch((error) => dialog.showErrorBox('MCP could not start', (error as Error).message));
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}
app
  .whenReady()
  .then(boot)
  .catch((error) => {
    dialog.showErrorBox('Startup failed', (error as Error).message);
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (!allowDiscard()) return;
  quitting = true;
  core?.workspace.reset();
  core?.scripts.cancelAll();
  Promise.all([gateway?.stop(), core?.connections.shutdown(), core?.exports.shutdown()]).finally(
    () => app.quit(),
  );
});
