import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sqlServerTestEnv } from './sqlserver-test-env.mjs';
const password =
  process.env.DB_TEST_PASSWORD ??
  /^DB_TEST_PASSWORD=(.+)$/m.exec(readFileSync('.local/integration.env', 'utf8'))?.[1].trim();
if (!password)
  throw new Error(
    'Set DB_TEST_PASSWORD or prepare .local/integration.env and start compose.integration.yml.',
  );
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'tests/integration.test.ts',
    'tests/create-objects.test.ts',
    'tests/review-fixes.test.ts',
    'tests/rename-objects.test.ts',
    'tests/constraints.test.ts',
    'tests/structure-properties.test.ts',
    'tests/generated-columns.test.ts',
    'tests/view-options.test.ts',
    'tests/index-options.test.ts',
    'tests/database-properties.test.ts',
    'tests/sql-script.test.ts',
    'tests/mysql-export.test.ts',
    'tests/postgres-export.test.ts',
    'tests/sqlserver-export.test.ts',
    'tests/socket-timeouts.test.ts',
    'tests/sqlserver-odbc-io.test.ts',
    'tests/redis-io.test.ts',
    'tests/redis-encoding.test.ts',
    'tests/postgres-encoding.test.ts',
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    env: { ...sqlServerTestEnv(), DB_TEST_PASSWORD: password, DB_INTEGRATION: '1' },
  },
);
process.exitCode = result.status ?? 1;
