import { z } from 'zod';
import { viewOptionsSchema } from './view-options';
import { generationSchema } from './generated-columns';
import { constraintDefinitionSchema } from './constraints';
import { tablePropertiesSchema, columnPropertiesSchema } from './structure-properties';
import { REDIS_ENCODINGS, POSTGRES_ENCODINGS, ASE_ENCODINGS } from './client-encodings';
export const connectionSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(120),
    engine: z.enum(['sqlite', 'mysql', 'postgres', 'sqlserver', 'redis', 'sybase']),
    host: z.string().max(253).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().max(256).optional(),
    sqlServerAuth: z.enum(['sql', 'windows']).default('sql'),
    sqlServerSpn: z
      .string()
      .trim()
      .min(1)
      .max(260)
      .regex(/^[^\x00-\x1f\x7f]+$/)
      .optional(),
    password: z.string().max(4096).optional(),
    database: z.string().max(1024).default(''),
    group: z.string().max(80).default('Local'),
    favorite: z.boolean().default(false),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#4f8cff'),
    agentAccess: z.enum(['disabled', 'read', 'write']).default('disabled'),
    tls: z.boolean().default(false),
    connectionTimeout: z.number().int().min(100).max(300000).default(10000),
    heartbeatInterval: z.number().int().min(0).max(86400).default(0),
    readTimeout: z.number().int().min(0).max(300000).default(0),
    writeTimeout: z.number().int().min(0).max(300000).default(0),
    charset: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_]+$/)
      .optional(),
    aseDriver: z.string().min(1).max(256).optional(),
    pgDumpPath: z.string().trim().min(1).max(2048).optional(),
    sqlServerPowerShellPath: z.string().trim().min(1).max(2048).optional(),
    aseTrustedFile: z.string().max(2048).optional(),
    aseJavaPath: z.string().trim().min(1).max(2048).optional(),
    aseDdlgenPath: z.string().trim().min(1).max(2048).optional(),
    aseJconnectPath: z.string().trim().min(1).max(2048).optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    for (const field of ['aseJavaPath', 'aseDdlgenPath', 'aseJconnectPath'] as const)
      if (connection[field] && connection.engine !== 'sybase')
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'ASE export tools require a Sybase ASE connection.',
        });
    if (!['mysql', 'postgres', 'redis', 'sqlserver', 'sybase'].includes(connection.engine)) {
      for (const field of ['readTimeout', 'writeTimeout'] as const)
        if (connection[field])
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Network I/O timeouts are supported for network database connections.',
          });
    }
    if (
      connection.sqlServerSpn &&
      (connection.engine !== 'sqlserver' || connection.sqlServerAuth !== 'windows')
    )
      context.addIssue({
        code: 'custom',
        path: ['sqlServerSpn'],
        message: 'Server SPN requires SQL Server Windows authentication.',
      });
    if (
      connection.engine === 'sqlserver' &&
      connection.sqlServerAuth === 'windows' &&
      (connection.readTimeout || connection.writeTimeout)
    ) {
      if (!connection.sqlServerSpn)
        context.addIssue({
          code: 'custom',
          path: ['sqlServerSpn'],
          message: 'Windows network deadlines require an explicit server SPN.',
        });
      const host = (connection.host || 'localhost').replace(/^tcp:/i, '');
      if (!host || /[\\,\s\0]/.test(host) || /^(lpc|np):/i.test(host))
        context.addIssue({
          code: 'custom',
          path: ['host'],
          message: 'Windows network deadlines require a TCP host/port.',
        });
    }
    if (connection.sqlServerPowerShellPath && connection.engine !== 'sqlserver')
      context.addIssue({
        code: 'custom',
        path: ['sqlServerPowerShellPath'],
        message: 'SQL Server PowerShell tools require a SQL Server connection.',
      });
    if (connection.pgDumpPath && connection.engine !== 'postgres')
      context.addIssue({
        code: 'custom',
        path: ['pgDumpPath'],
        message: 'pg_dump is supported only for PostgreSQL.',
      });
    if (connection.charset && !['mysql', 'redis', 'postgres', 'sybase'].includes(connection.engine))
      context.addIssue({
        code: 'custom',
        path: ['charset'],
        message:
          'Client character set is supported for MySQL / MariaDB, PostgreSQL, Redis and ASE JDBC.',
      });
    if (connection.engine === 'sybase' && connection.charset) {
      if (!ASE_ENCODINGS.some((encoding) => encoding.value === connection.charset))
        context.addIssue({
          code: 'custom',
          path: ['charset'],
          message: 'Unsupported ASE JDBC character set.',
        });
      if (!connection.aseJconnectPath)
        context.addIssue({
          code: 'custom',
          path: ['aseJconnectPath'],
          message: 'ASE JDBC character sets require SAP jconn4.jar.',
        });
    }
    if (
      connection.engine === 'postgres' &&
      connection.charset &&
      !POSTGRES_ENCODINGS.some((encoding) => encoding.value === connection.charset)
    )
      context.addIssue({
        code: 'custom',
        path: ['charset'],
        message: 'Unsupported PostgreSQL client character set.',
      });
    if (
      connection.engine === 'redis' &&
      connection.charset &&
      !REDIS_ENCODINGS.some((encoding) => encoding.value === connection.charset)
    )
      context.addIssue({
        code: 'custom',
        path: ['charset'],
        message: 'Unsupported Redis client character set.',
      });
    if (connection.engine === 'sybase' && connection.tls && !connection.aseTrustedFile?.trim())
      context.addIssue({
        code: 'custom',
        path: ['aseTrustedFile'],
        message: 'ASE TLS requires a trusted certificates file.',
      });
    if (connection.engine === 'sqlite' && !connection.database.trim())
      context.addIssue({
        code: 'custom',
        path: ['database'],
        message: 'Please select a database file.',
      });
  });
export const idSchema = z.object({ connectionId: z.string().min(1) });
export const tableSchema = idSchema.extend({
  database: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().min(1),
});
const structureName = z.string().min(1).max(1024);
const columnPropertyChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), column: structureName, name: structureName }).strict(),
  z
    .object({ action: z.literal('type'), column: structureName, type: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({ action: z.literal('nullable'), column: structureName, nullable: z.boolean() })
    .strict(),
  z
    .object({
      action: z.literal('default'),
      column: structureName,
      defaultSql: z.string().max(65536),
    })
    .strict(),
]);
export const structureChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('view-options'), options: viewOptionsSchema }).strict(),
  z
    .object({
      action: z.literal('generated-add'),
      name: structureName,
      type: z.string().min(1).max(4096),
      generation: generationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('generated-edit'),
      column: structureName,
      generation: generationSchema,
    })
    .strict(),
  z.object({ action: z.literal('table-properties'), properties: tablePropertiesSchema }).strict(),
  z
    .object({
      action: z.literal('column-properties'),
      column: structureName,
      properties: columnPropertiesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('constraint-upsert'),
      id: z.string().min(1).max(512).optional(),
      constraint: constraintDefinitionSchema,
    })
    .strict(),
  z.object({ action: z.literal('constraint-drop'), id: z.string().min(1).max(512) }).strict(),
  ...columnPropertyChangeSchema.options,
  z
    .object({
      action: z.literal('edit-columns'),
      changes: z.array(columnPropertyChangeSchema).max(1024),
      primaryKey: z.array(structureName).max(64).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('add'),
      name: structureName,
      type: z.string().min(1).max(4096),
      nullable: z.boolean(),
      defaultSql: z.string().max(65536),
      primaryKey: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal('drop'), column: structureName }).strict(),
  z.object({ action: z.literal('primary-key'), columns: z.array(structureName).max(64) }).strict(),
  z.object({ action: z.literal('view'), sql: z.string().min(1).max(524288) }).strict(),
]);
export const filterSchema = z.object({
  column: z.string().min(1),
  operator: z.enum(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IS NULL', 'IS NOT NULL']),
  value: z.unknown().optional(),
});
export const selectSchema = tableSchema.extend({
  columns: z.array(z.string().min(1)).min(1).optional(),
  filters: z.array(filterSchema).max(30).optional(),
  sort: z
    .array(z.object({ column: z.string(), direction: z.enum(['asc', 'desc']) }))
    .max(10)
    .optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  offset: z.number().int().min(0).max(100000000).optional(),
});
export const querySchema = idSchema.extend({
  database: z.string().min(1).max(1024).optional(),
  sql: z.string().min(1).max(1000000),
  limit: z.number().int().min(1).max(5000).optional(),
  showInApp: z.boolean().optional(),
  tabId: z.string().optional(),
});
export const valuesSchema = z.record(
  z.string().min(1),
  z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
);
export const settingsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']),
    language: z.enum(['en', 'zh-TW']),
    pageSize: z.number().int().min(1).max(5000),
    fontSize: z.number().int().min(10).max(32),
    tabSize: z.number().int().min(1).max(8),
    wordWrap: z.boolean(),
    queryTimeout: z.number().int().min(100).max(300000),
    maxRows: z.number().int().min(1).max(5000),
    agentLevel: z.enum(['observe', 'assist', 'execute']),
    policy: z
      .object({
        insert: z.enum(['allow', 'ask', 'deny']),
        update: z.enum(['allow', 'ask', 'deny']),
        delete: z.enum(['allow', 'ask', 'deny']),
        ddl: z.enum(['allow', 'ask', 'deny']),
        destructive: z.enum(['allow', 'ask', 'deny']),
      })
      .strict(),
    mcp: z
      .object({
        enabled: z.boolean(),
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        remote: z.boolean(),
        allowedHosts: z.array(z.string().min(1)).min(1),
        tlsCert: z.string(),
        tlsKey: z.string(),
      })
      .strict(),
  })
  .strict();
