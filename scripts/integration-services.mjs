import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const action = process.argv[2] ?? 'up';
if (!['up', 'stop', 'status'].includes(action)) throw new Error('Expected up, stop, or status.');
if (!existsSync('.local/integration.env')) {
  mkdirSync('.local', { recursive: true });
  writeFileSync(
    '.local/integration.env',
    `DB_TEST_PASSWORD=Dw!${randomBytes(24).toString('hex')}\n`,
    { mode: 0o600 },
  );
}
const command = action === 'up' ? ['up', '-d'] : action === 'status' ? ['ps'] : ['stop'];
const result = spawnSync(
  'docker',
  ['compose', '--env-file', '.local/integration.env', '-f', 'compose.integration.yml', ...command],
  { stdio: 'inherit', windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
