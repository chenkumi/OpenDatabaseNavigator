import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Password of the integration services. The environment wins; otherwise the
 * git-ignored `.local/integration.env` is read. The value is never printed.
 */
export function integrationPassword() {
  const fromEnvironment = process.env.DB_TEST_PASSWORD?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (!existsSync('.local/integration.env'))
    throw new Error('Run `npm run integration:up` first, or set DB_TEST_PASSWORD.');
  const found = /^DB_TEST_PASSWORD=(.+)$/m.exec(
    readFileSync('.local/integration.env', 'utf8'),
  )?.[1];
  if (!found?.trim()) throw new Error('.local/integration.env does not define DB_TEST_PASSWORD.');
  return found.trim();
}

/**
 * Scratch directory that is removed when the script exits, pass or fail. Smoke
 * data directories hold encrypted test credentials, audit and history files, so
 * they must not pile up in the temp folder. Set KEEP_SMOKE_DATA=1 to inspect one.
 */
export function scratchDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  if (!process.env.KEEP_SMOKE_DATA)
    process.on('exit', () => {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* A still-closing Electron process may hold a file; the OS temp cleaner takes it later. */
      }
    });
  return directory;
}

/**
 * Electron switch giving a smoke run its own profile. Without it every run shares
 * the real app's localStorage, so layouts saved by one test (and the developer's own
 * preferences) leak into the next.
 */
export function isolatedProfile() {
  return '--user-data-dir=' + scratchDir('dw-profile-');
}
