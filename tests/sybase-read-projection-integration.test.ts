import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
import { SybaseAdapter } from '../src/main/database/adapters/sybase/sybase-adapter';
import { DataService } from '../src/main/application/services/data-service';
import type { ConnectionService } from '../src/main/application/services/connection-service';
import { EventBus } from '../src/main/application/events/event-bus';
import type { SqlAdapter, QueryOptions } from '../src/main/database/adapter';
import { connectionSchema } from '../src/shared/schemas';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { SqlBuilder } from '../src/main/database/sql-builder';

// Opt-in: fixed confirmed table, catalogs, numeric constants. Never fetch business rows.
it.skipIf(process.env.ASE_READ_PROJECTION_INTEGRATION !== '1')(
  'verifies ASE lossless browsing, numeric ordering and view classification read-only',
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
      stages.push({ stage, ...data });
      console.log(JSON.stringify({ stage, ...data }));
    };
    const adapter = new SybaseAdapter(
      {
        ...connectionSchema.parse({
          name: 'ASE readonly projection acceptance',
          engine: 'sybase',
          host: env.ASE_HOST,
          port: Number(env.ASE_PORT || 5000),
          database: 'kyclaim',
          username: env.ASE_USERNAME,
          aseDriver: env.ASE_DRIVER,
          tls: env.ASE_TLS === '1',
          aseTrustedFile: env.ASE_TRUSTED_FILE,
          readTimeout: Number(env.ASE_READ_TIMEOUT || 0),
          writeTimeout: Number(env.ASE_WRITE_TIMEOUT || 0),
        }),
        id: 'ase-projection-acceptance',
      },
      env.ASE_PASSWORD,
    );
    const options = { limit: 5000, timeout: 15000, readOnly: true };
    const tick = setInterval(
      () => console.log('Read-only projection acceptance in progress...'),
      5000,
    );
    try {
      console.log('Connecting for catalog, constants and empty business-table SELECTs only...');
      await adapter.connect();
      const identity = await adapter.query('SELECT db_name() AS name', [], options);
      expect(identity.rows[0]?.name).toBe('kyclaim');
      const structure = await adapter.describe({ schema: 'dbo', table: 'clmssrcp' });
      expect(structure).toHaveLength(114);
      record('target describe', { success: true, columns: structure.length });
      const emptyAdapter = {
        aseMajorVersion: adapter.aseMajorVersion,
        connect: () => adapter.connect(),
        query: async (sql: string, params: unknown[], opts: QueryOptions) => {
          expect(opts.readOnly).toBe(true);
          if (sql.includes('FROM dbo.syscolumns')) return adapter.query(sql, params, opts);
          expect(sql).toContain('FROM [dbo].[clmssrcp]');
          const order = sql.indexOf(' ORDER BY ');
          const body = order < 0 ? sql : sql.slice(0, order);
          const tail = order < 0 ? '' : sql.slice(order);
          const emptySql = body + (/\bWHERE\b/i.test(body) ? ' AND 1=0' : ' WHERE 1=0') + tail;
          record('generated browsing projection', {
            decimalConversions: (sql.match(/CONVERT\(varchar\(80\)/g) || []).length,
          });
          return adapter.query(emptySql, params, opts);
        },
      } as unknown as SqlAdapter;
      const connections = {
        get: () => ({ engine: 'sybase' }),
        connect: async () => emptyAdapter,
      } as unknown as ConnectionService;
      const service = new DataService(connections, () => DEFAULT_SETTINGS, new EventBus());
      const page = await service.select('ase', {
        database: 'kyclaim',
        schema: 'dbo',
        table: 'clmssrcp',
      });
      expect(page.rows).toHaveLength(0);
      expect(page.columns).toHaveLength(114);
      record('shared DataService empty page', {
        success: true,
        columns: page.columns.length,
        rows: page.rows.length,
      });
      const subset = await service.select('ase', {
        schema: 'dbo',
        table: 'clmssrcp',
        columns: ['wkcost', 'pad_currency'],
      });
      expect(subset.columns).toEqual(['wkcost', 'pad_currency']);
      expect(subset.rows).toHaveLength(0);
      record('selected decimal columns', { success: true });
      const filtered = await service.select('ase', {
        schema: 'dbo',
        table: 'clmssrcp',
        columns: ['wkcost', 'pad_currency'],
        filters: [{ column: 'wkcost', operator: '>=', value: '1.25' }],
        sort: [{ column: 'pad_currency', direction: 'desc' }],
        offset: 10,
        limit: 2,
      });
      expect(filtered.columns).toEqual(['wkcost', 'pad_currency']);
      expect(filtered.rows).toHaveLength(0);
      record('decimal filter/sort/offset empty page', { success: true });
      for (const [sql, expected] of [
        [
          'SELECT CONVERT(varchar(80), 9007199254740993.123456789012345678) AS value',
          '9007199254740993.123456789012345678',
        ],
        [
          'SELECT CONVERT(varchar(80), 12345678901234567890123456789012345678) AS value',
          '12345678901234567890123456789012345678',
        ],
        [
          'SELECT CONVERT(varchar(80), CONVERT(numeric(38,4), CONVERT(money, 1.2345))) AS value',
          '1.2345',
        ],
        [
          'SELECT CONVERT(varchar(80), CONVERT(numeric(38,4), CONVERT(smallmoney, -1.2345))) AS value',
          '-1.2345',
        ],
        [
          'SELECT CONVERT(varchar(80), CONVERT(numeric(38,4), CONVERT(money, NULL))) AS value',
          null,
        ],
        [
          'SELECT CONVERT(varchar(80), CONVERT(numeric(38,4), CONVERT(money, 922337203685477.5807))) AS value',
          '922337203685477.5807',
        ],
        [
          'SELECT CONVERT(varchar(80), CONVERT(numeric(38,4), CONVERT(smallmoney, -214748.3648))) AS value',
          '-214748.3648',
        ],
        [
          'SELECT CONVERT(varchar(80), -12345678901234567890123456789012345678) AS value',
          '-12345678901234567890123456789012345678',
        ],
      ] as const) {
        const result = await adapter.query(sql, [], options);
        expect(result.rows[0]?.value).toBe(expected);
      }
      record('precision constants', { success: true, cases: 8 });
      const built = new SqlBuilder('sybase').select(
        {
          schema: 'dbo',
          table: 'spt_values',
          columns: ['number'],
          sort: [{ column: 'number', direction: 'asc' }],
        },
        3,
        new Map([['number', { kind: 'numeric', precision: 38, scale: 0 }]]),
      );
      const sortedSql = built.sql
        .replace('FROM [dbo].[spt_values]', 'FROM master.dbo.spt_values')
        .replace(' ORDER BY ', " WHERE [type]='P' AND [number] IN (2,10,100) ORDER BY ");
      const sorted = await adapter.query(sortedSql, [], options);
      expect(sorted.rows.map((row) => row.number)).toEqual(['2', '10', '100']);
      record('numeric sorting despite string aliases', {
        success: true,
        values: ['2', '10', '100'],
      });
      const threshold = new SqlBuilder('sybase').select(
        {
          schema: 'dbo',
          table: 'spt_values',
          columns: ['number'],
          filters: [{ column: 'number', operator: '>=', value: '2.01' }],
          sort: [{ column: 'number', direction: 'asc' }],
        },
        3,
        new Map([['number', { kind: 'numeric', precision: 38, scale: 0 }]]),
      );
      const thresholdSql = threshold.sql
        .replace('FROM [dbo].[spt_values]', 'FROM master.dbo.spt_values')
        .replace(' ORDER BY ', " AND [type]='P' AND [number] IN (2,10,100) ORDER BY ");
      const matched = await adapter.query(thresholdSql, threshold.params, options);
      expect(matched.rows.map((row) => row.number)).toEqual(['10', '100']);
      record('numeric filter threshold retains fractional scale', {
        success: true,
        values: ['10', '100'],
      });
      const catalog = await adapter.query(
        "SELECT o.name,u.name AS owner FROM dbo.sysobjects o, dbo.sysusers u WHERE o.uid=u.uid AND o.type='V'",
        [],
        options,
      );
      expect(catalog.hasMore).toBe(false);
      expect(catalog.rows.length).toBeGreaterThan(0);
      const listed = (await adapter.tables()).filter((item) => item.kind === 'view');
      expect(listed.map((item) => `${item.schema}.${item.name}`).sort()).toEqual(
        catalog.rows.map((row) => `${row.owner}.${row.name}`).sort(),
      );
      record('view classification', {
        success: true,
        catalogViews: catalog.rows.length,
        listedViews: listed.length,
      });
    } catch (error) {
      record('error', { error: safe(error) });
      throw new Error(safe(error));
    } finally {
      try {
        await adapter.disconnect();
        record('disconnect', { success: true });
      } finally {
        clearInterval(tick);
        mkdirSync('research/evidence', { recursive: true });
        writeFileSync(
          'research/evidence/ase-read-projection-acceptance.json',
          JSON.stringify({ time: new Date().toISOString(), stages }, null, 2),
          'utf8',
        );
      }
    }
  },
  110000,
);
