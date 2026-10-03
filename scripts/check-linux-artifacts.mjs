import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { extractFile, listPackage } from '@electron/asar';

// Read-only artifact validation. Never launches the GUI, touches a keyring,
// rewrites a desktop/launcher file, or repairs host permissions/dependencies.
// unsquashfs is a validation prerequisite, not an automatically installed tool.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'release');
const executable = join(output, 'linux-unpacked', 'database-workspace');
const asar = join(dirname(executable), 'resources', 'app.asar');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const report = {
  schemaVersion: 1,
  identity: {
    appId: pkg.build.appId,
    productName: pkg.build.productName,
    name: pkg.name,
    version: pkg.version,
  },
  checks: [],
  artifacts: [],
  startup: {
    status: 'NOT_TESTED',
    reason: 'Static inspection and Electron-as-Node only; this is not a GUI/keyring startup test.',
  },
};
async function check(name, run) {
  try {
    const detail = await run();
    report.checks.push({ name, status: 'PASS', ...(detail === undefined ? {} : { detail }) });
  } catch (error) {
    report.checks.push({ name, status: 'FAIL', detail: error.message });
  }
}
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${binary} exited ${result.status}: ${result.stderr?.trim()}`);
  return result.stdout;
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function record(path) {
  const info = await stat(path);
  report.artifacts.push({
    path: relative(root, path),
    bytes: info.size,
    sha256: await sha256(path),
    architecture: 'x64',
    version: pkg.version,
  });
}
async function elf(path, appImage = false) {
  await access(path, constants.X_OK);
  const { open } = await import('node:fs/promises');
  const file = await open(path, 'r');
  const header = Buffer.alloc(64);
  try {
    await file.read(header, 0, header.length, 0);
  } finally {
    await file.close();
  }
  assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46', 'not ELF');
  assert.equal(header[4], 2, 'not ELF64');
  assert.equal(header[5], 1, 'not little endian');
  assert.equal(header.readUInt16LE(18), 62, 'not x86-64');
  if (appImage)
    assert.equal(header.subarray(8, 11).toString('hex'), '414902', 'not a type-2 AppImage');
  await record(path);
}
const unsafeFlags =
  /--(?:no-sandbox|disable-setuid-sandbox|disable-seccomp-filter-sandbox|disable-gpu-sandbox|single-process)\b/;
const unsafeEnvironment =
  /(?:XDG_CURRENT_DESKTOP|DESKTOP_SESSION|GDMSESSION|GNOME_DESKTOP_SESSION_ID|KDE_FULL_SESSION|ELECTRON_DISABLE_SANDBOX|ELECTRON_RUN_AS_NODE|APPIMAGE_EXTRACT_AND_RUN)\s*=/;
function safeLauncher(text) {
  assert(
    !unsafeFlags.test(text),
    'launcher/desktop contains a sandbox-disabling flag (including conditional fallback)',
  );
  assert(!/--password-store\b/.test(text), 'launcher/desktop forces a credential backend');
  assert(
    !unsafeEnvironment.test(text),
    'launcher/desktop rewrites backend, desktop or runtime environment',
  );
}
await check('product identity and build configuration', () => {
  assert.deepEqual(report.identity, {
    appId: 'dev.database.workspace',
    productName: 'Database Workspace',
    name: 'database-workspace',
    version: '0.1.0',
  });
  assert.equal(pkg.main, 'dist/main/index.js');
  assert.equal(pkg.build.linux.target, 'AppImage');
  assert(!pkg.build.publish, 'unexpected automatic publishing configuration');
  assert(!pkg.build.linux.desktop, 'unexpected desktop override');
  assert(!pkg.build.appImage?.desktop, 'unexpected AppImage desktop override');
  assert.equal(pkg.build.toolsets?.appimage, '1.0.3');
  assert.equal(pkg.build.afterPack, 'scripts/after-pack.cjs');
  assert.deepEqual(pkg.build.appImage?.executableArgs, []);
  assert.equal(pkg.license, 'MIT');
  assert(
    !pkg.build.appImage?.license && !pkg.build.linux.license,
    'minimal launcher cannot implement EULA acceptance',
  );
  const require = createRequire(import.meta.url);
  const { appimageChecksums } = require('app-builder-lib/out/toolsets/linux.js');
  assert.equal(
    appimageChecksums['1.0.3']['appimage-tools-runtime-20251108.tar.gz'],
    '84021a78ee214ae6fd33a2d62a92ba25542dd10bc86bf117a9b2d0bba44e7665',
    'installed builder does not support the expected pinned toolset checksum',
  );
  safeLauncher(JSON.stringify({ linux: pkg.build.linux, appImage: pkg.build.appImage }));
});
await check('unpacked executable ELF64 x64 and executable permission', () => elf(executable));
let entries;
let main;
await check('ASAR entry points, bundled storage policy/service and renderer assets', async () => {
  entries = new Set(listPackage(asar).map((path) => path.replace(/^\//, '')));
  for (const path of [
    'package.json',
    'dist/main/index.js',
    'dist/preload/index.cjs',
    'dist/renderer/index.html',
  ])
    assert(entries.has(path), `missing ${path}`);
  const identity = JSON.parse(extractFile(asar, 'package.json').toString());
  assert.equal(identity.name, pkg.name);
  assert.equal(identity.version, pkg.version);
  assert.equal(identity.main, pkg.main);
  main = extractFile(asar, pkg.main).toString();
  assert.equal(
    main,
    await readFile(join(root, pkg.main), 'utf8'),
    'ASAR main differs from current build',
  );
  for (const marker of [
    'function selectStorageBackend(',
    'function bootstrapSecureStorage(',
    'class SecureStorageService',
    'function registerSecureStorageCommands(',
    'credentials.status',
    'wsl-libsecret',
    'const storageSelection = bootstrapSecureStorage(app)',
    'app.getPath("userData")',
    'ELECTRON_RUN_AS_NODE',
    "require('node:sqlite')",
  ])
    assert(main.includes(marker), `main missing embedded runtime marker: ${marker}`);
  assert(
    !/storage-bootstrap\.(?:mjs|ts)|secure-storage-service\.(?:mjs|ts)/.test(main),
    'storage runtime was left as an unresolved external import',
  );
  assert(!/app\.set(?:Name|Path)\(/.test(main), 'unexpected product/userData identity rewrite');
  assert(!unsafeFlags.test(main), 'unsafe startup flag in bundled main');
  assert(
    main.indexOf('const storageSelection = bootstrapSecureStorage(app)') <
      main.indexOf('app.whenReady()'),
    'storage policy runs after ready',
  );
  const html = extractFile(asar, 'dist/renderer/index.html').toString();
  const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)].map(
    (match) => `dist/renderer/${match[1]}`,
  );
  assert(
    assets.some((path) => path.endsWith('.js')) && assets.some((path) => path.endsWith('.css')),
    'renderer entry assets not found',
  );
  for (const path of assets) assert(entries.has(path), `missing renderer asset ${path}`);
  assert(
    extractFile(asar, 'dist/preload/index.cjs').toString().includes('contextBridge'),
    'preload bridge not bundled',
  );
  await record(asar);
  return {
    requiredEntries: [
      'package.json',
      pkg.main,
      'dist/preload/index.cjs',
      'dist/renderer/index.html',
      ...assets,
    ],
    policyAndService: 'embedded in main',
    electronIdentityName: identity.name,
    defaultUserDataDirectoryName: identity.name,
  };
});
await check('packaged Electron-as-Node ASAR resolution and SQLite child runtime', async () => {
  // No app/safeStorage import. Exercise the exact shipped executable, built-in
  // SQLite and a main dependency resolved inside app.asar, not host node_modules.
  const source = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { createRequire } = require('node:module');
    const asar = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(asar + '/package.json', 'utf8'));
    const dep = createRequire(asar + '/' + pkg.main);
    assert(dep('zod').z);
    assert(fs.readFileSync(asar + '/dist/preload/index.cjs', 'utf8').includes('contextBridge'));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('create table verification (value text);');
    db.prepare('insert into verification values (?)').run('packaged-sqlite');
    assert.equal(db.prepare('select value from verification').get().value, 'packaged-sqlite');
    db.close();
    console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite, arch: process.arch, name: pkg.name, version: pkg.version, asarResolution: true, sqliteRoundtrip: true }));
  `;
  const result = JSON.parse(
    command(executable, ['-e', source, asar], {
      cwd: output,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }),
  );
  const installedElectron = JSON.parse(
    await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'),
  );
  assert.equal(result.electron, installedElectron.version);
  assert.equal(result.arch, 'x64');
  assert.equal(result.name, pkg.name);
  assert.equal(result.version, pkg.version);
  return result;
});
const appImage = join(output, `${pkg.build.productName}-${pkg.version}.AppImage`);
await check('AppImage executable, ELF64 x64, type-2 signature and SHA-256', () =>
  elf(appImage, true),
);
let offset;
await check('actual AppImage runtime and embedded SquashFS', async () => {
  const runtimeVersion = spawnSync(appImage, ['--appimage-version'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ifError(runtimeVersion.error);
  assert.equal(runtimeVersion.status, 0, 'AppImage runtime version probe failed');
  // Legacy runtimes print their version to stderr, not stdout.
  const version = `${runtimeVersion.stdout}${runtimeVersion.stderr}`.trim();
  assert(version, 'AppImage runtime version missing');
  offset = Number(command(appImage, ['--appimage-offset']).trim());
  assert(Number.isSafeInteger(offset) && offset > 0, 'invalid AppImage filesystem offset');
  const { open } = await import('node:fs/promises');
  const file = await open(appImage, 'r');
  const runtime = Buffer.alloc(offset + 4);
  try {
    await file.read(runtime, 0, runtime.length, 0);
  } finally {
    await file.close();
  }
  assert.equal(runtime.subarray(offset).toString(), 'hsqs', 'SquashFS magic missing');
  const programHeaderOffset = Number(runtime.readBigUInt64LE(32));
  const programHeaderSize = runtime.readUInt16LE(54);
  const programHeaderCount = runtime.readUInt16LE(56);
  const hasInterpreter = Array.from({ length: programHeaderCount }, (_, index) =>
    runtime.readUInt32LE(programHeaderOffset + index * programHeaderSize),
  ).includes(3);
  // A static FUSE runtime does not need host libfuse2, even if strings from
  // statically linked code mention that library. Inspect ELF PT_INTERP too.
  const hostFuse2Required = hasInterpreter && runtime.includes(Buffer.from('libfuse.so.2'));
  report.runtime = {
    version,
    squashfsOffset: offset,
    static: !hasInterpreter,
    hostFuse2Required,
    toolset: pkg.build.toolsets.appimage,
  };
  assert(!hasInterpreter, 'configured static toolset produced a dynamic runtime');
  assert(!hostFuse2Required, 'static toolset unexpectedly requires host FUSE2');
  return report.runtime;
});
await check('actual embedded AppRun and desktop keep native sandbox/backend', async () => {
  assert(offset, 'runtime offset unavailable');
  // Static reads only: never use --appimage-extract-and-run or execute AppRun.
  const launcher = command('unsquashfs', ['-o', String(offset), '-cat', appImage, 'AppRun']);
  const desktop = command('unsquashfs', [
    '-o',
    String(offset),
    '-cat',
    appImage,
    `${pkg.name}.desktop`,
  ]);
  const projectLauncher = await readFile(join(root, 'scripts/linux-app-run.sh'), 'utf8');
  assert.equal(
    launcher,
    projectLauncher,
    'embedded AppRun differs from fail-closed project source',
  );
  assert.equal(
    await readFile(join(dirname(executable), 'AppRun'), 'utf8'),
    projectLauncher,
    'afterPack did not install the project AppRun',
  );
  await access(join(dirname(executable), 'AppRun'), constants.X_OK);
  assert(
    launcher.includes(`exec "$app_dir/${pkg.name}" "$@"`),
    'wrong executable/argument forwarding',
  );
  assert(
    !/unshare|eulaAccepted|APPIMAGE_EXTRACT|export\s/.test(launcher),
    'unexpected launcher fallback, EULA bypass or environment rewriting',
  );
  assert(desktop.includes(`Name=${pkg.build.productName}\n`), 'desktop productName differs');
  assert(desktop.includes(`X-AppImage-Version=${pkg.version}\n`), 'desktop version differs');
  // Evaluate both so reports expose desktop and conditional-launcher problems.
  const failures = [];
  for (const [name, text] of [
    ['AppRun', launcher],
    ['desktop', desktop],
  ]) {
    try {
      safeLauncher(text);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join('; '));
  const exec = desktop.match(/^Exec=(.*)$/m)?.[1];
  assert.equal(exec, 'AppRun %U', 'unexpected desktop launcher arguments');
  return {
    exec,
    projectAppRunSha256: await sha256(join(root, 'scripts/linux-app-run.sh')),
    exactProjectLauncher: true,
  };
});
await check('AppImage ships exactly the validated executable and ASAR', () => {
  assert(offset, 'runtime offset unavailable');
  for (const path of [pkg.name, 'resources/app.asar']) {
    // Stream unsquashfs stdout into a SHA256 consumer to avoid loading a large
    // executable/archive into memory; no shell, extraction or code execution.
    const source = `
      const { spawn } = require('node:child_process');
      const { createHash } = require('node:crypto');
      const child = spawn('unsquashfs', process.argv.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] });
      const hash = createHash('sha256');
      child.stdout.on('data', data => hash.update(data));
      child.on('error', error => { console.error(error.message); process.exitCode = 1; });
      child.on('close', code => { if (code === 0) console.log(hash.digest('hex')); else process.exitCode = code || 1; });
    `;
    const actual = command(process.execPath, [
      '-e',
      source,
      '--',
      '-o',
      String(offset),
      '-cat',
      appImage,
      path,
    ]).trim();
    const expected = report.artifacts.find(
      (artifact) => artifact.path === relative(root, join(dirname(executable), path)),
    )?.sha256;
    assert(expected, `no reference hash for ${path}`);
    assert.equal(actual, expected, `AppImage ${path} differs from unpacked artifact`);
  }
});
await check('host runtime prerequisites (inspection only, not GUI startup)', async () => {
  const libraries = command('ldconfig', ['-p']);
  const userns = spawnSync('unshare', ['-Ur', 'true'], { encoding: 'utf8', timeout: 10000 });
  let fuseDeviceAccessible = false;
  try {
    await access('/dev/fuse', constants.R_OK | constants.W_OK);
    fuseDeviceAccessible = true;
  } catch {
    /* absent/inaccessible */
  }
  const detail = {
    hostFuse2: libraries.includes('libfuse.so.2'),
    hostFuse3: libraries.includes('libfuse3.so.3'),
    fuseDeviceAccessible,
    unprivilegedUserNamespaceProbeExit: userns.status,
    displayConfigured: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    secretServiceLibrary: libraries.includes('libsecret-1.so.0'),
    keyringAvailability: 'NOT_TESTED (no keyring access in artifact checker)',
  };
  report.prerequisites = detail;
  if (report.runtime?.hostFuse2Required && !detail.hostFuse2)
    report.startup = {
      status: 'BLOCKED',
      reason:
        'Actual legacy runtime requires libfuse.so.2; host has no FUSE2 library. No GUI startup claimed.',
    };
  return detail;
});
// Avoid stale installer ambiguity: require the expected current-version artifact.
await check('single current-version AppImage artifact', async () => {
  assert.deepEqual((await readdir(output)).filter((name) => name.endsWith('.AppImage')).sort(), [
    `${pkg.build.productName}-${pkg.version}.AppImage`,
  ]);
});
report.status = report.checks.some((result) => result.status === 'FAIL') ? 'FAIL' : 'PASS';
const manifest = join(output, 'linux-artifacts.json');
await writeFile(manifest, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Artifact manifest: ${relative(root, manifest)}`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
