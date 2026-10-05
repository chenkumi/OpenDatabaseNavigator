import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';

const local = existsSync('.local/sybase.env')
  ? parseEnv(readFileSync('.local/sybase.env', 'utf8'))
  : {};
const env = { ...local, ...process.env, ASE_READONLY_INTEGRATION: '1', ASE_INTEGRATION: '0' };
console.log('Starting ASE read-only verification. No CRUD, DDL or native export will run.');
for (const name of ['ASE_HOST', 'ASE_DATABASE', 'ASE_USERNAME', 'ASE_PASSWORD']) {
  if (!env[name])
    throw new Error(
      `Missing ${name}. Configure .local/sybase.env; see docs/engines/sybase-support.md.`,
    );
}
const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'tests/sybase-readonly-integration.test.ts'],
  { env, stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
