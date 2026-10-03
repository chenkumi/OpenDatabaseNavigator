import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const agent = process.argv.includes('--agent');

// electron-builder's `--dir` output differs per platform and architecture.
function defaultExecutable() {
  const candidates =
    process.platform === 'win32'
      ? ['release/win-unpacked/Database Workspace.exe']
      : process.platform === 'darwin'
        ? [
            `release/mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}/Database Workspace.app/Contents/MacOS/Database Workspace`,
            'release/mac/Database Workspace.app/Contents/MacOS/Database Workspace',
          ]
        : ['release/linux-unpacked/database-workspace'];
  return resolve(candidates.find((path) => existsSync(path)) ?? candidates[0]);
}

const executable =
  process.argv.slice(2).find((value) => value !== '--agent') || defaultExecutable();
if (!existsSync(executable))
  throw new Error(`Packaged app not found at ${executable}. Run \`npm run package\` first.`);
// Native modules cannot load from inside app.asar. msnodesqlv8 (Windows authentication)
// must therefore ship unpacked; check that, since an asarUnpack typo only fails at runtime.
if (process.platform === 'win32') {
  const unpacked = join(
    dirname(executable),
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'msnodesqlv8',
  );
  if (!existsSync(unpacked))
    throw new Error(`msnodesqlv8 is not unpacked from app.asar (expected ${unpacked}).`);
}
const result = spawnSync(
  process.execPath,
  [agent ? 'scripts/smoke-agent-redis.mjs' : 'scripts/smoke-electron.mjs'],
  {
    env: { ...process.env, DATABASE_WORKSPACE_EXECUTABLE: executable },
    stdio: 'inherit',
  },
);
process.exit(result.status ?? 1);
