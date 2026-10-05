import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { it, expect } from 'vitest';
import { SybaseAdapter } from '../src/main/database/adapters/sybase/sybase-adapter';
import { connectionSchema } from '../src/shared/schemas';

// Opt-in diagnosis: catalogs and WHERE 1=0 only; never retrieve business rows.
it.skipIf(process.env.ASE_OBJECT_DIAGNOSTIC !== '1')(
  'diagnose ASE clssrcp metadata and view classification without data rows',
  async () => {
    const env = { ...parseEnv(readFileSync('.local/sybase.env', 'utf8')), ...process.env };
    for (const key of ['ASE_HOST', 'ASE_USERNAME', 'ASE_PASSWORD'])
      if (!env[key]) throw new Error(`Missing ${key} in local ASE configuration.`);
    const createAdapter = (database: string) =>
      new SybaseAdapter(
        {
          ...connectionSchema.parse({
            name: 'ASE object diagnosis',
            engine: 'sybase',
            host: env.ASE_HOST,
            port: Number(env.ASE_PORT || 5000),
            database,
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
          id: 'ase-object-diagnosis',
        },
        env.ASE_PASSWORD,
      );
    const safe = (error: unknown) => {
      let message = error instanceof Error ? error.message : String(error);
      for (const secret of [env.ASE_PASSWORD, env.ASE_USERNAME])
        if (secret) message = message.replaceAll(secret, '[REDACTED]');
      return message;
    };
    const initial = createAdapter(env.ASE_DATABASE || 'kyclaim');
    let candidates: string[];
    try {
      console.log('Checking configured and requested database identities (catalog only)...');
      const names = await initial.databases();
      candidates = names.filter((name) =>
        [env.ASE_DATABASE, 'db', 'kyclaim'].some(
          (candidate) => candidate?.toLowerCase() === name.toLowerCase(),
        ),
      );
      console.log(
        JSON.stringify({
          stage: 'database identity',
          configured: safe(env.ASE_DATABASE || '(unspecified)'),
          candidates: candidates.map(safe),
        }),
      );
    } catch (error) {
      throw new Error(safe(error));
    } finally {
      await initial.disconnect();
    }
    for (const database of candidates) {
      const adapter = createAdapter(database);
      const query = (sql: string, params: unknown[] = []) =>
        adapter.query(sql, params, { limit: 5000, timeout: 15000, readOnly: true });
      try {
        console.log(`Checking database ${safe(database)} catalog types and target metadata...`);
        await adapter.connect();
        const actualDatabase = await query('SELECT db_name() AS actual_database');
        console.log(
          JSON.stringify({
            stage: 'actual session database',
            requested: safe(database),
            actual: safe(String(actualDatabase.rows[0]?.actual_database)),
          }),
        );
        const owners = await adapter.schemas();
        const views = await query(
          "SELECT o.type AS kind,u.name AS owner_name FROM dbo.sysobjects o, dbo.sysusers u WHERE u.uid=o.uid AND o.type='V'",
        );
        expect(views.hasMore).toBe(false);
        const listed = await adapter.tables();
        console.log(
          JSON.stringify({
            database: safe(database),
            stage: 'view classification',
            catalogViews: views.rows.length,
            rawTypes: [...new Set(views.rows.map((row) => String(row.kind)))],
            adapterViews: listed.filter((item) => item.kind === 'view').length,
            viewOwnersMissingFromSchemas: [
              ...new Set(views.rows.map((row) => String(row.owner_name))),
            ].filter((owner) => !owners.includes(owner)).length,
          }),
        );
        console.log(
          JSON.stringify({
            database: safe(database),
            stage: 'similar catalog names',
            objects: listed
              .filter((item) => /rcp|src|cls/i.test(item.name))
              .map((item) => ({ name: safe(item.name), owner: safe(item.schema) })),
          }),
        );
        const objects = await query(
          "SELECT o.name,u.name AS owner_name,o.type AS kind FROM dbo.sysobjects o, dbo.sysusers u WHERE u.uid=o.uid AND UPPER(o.name) IN ('CLSSRCP','CLMSSRCP')",
        );
        console.log(
          JSON.stringify({
            database: safe(database),
            stage: 'target lookup',
            matchingObjects: objects.rows.length,
            names: objects.rows.map((row) => safe(String(row.name))),
            owners: objects.rows.map((row) =>
              ['db', 'dbo'].includes(String(row.owner_name))
                ? String(row.owner_name)
                : '[other owner]',
            ),
          }),
        );
        for (const row of objects.rows) {
          const schema = String(row.owner_name);
          const table = String(row.name);
          const ref = { schema, table };
          console.log('Checking target metadata through the product adapter...');
          try {
            const columns = await adapter.describe(ref);
            console.log(
              JSON.stringify({
                stage: 'describe',
                success: true,
                columnCount: columns.length,
                types: [...new Set(columns.map((column) => column.type))],
              }),
            );
          } catch (error) {
            console.log(JSON.stringify({ stage: 'describe', success: false, error: safe(error) }));
          }
          console.log('Checking empty target SELECT (WHERE 1=0; no business rows)...');
          try {
            const result = await query(
              `SELECT * FROM [${schema.replaceAll(']', ']]')}].[${table.replaceAll(']', ']]')}] WHERE 1=0`,
            );
            expect(result.rows).toHaveLength(0);
            console.log(
              JSON.stringify({
                stage: 'empty SELECT',
                success: true,
                columnCount: result.columns.length,
              }),
            );
          } catch (error) {
            console.log(
              JSON.stringify({ stage: 'empty SELECT', success: false, error: safe(error) }),
            );
          }
        }
      } catch (error) {
        throw new Error(safe(error));
      } finally {
        await adapter.disconnect();
        console.log('ASE object diagnosis disconnected.');
      }
    }
  },
  180000,
);
