import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
import { SybaseAdapter } from '../src/main/database/adapters/sybase/sybase-adapter';
import { DataService } from '../src/main/application/services/data-service';
import type { ConnectionService } from '../src/main/application/services/connection-service';
import type { SqlAdapter, QueryOptions } from '../src/main/database/adapter';
import { EventBus } from '../src/main/application/events/event-bus';
import { connectionSchema } from '../src/shared/schemas';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { SqlBuilder } from '../src/main/database/sql-builder';

// Diagnosis only; fixed catalog/zero-row SELECTs, no business rows and no writes.
it.skipIf(process.env.ASE_BIDB_DIAGNOSTIC !== '1')(
  'diagnoses BIdb.dbo.BI_Sale metadata and empty browsing',
  async () => {
    const env = { ...parseEnv(readFileSync('.local/sybase.env', 'utf8')), ...process.env };
    for (const key of ['ASE_HOST', 'ASE_USERNAME', 'ASE_PASSWORD'])
      if (!env[key]) throw new Error(`Missing ${key}`);
    const safe = (error: unknown) => {
      let text = error instanceof Error ? error.message : String(error);
      for (const secret of [env.ASE_PASSWORD, env.ASE_USERNAME])
        if (secret) text = text.replaceAll(secret, '[REDACTED]');
      return text;
    };
    const stages: Record<string, unknown>[] = [];
    const record = (stage: string, data: Record<string, unknown>) => {
      const item = { stage, ...data };
      stages.push(item);
      console.log(JSON.stringify(item));
      mkdirSync('research/evidence', { recursive: true });
      writeFileSync(
        'research/evidence/ase-bi-sale-numeric-control.json',
        JSON.stringify({ scope: 'BIdb.dbo.BI_Sale catalogs/WHERE 1=0 only', stages }, null, 2),
      );
    };
    const adapter = new SybaseAdapter(
      {
        ...connectionSchema.parse({
          name: 'BIdb readonly diagnosis',
          engine: 'sybase',
          host: env.ASE_HOST,
          port: Number(env.ASE_PORT || 5000),
          database: 'BIdb',
          username: env.ASE_USERNAME,
          aseDriver: env.ASE_DRIVER,
          tls: env.ASE_TLS === '1',
          aseTrustedFile: env.ASE_TRUSTED_FILE,
          readTimeout: Number(env.ASE_READ_TIMEOUT || 0),
          writeTimeout: Number(env.ASE_WRITE_TIMEOUT || 0),
        }),
        id: 'bidb-diagnosis',
      },
      env.ASE_PASSWORD,
    );
    const options = { limit: 5000, timeout: 15000, readOnly: true };
    const tick = setInterval(() => console.log('Read-only BIdb diagnosis is running...'), 5000);
    const attempt = async (stage: string, action: () => Promise<Record<string, unknown>>) => {
      try {
        record(stage, { success: true, ...(await action()) });
      } catch (error) {
        record(stage, { success: false, error: safe(error) });
      }
    };
    try {
      record('start', { status: 'running' });
      await adapter.connect();
      const identity = await adapter.query('SELECT db_name() AS name', [], options);
      expect(String(identity.rows[0]?.name).toLowerCase()).toBe('bidb');
      record('database', { name: identity.rows[0]?.name });
      const matches = await adapter.query(
        "SELECT o.name,o.type AS kind FROM dbo.sysobjects o, dbo.sysusers u WHERE u.uid=o.uid AND u.name='dbo' AND o.type IN ('U','V') AND UPPER(o.name)=UPPER(?)",
        ['BI_Sale'],
        options,
      );
      expect(matches.hasMore).toBe(false);
      record('target lookup', {
        objects: matches.rows.map((row) => ({
          name: safe(row.name),
          kind: String(row.kind).trim(),
        })),
      });
      if (matches.rows.length !== 1) {
        const candidates = await adapter.query(
          "SELECT o.name,o.type AS kind FROM dbo.sysobjects o, dbo.sysusers u WHERE u.uid=o.uid AND u.name='dbo' AND o.type IN ('U','V') AND UPPER(o.name) LIKE ? ORDER BY o.name",
          ['%BI%SALE%'],
          options,
        );
        record('target needs clarification', {
          candidates: candidates.rows.map((row) => ({
            name: safe(row.name),
            kind: String(row.kind).trim(),
          })),
          hasMore: candidates.hasMore,
        });
        return;
      }
      const table = String(matches.rows[0].name);
      const ref = { database: 'BIdb', schema: 'dbo', table };
      const metadata = await adapter.query(
        'SELECT c.name,c.type AS storage_type,c.prec AS col_precision,c.scale AS col_scale,t.name AS type_name FROM dbo.syscolumns c, dbo.systypes t, dbo.sysobjects o, dbo.sysusers u WHERE t.usertype=c.usertype AND o.id=c.id AND u.uid=o.uid AND u.name=? AND o.name=? ORDER BY c.colid',
        ['dbo', table],
        options,
      );
      expect(metadata.hasMore).toBe(false);
      record('columns', {
        columns: metadata.rows.map((row) => ({
          name: safe(row.name),
          storageType: row.storage_type,
          precision: row.col_precision,
          scale: row.col_scale,
          type: safe(row.type_name),
        })),
      });
      await attempt('adapter describe', async () => ({
        columns: (await adapter.describe(ref)).length,
      }));
      await attempt('raw empty SELECT', async () => {
        const result = await adapter.query(
          `SELECT * FROM ${new SqlBuilder('sybase').table(ref)} WHERE 1=0`,
          [],
          options,
        );
        expect(result.rows).toHaveLength(0);
        return { columns: result.columns.length, rows: 0 };
      });
      const emptyAdapter = {
        aseMajorVersion: adapter.aseMajorVersion,
        connect: () => adapter.connect(),
        query: async (sql: string, params: unknown[], opts: QueryOptions) => {
          expect(opts.readOnly).toBe(true);
          if (sql.startsWith('SELECT c.name,c.type AS storage_type,c.prec AS col_precision'))
            return adapter.query(sql, params, opts);
          expect(sql).toContain(`FROM ${new SqlBuilder('sybase').table(ref)}`);
          expect(sql).not.toMatch(/\bORDER BY\b/i);
          record('generated projection', {
            convertedColumns: (sql.match(/CONVERT\(varchar\(80\)/g) || []).length,
          });
          return adapter.query(
            sql + (/\bWHERE\b/i.test(sql) ? ' AND 1=0' : ' WHERE 1=0'),
            params,
            opts,
          );
        },
      } as unknown as SqlAdapter;
      const connections = {
        get: () => ({ engine: 'sybase' }),
        connect: async () => emptyAdapter,
      } as unknown as ConnectionService;
      const service = new DataService(connections, () => DEFAULT_SETTINGS, new EventBus());
      await attempt('shared DataService empty SELECT', async () => {
        const result = await service.select('ase', ref);
        expect(result.rows).toHaveLength(0);
        return { columns: result.columns.length, rows: 0 };
      });
      await attempt('numeric12 fixed constant decoding', async () => {
        const result = await adapter.query(
          'SELECT CONVERT(numeric(12,0), 123456789012) AS value',
          [],
          options,
        );
        return { valueType: typeof result.rows[0]?.value };
      });
      await attempt('Serno numeric string filter empty SELECT', async () => {
        const result = await service.select('ase', {
          ...ref,
          columns: ['Serno'],
          filters: [{ column: 'Serno', operator: '>=', value: '1' }],
        });
        expect(result.rows).toHaveLength(0);
        return { columns: result.columns.length, rows: 0 };
      });
    } catch (error) {
      record('fatal', { error: safe(error) });
      throw new Error(safe(error));
    } finally {
      try {
        await adapter.disconnect();
        record('disconnect', { success: true });
      } finally {
        clearInterval(tick);
      }
    }
  },
  110000,
);
