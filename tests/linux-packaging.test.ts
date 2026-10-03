import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const afterPack = require('../scripts/after-pack.cjs') as (context: {
  electronPlatformName: string;
  appOutDir: string;
  packager: { config: Record<string, unknown> };
}) => Promise<void>;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directories: string[] = [];
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'database workspace packaging '));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function installLauncher(path: string, platform = 'linux', config = {}) {
  await afterPack({ electronPlatformName: platform, appOutDir: path, packager: { config } });
}
async function installNative(path: string) {
  await writeFile(
    join(path, 'database-workspace'),
    `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2), desktop: process.env.XDG_CURRENT_DESKTOP, session: process.env.DESKTOP_SESSION, bus: process.env.DBUS_SESSION_BUS_ADDRESS, marker: process.env.PACKAGING_TEST_MARKER }));
process.exit(Number(process.env.PACKAGING_TEST_EXIT || 0));
`,
    { mode: 0o755 },
  );
}
function launch(path: string, args: string[], withAppDir: boolean, exit = 0) {
  const env = {
    ...process.env,
    XDG_CURRENT_DESKTOP: 'Unchanged:KDE',
    DESKTOP_SESSION: 'test-session',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/test-only',
    PACKAGING_TEST_MARKER: 'unchanged',
    PACKAGING_TEST_EXIT: String(exit),
  } as Record<string, string | undefined>;
  if (withAppDir) env.APPDIR = path;
  else delete env.APPDIR;
  return spawnSync(join(path, 'AppRun'), args, { cwd: tmpdir(), env, encoding: 'utf8' });
}

describe.skipIf(process.platform !== 'linux')('Linux fail-closed AppImage packaging', () => {
  it('pins the supported static toolset and explicit empty desktop arguments', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    expect(pkg.build.toolsets.appimage).toBe('1.0.3');
    expect(pkg.build.afterPack).toBe('scripts/after-pack.cjs');
    expect(pkg.build.appImage.executableArgs).toEqual([]);
    expect(pkg.build.linux.target).toBe('AppImage');
    expect(pkg.build.linux.desktop).toBeUndefined();
    expect(pkg.build.appImage.license).toBeUndefined();
    expect(pkg.license).toBe('MIT');
    expect(pkg.build.win.target).toBe('nsis');
    expect(pkg.build.mac.target).toBe('dmg');
    const source = await readFile(join(root, 'scripts/linux-app-run.sh'), 'utf8');
    expect(source).not.toMatch(
      /--no-sandbox|unshare|password-store|export\s|APPIMAGE_EXTRACT|eulaAccepted/,
    );
    expect(source).toContain('exec "$app_dir/database-workspace" "$@"');
  });

  it('copies the exact project launcher into Linux output with executable permission', async () => {
    const path = await fixture();
    await installLauncher(path);
    expect(await readFile(join(path, 'AppRun'), 'utf8')).toBe(
      await readFile(join(root, 'scripts/linux-app-run.sh'), 'utf8'),
    );
    expect((await stat(join(path, 'AppRun'))).mode & 0o777).toBe(0o755);
  });

  it.each(['darwin', 'win32'])('does not modify %s output', async (platform) => {
    const path = await fixture();
    await writeFile(join(path, 'AppRun'), 'existing file');
    await installLauncher(path, platform);
    expect(await readFile(join(path, 'AppRun'), 'utf8')).toBe('existing file');
  });

  it.each([{ appImage: { license: 'EULA.txt' } }, { linux: { license: 'EULA.html' } }])(
    'refuses an explicitly configured EULA rather than accepting/bypassing it',
    async (config) => {
      const path = await fixture();
      await expect(installLauncher(path, 'linux', config)).rejects.toThrow(
        'does not support EULA acceptance',
      );
      await expect(stat(join(path, 'AppRun'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([true, false])(
    'preserves all arguments and session environment (APPDIR=%s)',
    async (withAppDir) => {
      const path = await fixture();
      await installLauncher(path);
      await installNative(path);
      const args = [
        'space containing value',
        '',
        'quote\'and"double',
        '--password-store=kwallet6',
        'line\nvalue',
        '*;$HOME',
        '--',
      ];
      const result = launch(path, args, withAppDir);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        args,
        desktop: 'Unchanged:KDE',
        session: 'test-session',
        bus: 'unix:path=/test-only',
        marker: 'unchanged',
      });
    },
  );

  it('passes no arguments when invoked with no arguments', async () => {
    const path = await fixture();
    await installLauncher(path);
    await installNative(path);
    const result = launch(path, [], true);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).args).toEqual([]);
  });

  it('propagates native startup failure without fallback or retry', async () => {
    const path = await fixture();
    await installLauncher(path);
    await installNative(path);
    const result = launch(path, ['keep-this'], true, 73);
    expect(result.status).toBe(73);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout).args).toEqual(['keep-this']);
  });

  it('fails closed when the native executable is missing', async () => {
    const path = await fixture();
    await installLauncher(path);
    const result = launch(path, [], true);
    expect(result.status).toBe(127);
    expect(result.stdout).toBe('');
  });
});
