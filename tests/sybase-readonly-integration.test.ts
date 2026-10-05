import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
import { SybaseAdapter } from '../src/main/database/adapters/sybase/sybase-adapter';
import { connectionSchema } from '../src/shared/schemas';
import { aseObjects } from '../src/main/database/adapters/sybase/sybase-catalog';

// Deliberately separate from the CRUD/DDL integration suite. Never read credentials
// or contact a server during the ordinary unit test run.
it.skipIf(process.env.ASE_READONLY_INTEGRATION !== '1')(
  'real ASE: read-only connection, constants, parameters and catalog counts',
  async () => {
    const env = { ...parseEnv(readFileSync('.local/sybase.env', 'utf8')), ...process.env };
    for (const key of ['ASE_HOST', 'ASE_DATABASE', 'ASE_USERNAME', 'ASE_PASSWORD']) {
      if (!env[key]) throw new Error(`Missing ${key} in local ASE configuration.`);
    }
    const connection = {
      ...connectionSchema.parse({
        name: 'ASE read-only verification',
        engine: 'sybase',
        host: env.ASE_HOST,
        port: Number(env.ASE_PORT || 5000),
        database: env.ASE_DATABASE,
        username: env.ASE_USERNAME,
        aseDriver: env.ASE_DRIVER,
        tls: env.ASE_TLS === '1',
        aseTrustedFile: env.ASE_TRUSTED_FILE,
        readTimeout: Number(env.ASE_READ_TIMEOUT || 0),
        writeTimeout: Number(env.ASE_WRITE_TIMEOUT || 0),
        aseJavaPath: env.ASE_JAVA_PATH,
        aseJconnectPath: env.ASE_JCONNECT_PATH,
        charset: env.ASE_CHARSET || undefined,
      }),
      id: 'ase-readonly-verification',
    };
    const adapter = new SybaseAdapter(connection, env.ASE_PASSWORD);
    // Fixed SELECT allowlist only: no business-table reads, procedures, temporary
    // objects, DML, DDL, export locks or persistent server configuration changes.
    const checks = [
      {
        label: 'version',
        sql: 'SELECT @@version AS value',
        params: [],
        verify: (value: unknown) =>
          expect(String(value)).toMatch(/Adaptive Server Enterprise\/(11|16)\./i),
      },
      {
        label: 'Unicode constant',
        sql: "SELECT '資料' AS value",
        params: [],
        verify: (value: unknown) => expect(value).toBe('資料'),
      },
      {
        label: 'constant',
        sql: 'SELECT 1 AS value',
        params: [],
        verify: (value: unknown) => expect(Number(value)).toBe(1),
      },
      {
        label: 'parameter binding',
        sql: 'SELECT CONVERT(int, ?) AS value',
        params: [37],
        verify: (value: unknown) => expect(Number(value)).toBe(37),
      },
      {
        label: 'database catalog count',
        sql: 'SELECT COUNT(*) AS value FROM master.dbo.sysdatabases',
        params: [],
        verify: (value: unknown) => expect(Number(value)).toBeGreaterThan(0),
      },
      {
        label: 'owner catalog count',
        sql: 'SELECT COUNT(*) AS value FROM sysusers',
        params: [],
        verify: (value: unknown) => expect(Number(value)).toBeGreaterThan(0),
      },
      {
        label: 'object catalog count',
        sql: "SELECT COUNT(*) AS value FROM sysobjects WHERE type IN ('U', 'V')",
        params: [],
        verify: (value: unknown) => expect(Number(value)).toBeGreaterThanOrEqual(0),
      },
    ];
    try {
      console.log('Connecting to ASE for read-only verification...');
      await adapter.connect();
      console.log('PASS: connection and ASE read-only version gate');
      for (const check of checks) {
        console.log(`Running read-only check: ${check.label}...`);
        const result = await adapter.query(check.sql, check.params, {
          limit: 1,
          timeout: 15000,
          readOnly: true,
        });
        expect(result.rows).toHaveLength(1);
        check.verify(result.rows[0].value);
        console.log(`PASS: ${check.label}`);
      }
      console.log('Checking database, owner and table listings (names not logged)...');
      expect(await adapter.databases()).toContain(connection.database);
      const owners = await adapter.schemas();
      expect(owners).toContain(env.ASE_SCHEMA || 'dbo');
      expect(Array.isArray(await adapter.tables(env.ASE_SCHEMA || 'dbo'))).toBe(true);
      const tables = await adapter.tables();
      const indexes = await aseObjects(adapter, 'index');
      const triggers = await aseObjects(adapter, 'trigger');
      const browsableOwners = new Set(
        [...tables, ...indexes, ...triggers].map((object) => object.schema),
      );
      expect(new Set(owners)).toEqual(browsableOwners);
      expect(owners.length).toBe(browsableOwners.size);
      const oldUsers = await adapter.query(
        "SELECT name FROM dbo.sysusers WHERE uid > 0 AND (suid >= 0 OR name = 'dbo') ORDER BY name",
        [],
        { limit: 5000, timeout: 15000, readOnly: true },
      );
      expect(oldUsers.hasMore).toBe(false);
      const identity = await adapter.query('SELECT db_name() AS name', [], {
        limit: 1,
        timeout: 15000,
        readOnly: true,
      });
      console.log(
        JSON.stringify({
          stage: 'browsable owner catalog',
          database: identity.rows[0]?.name,
          previousUserCount: oldUsers.rows.length,
          ownerCount: owners.length,
          exactObjectOwnerSet: true,
        }),
      );
      console.log('PASS: catalog listings');
      console.log('Checking system table column metadata (no business data)...');
      const columns = await adapter.describe({ schema: 'dbo', table: 'sysusers' });
      expect(columns.some((column) => column.name === 'name')).toBe(true);
      console.log('PASS: column metadata');
      await adapter.heartbeat(10000);
      console.log('PASS: heartbeat');
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Read-only ASE verification failed.';
      for (const secret of [env.ASE_PASSWORD, env.ASE_USERNAME]) {
        if (secret) message = message.replaceAll(secret, '[REDACTED]');
      }
      throw new Error(message);
    } finally {
      await adapter.disconnect();
      console.log('ASE verification session disconnected.');
    }
  },
  120000,
);
