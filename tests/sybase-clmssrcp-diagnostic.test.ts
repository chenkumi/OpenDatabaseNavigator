import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
import { SybaseAdapter, type AseDriver } from '../src/main/database/adapters/sybase/sybase-adapter';
import { connectionSchema } from '../src/shared/schemas';

// Fixed confirmed target, opt-in only. Every table SELECT has WHERE 1=0.
it.skipIf(process.env.ASE_CLMSSRCP_DIAGNOSTIC !== '1')(
  'diagnose clmssrcp decimal rejection without fetching business rows',
  async () => {
    const env = { ...parseEnv(readFileSync('.local/sybase.env', 'utf8')), ...process.env };
    for (const key of ['ASE_HOST', 'ASE_USERNAME', 'ASE_PASSWORD'])
      if (!env[key]) throw new Error(`Missing ${key} in local ASE configuration.`);
    const safe = (error: unknown) => {
      let text = error instanceof Error ? error.message : String(error);
      for (const secret of [env.ASE_PASSWORD, env.ASE_USERNAME])
        if (secret) text = text.replaceAll(secret, '[REDACTED]');
      return text;
    };
    const report: { target: string; time: string; stages: Record<string, unknown>[] } = {
      target: 'kyclaim.dbo.clmssrcp',
      time: new Date().toISOString(),
      stages: [],
    };
    const record = (stage: string, fields: Record<string, unknown>) => {
      report.stages.push({ stage, ...fields });
      console.log(JSON.stringify({ stage, ...fields }));
    };
    const require = createRequire(import.meta.url);
    const native = require('msnodesqlv8') as AseDriver;
    // Observe metadata only; preserve the real driver's methods, SQL and events.
    const observedDriver: AseDriver = {
      open: (options, callback) =>
        native.open(options, (error, session) => {
          if (session) {
            const raw = session.queryRaw.bind(session);
            session.queryRaw = (query, params) => {
              const operation = raw(query, params);
              if (query.query_str.includes('clmssrcp'))
                operation.on('meta', (columns: { name: string; sqlType: string }[]) => {
                  record('native result metadata', {
                    columnCount: columns.length,
                    types: [...new Set(columns.map((column) => column.sqlType))],
                    rejectedColumns: columns.filter((column) =>
                      ['decimal', 'money', 'smallmoney', 'sql_variant'].includes(column.sqlType),
                    ),
                  });
                });
              return operation;
            };
          }
          callback(error, session);
        }),
    };
    const adapter = new SybaseAdapter(
      {
        ...connectionSchema.parse({
          name: 'ASE confirmed target diagnosis',
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
        id: 'ase-clmssrcp-diagnosis',
      },
      env.ASE_PASSWORD,
      async () => observedDriver,
    );
    const tick = setInterval(
      () => console.log('Product empty-result diagnosis in progress...'),
      5000,
    );
    try {
      console.log('Checking SELECT * through the actual product adapter (WHERE 1=0)...');
      let rejection: string | undefined;
      try {
        const result = await adapter.query('SELECT * FROM [dbo].[clmssrcp] WHERE 1=0', [], {
          limit: 1,
          timeout: 15000,
          readOnly: true,
        });
        expect(result.rows).toHaveLength(0);
        record('original SELECT', {
          success: true,
          rowCount: result.rows.length,
          columnCount: result.columns.length,
        });
      } catch (error) {
        rejection = safe(error);
        record('original SELECT', { success: false, error: rejection });
      }
      expect(rejection).toContain(
        'ASE ODBC cannot guarantee lossless decoding of this result type.',
      );
      console.log('Checking server-side decimal-to-varchar control (WHERE 1=0)...');
      const evidence = JSON.parse(
        readFileSync('research/evidence/ase-clmssrcp-pyodbc.json', 'utf8'),
      ) as {
        stages: { stage: string; columns?: { name: string; type: string }[] }[];
      };
      const columns = evidence.stages.find((stage) => stage.stage === 'column catalog')?.columns;
      expect(columns).toHaveLength(114);
      const quote = (name: string) => `[${name.replaceAll(']', ']]')}]`;
      const projection = columns!
        .map((column) =>
          column.type === 'decimal'
            ? `CONVERT(varchar, ${quote(column.name)}) AS ${quote(column.name)}`
            : quote(column.name),
        )
        .join(', ');
      const control = await adapter.query(
        `SELECT ${projection} FROM [dbo].[clmssrcp] WHERE 1=0`,
        [],
        { limit: 1, timeout: 15000, readOnly: true },
      );
      expect(control.rows).toHaveLength(0);
      expect(control.columns).toHaveLength(114);
      record('decimal-to-varchar control', {
        success: true,
        rowCount: control.rows.length,
        columnCount: control.columns.length,
      });
    } catch (error) {
      record('diagnostic error', { error: safe(error) });
      throw new Error(safe(error));
    } finally {
      try {
        await adapter.disconnect();
        record('disconnect', { success: true });
      } finally {
        clearInterval(tick);
        mkdirSync('research/evidence', { recursive: true });
        writeFileSync(
          'research/evidence/ase-clmssrcp-product.json',
          JSON.stringify(report, null, 2),
          'utf8',
        );
        console.log('Product diagnostic finished; sanitized metadata evidence saved.');
      }
    }
  },
  55000,
);
