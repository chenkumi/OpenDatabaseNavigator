import { createObjectSchema } from '../../shared/create-object';
import { planPropertyChange, structurePropertyOptions } from '../database/structure-properties';
import { generationCapabilities, planGeneratedChange } from '../database/generated-columns';
import { viewCapabilities } from '../database/view-options';
import { indexCapabilities } from '../database/index-options';
import { indexOptionsSchema } from '../../shared/index-options';
import { dropObjectSchema, matchesDroppedObject } from '../../shared/drop-object';
import { planDropObject } from './services/drop-object-service';
import { renameObjectSchema, type RenameObjectInput } from '../../shared/rename-object';
import { planRenameObject, executeRename } from './services/rename-object-service';
import { planCreateObject } from './services/create-object-service';
import { listDatabaseObjects } from './services/database-metadata';
import {
  applyStructure,
  describeStructure,
  planStructure,
} from './services/table-structure-service';
import { structureChangeSchema } from '../../shared/schemas';
import {
  applyObjectChange,
  planObjectChange,
  readObjectDefinition,
} from './services/database-object-service';
import { z } from 'zod';
import type {
  Actor,
  AuditEntry,
  ColumnPropertyChange,
  Connection,
  Settings,
  Workspace,
} from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';
import {
  connectionSchema,
  filterSchema,
  idSchema,
  querySchema,
  selectSchema,
  settingsSchema,
  tableSchema,
  valuesSchema,
} from '../../shared/schemas';
import type { Credentials } from '../credentials/credential-service';
import type { SqlAdapterFactory } from '../database/adapter';
import { AuditService } from '../mcp/audit/audit-service';
import { PermissionService } from '../mcp/permissions/permission-service';
import { CommandBus } from './commands/command-bus';
import { EventBus } from './events/event-bus';
import { ConnectionService } from './services/connection-service';
import { DataService } from './services/data-service';
import { QueryService, type HistoryEntry } from './services/query-service';
import { SqlScriptService } from './services/sql-script-service';
import { SqlExportService } from './services/sql-export-service';
import { SQL_FILE_LIMIT } from '../../shared/sql-script';
import type { Store } from './services/store';
import { WorkspaceService } from './services/workspace-service';
import { RedisService } from './services/redis-service';
import {
  createDatabaseSql,
  databaseOptions,
  validateDatabaseOptions,
} from '../database/create-database';
import {
  databaseCreateOptionsSchema,
  databasePropertyChangeSchema,
} from '../../shared/database-options';
import { readDatabaseProperties, planDatabaseProperties } from '../database/database-properties';
export interface ApplicationStores {
  connections: Store<Connection[]>;
  workspace: Store<Workspace>;
  settings: Store<Settings>;
  history: Store<HistoryEntry[]>;
  audit: Store<AuditEntry[]>;
}
export const HUMAN: Actor = { kind: 'human', id: 'desktop', name: 'Desktop User' };
export class Application {
  readonly events = new EventBus();
  readonly connections: ConnectionService;
  readonly workspace: WorkspaceService;
  readonly query: QueryService;
  readonly scripts: SqlScriptService;
  readonly exports: SqlExportService;
  readonly data: DataService;
  readonly redis: RedisService;
  readonly audit: AuditService;
  readonly permissions: PermissionService;
  readonly commands: CommandBus;
  private settings: Settings;
  private databasePropertyWrites = new Set<string>();
  constructor(
    private stores: ApplicationStores,
    credentials: Credentials,
    factory: SqlAdapterFactory,
  ) {
    this.settings = settingsSchema.parse(stores.settings.read() ?? DEFAULT_SETTINGS);
    this.connections = new ConnectionService(
      stores.connections,
      credentials,
      factory,
      this.events,
      (id, discard) => {
        this.workspace.closeConnection(id, discard);
        this.query.cancelConnection(id);
        this.scripts?.cancelConnection(id);
        this.exports?.cancelConnection(id);
      },
    );
    this.workspace = new WorkspaceService(stores.workspace, this.events, (value) =>
      this.audit.sanitize(value),
    );
    this.query = new QueryService(
      this.connections,
      this.workspace,
      () => this.getSettings(),
      stores.history,
      this.events,
      (value) => this.audit.sanitize(value),
    );
    this.data = new DataService(this.connections, () => this.getSettings(), this.events);
    this.redis = new RedisService(this.connections, () => this.getSettings(), this.events);
    this.audit = new AuditService(stores.audit, this.events, () =>
      [...this.connections.list().map((connection) => connection.id), '__mcp_token'].flatMap(
        (id) => {
          try {
            return [credentials.get(id) ?? ''];
          } catch {
            return [];
          }
        },
      ),
    );
    this.permissions = new PermissionService(() => this.getSettings(), this.events);
    this.commands = new CommandBus(this.permissions, this.audit, this.events, (id) =>
      this.connections.get(id),
    );
    this.scripts = new SqlScriptService(
      this.connections,
      this.events,
      this.permissions,
      this.audit,
      () => this.getSettings(),
    );
    this.exports = new SqlExportService(
      this.connections,
      this.events,
      this.permissions,
      this.audit,
      () => this.getSettings(),
    );
    this.register();
  }
  getSettings() {
    return structuredClone(this.settings);
  }
  private register() {
    const register = this.commands.register.bind(this.commands);
    const empty = z.object({}).strict();
    const redisScope = idSchema.extend({
      database: z
        .string()
        .regex(/^(0|[1-9]\d*)$/)
        .max(10)
        .optional(),
    });
    const redisKey = redisScope.extend({ key: z.string().min(1).max(4096) });
    const redisPage = {
      cursor: z.string().max(128).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    };
    register('redis.databases', {
      schema: idSchema.strict(),
      risk: 'read',
      description: 'List Redis logical databases and key counts.',
      execute: (args) => this.redis.databases(args.connectionId),
    });
    register('app.open_redis', {
      schema: redisScope.strict(),
      risk: 'workspace',
      description: 'Open a Redis key workspace.',
      execute: (args) => {
        const connection = this.connections.get(args.connectionId);
        if (connection.engine !== 'redis') throw new Error('Not a Redis connection.');
        const database = String(Number(args.database ?? connection.database));
        const existing = this.workspace
          .get()
          .tabs.find(
            (tab) =>
              tab.type === 'redis' &&
              tab.connectionId === connection.id &&
              String(Number(tab.database ?? connection.database)) === database,
          );
        if (existing) {
          this.workspace.activate(existing.id);
          return existing;
        }
        return this.workspace.open({
          connectionId: connection.id,
          type: 'redis',
          title: `Redis DB${database}`,
          database,
          sql: '',
        });
      },
    });
    register('redis.scan', {
      schema: redisScope
        .extend({ pattern: z.string().max(4096).default('*'), ...redisPage })
        .strict(),
      risk: 'read',
      description: 'Scan a bounded page of matching Redis keys; continue with the opaque cursor.',
      execute: (args, actor) => this.redis.read('scan', args, actor),
    });
    for (const operation of ['get', 'hgetall', 'lrange', 'smembers', 'zrange', 'xrange', 'ttl'])
      register(`redis.${operation}`, {
        schema: redisKey.extend(redisPage).strict(),
        risk: 'read',
        description: `Read Redis ${operation} with bounded pagination.`,
        execute: (args, actor) => this.redis.read(operation, args, actor),
      });
    const value = z.string().max(1024 * 1024);
    const streamId = z
      .string()
      .regex(/^\d+-\d+$/)
      .max(41);
    const redisWrites = {
      xadd: {
        id: z.union([z.literal('*'), streamId]).default('*'),
        fields: z
          .array(z.tuple([z.string().max(4096), value]))
          .min(1)
          .max(512),
      },
      xdelete: { id: streamId },
      json_set: { value },
      set: { value },
      hset: { field: z.string().min(1).max(4096), value },
      hdelete: { field: z.string().min(1).max(4096) },
      lset: { index: z.number().int().min(0), value },
      rpush: { value },
      sadd: { member: value },
      srem: { member: value },
      zadd: { member: value, score: z.number().finite() },
      zrem: { member: value },
      delete: {},
      expire: { ttl: z.number().int().min(-1).max(2147483647) },
    };
    for (const [operation, shape] of Object.entries(redisWrites))
      register(`redis.${operation}`, {
        schema: redisKey.extend(shape).strict(),
        risk:
          operation === 'expire'
            ? (args) => (args.ttl === 0 ? 'delete' : 'update')
            : ['delete', 'hdelete', 'srem', 'zrem', 'xdelete'].includes(operation)
              ? 'delete'
              : 'update',
        description: `Redis ${operation}; subject to connection write permissions and approval.`,
        execute: (args, actor) => this.redis.write(operation, args, actor),
      });
    const visibleConnections = (actor: Actor) =>
      this.connections
        .list()
        .filter((connection) => actor.kind === 'human' || connection.agentAccess !== 'disabled');
    const visibleWorkspace = (actor: Actor) => {
      const state = this.workspace.get();
      const visible = new Set(visibleConnections(actor).map((connection) => connection.id));
      state.tabs = state.tabs.filter((tab) => visible.has(tab.connectionId));
      if (!state.tabs.some((tab) => tab.id === state.activeTab)) state.activeTab = undefined;
      if (!visible.has(state.activeConnection ?? '')) state.activeConnection = undefined;
      return state;
    };
    register('app.get_state', {
      schema: empty,
      risk: 'read',
      description: 'Current shared workspace context.',
      execute: (_, actor) => {
        const workspace = visibleWorkspace(actor);
        const active = workspace.tabs.find((tab) => tab.id === workspace.activeTab);
        return {
          ...workspace,
          activeDatabase: active?.database,
          database: active?.database,
          schema: active?.schema,
          activeTable: active?.table,
          selectedRows: active?.selectedRows ?? [],
          activeQueryTab: active?.type === 'query' ? active.id : undefined,
        };
      },
    });
    register('app.list_tabs', {
      schema: empty,
      risk: 'read',
      description: 'List visible workspace tabs.',
      execute: (_, actor) => visibleWorkspace(actor).tabs,
    });
    register('app.open_query', {
      schema: idSchema
        .extend({
          sql: z.string().max(1000000).default(''),
          title: z.string().max(120).default('Query'),
          database: z.string().min(1).max(1024).optional(),
          schema: z.string().min(1).max(256).optional(),
        })
        .strict(),
      risk: 'workspace',
      description: 'Open SQL in the desktop workspace.',
      execute: (args) =>
        this.workspace.open({
          ...args,
          type: 'query',
          database: args.database ?? this.connections.get(args.connectionId).database,
        }),
    });
    register('app.open_table', {
      schema: tableSchema.strict(),
      risk: 'workspace',
      description: 'Open a table in the shared workspace.',
      execute: (args) =>
        this.workspace.open({
          ...args,
          type: 'table',
          title: args.table,
          sql: '',
          database: args.database ?? this.connections.get(args.connectionId).database,
        }),
    });
    register('app.open_object', {
      schema: idSchema
        .extend({
          database: z.string().min(1).max(1024).optional(),
          schema: z.string().max(1024),
          table: z.string().max(1024),
          objectName: z.string().min(1).max(1024),
          type: z.enum(['index', 'trigger']),
        })
        .strict(),
      risk: 'workspace',
      description: 'Open an index or trigger definition editor in a workspace tab.',
      execute: (args) =>
        this.workspace.open({
          ...args,
          title: args.objectName,
          sql: '',
          database: args.database ?? this.connections.get(args.connectionId).database,
        }),
    });
    register('connection.list', {
      schema: empty,
      risk: 'read',
      description: 'List permitted connections without credentials.',
      execute: (_, actor) => visibleConnections(actor),
    });
    register('connection.status', {
      schema: idSchema.strict(),
      risk: 'read',
      description: 'Check a connection status.',
      execute: (args) => this.connections.status(args.connectionId),
    });
    register('connection.statuses', {
      schema: empty,
      risk: 'read',
      description: 'Runtime status of visible connections; does not connect.',
      execute: (_, actor) =>
        Object.fromEntries(
          visibleConnections(actor).map((connection) => [
            connection.id,
            this.connections.status(connection.id),
          ]),
        ),
    });
    register('connection.connect', {
      schema: idSchema.strict(),
      risk: 'read',
      description: 'Connect using credentials held by the desktop.',
      execute: async (args, actor) => {
        // Only the desktop user may lift a manual disconnect block.
        await this.connections.connect(args.connectionId, undefined, actor.kind === 'human');
        return this.connections.status(args.connectionId);
      },
    });
    register('connection.disconnect', {
      schema: idSchema.extend({ discard: z.boolean().default(false) }).strict(),
      risk: 'workspace',
      description: 'Disconnect a database.',
      execute: async (args, actor) => {
        // Agents can never discard the user's unsaved drafts.
        this.workspace.closeConnection(args.connectionId, actor.kind === 'human' && args.discard);
        this.query.cancelConnection(args.connectionId);
        this.scripts.cancelConnection(args.connectionId);
        await this.connections.disconnect(args.connectionId, true);
        return this.connections.status(args.connectionId);
      },
    });
    register('connection.save', {
      schema: connectionSchema.safeExtend({ discard: z.boolean().default(false) }),
      humanOnly: true,
      risk: 'workspace',
      description: 'Save connection metadata and secure credentials.',
      execute: ({ discard, ...args }) => this.connections.save(args, discard),
    });
    register('connection.delete', {
      schema: idSchema.extend({ discard: z.boolean().default(false) }).strict(),
      humanOnly: true,
      risk: 'workspace',
      description: 'Delete a saved connection.',
      execute: (args) => this.connections.delete(args.connectionId, args.discard),
    });
    register('connection.test', {
      schema: connectionSchema,
      humanOnly: true,
      risk: 'read',
      description: 'Test a connection configuration.',
      execute: (args) => this.connections.test(args),
    });
    const scriptInput = idSchema
      .extend({
        database: z.string().min(1).max(1024),
        sql: z.string().min(1).max(SQL_FILE_LIMIT),
        fileName: z.string().min(1).max(255).default('script.sql'),
        mysqlSqlMode: z
          .string()
          .max(1024)
          .regex(/^[A-Z0-9_,]*$/)
          .optional(),
      })
      .strict();
    register('script.preview', {
      schema: scriptInput,
      risk: 'read',
      description: 'Parse SQL statements/batches and show line numbers. Does not execute the file.',
      auditArguments: (args) => this.scripts.auditArguments(args),
      execute: (args) => this.scripts.preview(args),
    });
    register('script.execute', {
      schema: scriptInput
        .extend({ id: z.string().uuid(), continueOnError: z.boolean().default(false) })
        .strict(),
      risk: 'destructive',
      additionalRisks: (args) => this.scripts.risks(args),
      description:
        'Run a SQL file on an isolated persistent session. Partial commits are possible. Returns a run ID; use script.status/cancel. Unknown batches require all write policies.',
      auditArguments: (args) => this.scripts.auditArguments(args),
      execute: (args, actor) => this.scripts.start(args, actor),
    });
    for (const action of ['status', 'cancel'] as const)
      register(`script.${action}`, {
        schema: z.object({ id: z.string().uuid() }).strict(),
        risk: 'read',
        description: `${action === 'status' ? 'Inspect' : 'Cancel'} an owned SQL file run.`,
        execute: (args, actor) => this.scripts[action](args.id, actor),
      });
    register('export.start', {
      schema: idSchema
        .extend({
          id: z.string().uuid(),
          database: z.string().min(1).max(1024),
          includeData: z.boolean(),
        })
        .strict(),
      risk: 'read',
      description:
        'Generate an owned SQL export (SQLite, MySQL/MariaDB, PostgreSQL or SQL Server; 16 MiB limit). SQL Server requires PowerShell with SqlServer/SQLPS and holds shared table locks during data export, temporarily blocking writes. PostgreSQL requires pg_dump client tools and preserves role/extension/tablespace references. MySQL uses InnoDB snapshots or READ locks for mixed local engines, temporarily blocking writes; restore to the original database name/collation. Use export.status/read/release.',
      execute: (args, actor) => this.exports.start(args, actor),
    });
    for (const action of ['status', 'cancel', 'release'] as const)
      register(`export.${action}`, {
        schema: z.object({ id: z.string().uuid() }).strict(),
        risk: 'read',
        description: `${action} an owned SQL export.`,
        execute: (args, actor) => this.exports[action](args.id, actor),
      });
    register('export.read', {
      schema: z
        .object({
          id: z.string().uuid(),
          offset: z.number().int().min(0).max(SQL_FILE_LIMIT).default(0),
        })
        .strict(),
      risk: 'read',
      description:
        'Read up to 64 KiB of an owned completed SQL export as base64. Offset is in bytes. Never reads arbitrary files.',
      execute: (args, actor) => this.exports.read(args.id, args.offset, actor),
    });
    register('database.list', {
      schema: idSchema.strict(),
      risk: 'read',
      description: 'List databases.',
      execute: async (args) => (await this.connections.connect(args.connectionId)).databases(),
    });
    register('database.options', {
      schema: idSchema.strict(),
      risk: 'read',
      description:
        'List server-supported database character sets, collations and PostgreSQL locale providers.',
      execute: async (args) =>
        databaseOptions(
          this.connections.get(args.connectionId).engine,
          await this.connections.connect(args.connectionId),
        ),
    });
    const databaseTarget = idSchema.extend({ database: z.string().min(1).max(1024) }).strict();
    const databaseChange = databaseTarget
      .extend({ changes: databasePropertyChangeSchema, version: z.string().length(64) })
      .strict();
    const databaseAdmin = (id: string, database: string) =>
      this.connections.connect(
        id,
        this.connections.get(id).engine === 'sqlserver'
          ? 'master'
          : this.connections.get(id).engine === 'sqlite'
            ? database
            : undefined,
      );
    register('database.properties.describe', {
      schema: databaseTarget,
      risk: 'read',
      description: 'Read database encoding, collation and edit capabilities.',
      execute: async (args) =>
        readDatabaseProperties(
          await databaseAdmin(args.connectionId, args.database),
          this.connections.get(args.connectionId).engine,
          args.database,
        ),
    });
    register('database.properties.preview', {
      schema: databaseChange,
      risk: 'read',
      description: 'Preview database default charset/collation changes against a metadata version.',
      execute: async (args) =>
        planDatabaseProperties(
          await databaseAdmin(args.connectionId, args.database),
          this.connections.get(args.connectionId).engine,
          args.database,
          args.changes,
          args.version,
        ),
    });
    register('database.properties.apply', {
      schema: databaseChange,
      risk: 'destructive',
      description:
        'Change database default charset/collation. SQL Server releases only this app’s target pool; no forced client disconnections.',
      execute: async (args) => {
        const key = JSON.stringify([args.connectionId, args.database]);
        if (this.databasePropertyWrites.has(key))
          throw new Error('Database properties are already being changed.');
        this.databasePropertyWrites.add(key);
        try {
          const engine = this.connections.get(args.connectionId).engine;
          const adapter = await databaseAdmin(args.connectionId, args.database);
          // Validate before releasing a pool, including the read-only system-database guard.
          await planDatabaseProperties(adapter, engine, args.database, args.changes, args.version);
          const apply = async () => {
            const plan = await planDatabaseProperties(
              adapter,
              engine,
              args.database,
              args.changes,
              args.version,
            );
            await adapter.query(plan.sql, [], { limit: 1, timeout: 30000, readOnly: false });
            this.events.emit('DatabasePropertiesChanged', {
              connectionId: args.connectionId,
              database: args.database,
            });
            return readDatabaseProperties(adapter, engine, args.database);
          };
          return engine === 'sqlserver'
            ? await this.connections.withDatabaseSuspended(args.connectionId, args.database, apply)
            : await apply();
        } finally {
          this.databasePropertyWrites.delete(key);
        }
      },
    });
    register('database.create', {
      schema: idSchema
        .extend({ database: z.string().min(1).max(128), ...databaseCreateOptionsSchema.shape })
        .strict(),
      risk: 'ddl',
      description:
        'Create a SQL database. MySQL/MariaDB supports charset/collation; PostgreSQL supports encoding and locale; SQL Server supports collation. Omitted options use server defaults.',
      execute: async (args, actor) => {
        const connection = this.connections.get(args.connectionId);
        const { connectionId: _id, database: _database, ...options } = args;
        if (Object.values(options).some((value) => value !== undefined))
          validateDatabaseOptions(
            options,
            await databaseOptions(connection.engine, await this.connections.connect(connection.id)),
          );
        const sql = createDatabaseSql(connection.engine, args.database, options);
        await this.query.execute({ connectionId: connection.id, sql }, actor, false);
        this.events.emit('DatabaseCreated', args);
        return { database: args.database };
      },
    });
    register('schema.list', {
      schema: idSchema.extend({ database: z.string().min(1).max(1024).optional() }).strict(),
      risk: 'read',
      description: 'List schemas.',
      execute: async (args) =>
        (await this.connections.connect(args.connectionId, args.database)).schemas(),
    });
    register('table.list', {
      schema: idSchema
        .extend({ database: z.string().min(1).max(1024).optional(), schema: z.string().optional() })
        .strict(),
      risk: 'read',
      description: 'List tables and views.',
      execute: async (args) =>
        (await this.connections.connect(args.connectionId, args.database)).tables(args.schema),
    });
    for (const kind of ['index', 'trigger'] as const)
      register(`${kind}.list`, {
        schema: idSchema.extend({ database: z.string().min(1).max(1024).optional() }).strict(),
        risk: 'read',
        description: `List ${kind} metadata in the selected database.`,
        execute: async (args) =>
          listDatabaseObjects(
            await this.connections.connect(args.connectionId, args.database),
            this.connections.get(args.connectionId),
            kind,
          ),
      });
    register('app.open_create_object', {
      schema: idSchema
        .extend({
          database: z.string().optional(),
          schema: z.string().optional(),
          kind: z.enum(['table', 'view', 'index', 'trigger']),
        })
        .strict(),
      risk: 'workspace',
      description: 'Open an object creation tab without executing DDL.',
      execute: (args) => {
        const connection = this.connections.get(args.connectionId);
        if (connection.engine === 'redis') throw new Error('Redis does not support SQL objects.');
        return this.workspace.open({
          type: 'create',
          createKind: args.kind,
          title: `Create ${args.kind}`,
          connectionId: args.connectionId,
          database: args.database ?? connection.database,
          schema: args.schema,
          sql: '',
        });
      },
    });
    register('object.create_preview', {
      schema: createObjectSchema,
      risk: 'read',
      description:
        'Validate an object creation form and preview generated SQL without executing it.',
      execute: async (args) =>
        planCreateObject(
          await this.connections.connect(args.connectionId, args.database),
          this.connections.get(args.connectionId),
          args,
        ),
    });
    register('object.create', {
      schema: createObjectSchema,
      risk: 'ddl',
      description:
        'Create a new table, view, index or trigger in the selected database and schema. Existing objects are never replaced.',
      execute: async (args) => {
        const adapter = await this.connections.connect(args.connectionId, args.database);
        const plan = await planCreateObject(adapter, this.connections.get(args.connectionId), args);
        if (!adapter.executeDdl) throw new Error('DDL execution is not supported by this adapter.');
        await adapter.executeDdl(plan.statements, this.getSettings().queryTimeout);
        this.events.emit('DatabaseObjectCreated', args);
        return { success: true, ...plan };
      },
    });
    const dropPreview = async (args: import('../../shared/drop-object').DropObjectRef) => {
      const ref = {
        ...args,
        database: args.database ?? this.connections.get(args.connectionId).database,
      };
      const plan = await planDropObject(
        await this.connections.connect(ref.connectionId, ref.database),
        this.connections.get(ref.connectionId),
        ref,
      );
      const engine = this.connections.get(ref.connectionId).engine;
      const defaultSchema =
        engine === 'sqlite'
          ? 'main'
          : engine === 'postgres'
            ? 'public'
            : ['sqlserver', 'sybase'].includes(engine)
              ? 'dbo'
              : (ref.database ?? '');
      const tabs = this.workspace
        .get()
        .tabs.filter((tab) => matchesDroppedObject(tab, ref, defaultSchema))
        .map(({ id, title, dirty }) => ({ id, title, dirty }));
      return { ...plan, tabs };
    };
    register('object.drop_preview', {
      schema: dropObjectSchema,
      risk: 'read',
      description: 'Preview object deletion, owned indexes/triggers and affected workspace tabs.',
      execute: dropPreview,
    });
    register('object.drop', {
      schema: dropObjectSchema
        .extend({ version: z.string().length(64), discard: z.boolean().default(false) })
        .strict(),
      risk: 'destructive',
      description:
        'Drop one table, view, index or trigger after checking its preview version. Does not use CASCADE.',
      execute: async (args) => {
        const plan = await dropPreview(args);
        if (plan.version !== args.version)
          throw new Error('Object changed. Preview deletion again.');
        if (!args.discard && plan.tabs.some((tab) => tab.dirty))
          throw new Error('Unsaved changes: save or explicitly discard before deleting.');
        const adapter = await this.connections.connect(args.connectionId, args.database);
        if (!adapter.executeDdl) throw new Error('DDL execution is not supported by this adapter.');
        await adapter.executeDdl(plan.statements, this.getSettings().queryTimeout, {
          validateViews: true,
        });
        for (const tab of plan.tabs) this.workspace.close(tab.id, true);
        this.events.emit('DatabaseObjectDropped', args);
        return { success: true };
      },
    });
    const renameScope = (args: RenameObjectInput) => {
      const connection = this.connections.get(args.connectionId);
      const ref = { ...args, database: args.database ?? connection.database };
      const defaultSchema =
        connection.engine === 'sqlite'
          ? 'main'
          : connection.engine === 'postgres'
            ? 'public'
            : ['sqlserver', 'sybase'].includes(connection.engine)
              ? 'dbo'
              : ref.database;
      return { connection, ref, defaultSchema };
    };
    const renamePreview = async (args: RenameObjectInput) => {
      const { connection, ref, defaultSchema } = renameScope(args);
      const plan = await planRenameObject(
        await this.connections.connect(ref.connectionId, ref.database),
        connection,
        ref,
      );
      const tabs = this.workspace
        .get()
        .tabs.filter((tab) => matchesDroppedObject(tab, ref, defaultSchema))
        .map(({ id, title, dirty }) => ({ id, title, dirty }));
      return { ...plan, tabs };
    };
    register('object.rename_preview', {
      schema: renameObjectSchema,
      risk: 'read',
      description:
        'Preview renaming a table, view, index or trigger, including SQL and affected tabs.',
      execute: async (args) => {
        const { restore, ...plan } = await renamePreview(args);
        return plan;
      },
    });
    const renameLocks = new Map<string, Promise<unknown>>();
    register('object.rename', {
      schema: renameObjectSchema.extend({ version: z.string().length(64) }).strict(),
      risk: 'ddl',
      description:
        'Rename one SQL object after checking its preview version and unsaved tabs. Does not move schemas or overwrite objects.',
      execute: async (args) => {
        const task = (renameLocks.get(args.connectionId) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            const plan = await renamePreview(args);
            if (plan.version !== args.version)
              throw new Error('Object changed. Preview renaming again.');
            if (plan.tabs.some((tab) => tab.dirty))
              throw new Error('Unsaved changes: save or close related tabs before renaming.');
            const { ref, defaultSchema } = renameScope(args);
            const adapter = await this.connections.connect(ref.connectionId, ref.database);
            await executeRename(adapter, plan, this.getSettings().queryTimeout);
            const retainedDrafts = this.workspace.renamedObject(ref, defaultSchema);
            this.events.emit('DatabaseObjectRenamed', ref);
            return { success: true, newName: ref.newName, retainedDrafts };
          });
        renameLocks.set(args.connectionId, task);
        try {
          return await task;
        } finally {
          if (renameLocks.get(args.connectionId) === task) renameLocks.delete(args.connectionId);
        }
      },
    });
    const objectSchema = idSchema.extend({
      database: z.string().min(1).max(1024).optional(),
      schema: z.string().max(1024),
      table: z.string().max(1024),
      objectName: z.string().min(1).max(1024),
      kind: z.enum(['index', 'trigger']),
    });
    register('object.describe', {
      schema: objectSchema.strict(),
      risk: 'read',
      description: 'Read the complete editable index or trigger definition and its version.',
      execute: async (args) =>
        readObjectDefinition(
          await this.connections.connect(args.connectionId, args.database),
          this.connections.get(args.connectionId),
          args,
        ),
    });
    const objectEdit = objectSchema.extend({
      sql: z.string().min(1).max(524288).optional(),
      indexOptions: indexOptionsSchema.optional(),
    });
    const oneEdit = (args: { sql?: string; indexOptions?: unknown; kind: string }) =>
      (args.sql !== undefined) !== (args.indexOptions !== undefined) &&
      (args.indexOptions === undefined || args.kind === 'index');
    register('index.options', {
      schema: tableSchema.strict(),
      risk: 'read',
      description: 'Read index types, methods and comment support for a target table.',
      execute: async (args) =>
        indexCapabilities(
          await this.connections.connect(args.connectionId, args.database),
          this.connections.get(args.connectionId).engine,
          args,
        ),
    });
    register('object.preview', {
      schema: objectEdit.strict().refine(oneEdit, 'Provide either SQL or index options.'),
      risk: 'read',
      description: 'Preview the SQL required to edit an index or trigger without executing it.',
      execute: async (args) =>
        planObjectChange(
          await readObjectDefinition(
            await this.connections.connect(args.connectionId, args.database),
            this.connections.get(args.connectionId),
            args,
          ),
          args,
          args.sql ?? args.indexOptions!,
        ),
    });
    register('object.apply', {
      schema: objectEdit
        .extend({ version: z.string().length(64) })
        .strict()
        .refine(oneEdit, 'Provide either SQL or index options.'),
      risk: 'ddl',
      description:
        'Apply an index or trigger definition with a stale-version check. MySQL trigger replacement is not atomic; restoration is attempted if creation fails.',
      execute: async (args) => {
        const result = await applyObjectChange(
          await this.connections.connect(args.connectionId, args.database),
          this.connections.get(args.connectionId),
          args,
          args.sql ?? args.indexOptions!,
          args.version,
          this.getSettings().queryTimeout,
        );
        this.events.emit('DatabaseObjectChanged', args);
        return result;
      },
    });
    register('structure.describe', {
      schema: tableSchema.strict(),
      risk: 'read',
      description: 'Read editable table columns or a view definition with a structure version.',
      execute: async (args) =>
        describeStructure(
          await this.connections.connect(args.connectionId, args.database),
          this.connections.get(args.connectionId),
          args,
        ),
    });
    register('view.options', {
      schema: idSchema.extend({ database: z.string().optional() }).strict(),
      risk: 'read',
      description: 'Read view options supported by the connected server version.',
      execute: async (args) =>
        viewCapabilities(
          await this.connections.connect(args.connectionId, args.database),
          this.connections.get(args.connectionId).engine,
        ),
    });
    register('generation.options', {
      schema: idSchema.extend({ database: z.string().optional() }).strict(),
      risk: 'read',
      description: 'Read generated column capabilities for the connected server version.',
      execute: async (args) =>
        generationCapabilities(
          await this.connections.connect(args.connectionId, args.database),
          this.connections.get(args.connectionId).engine,
        ),
    });
    register('structure.options', {
      schema: idSchema.extend({ database: z.string().optional() }).strict(),
      risk: 'read',
      description: 'List supported table and column properties and server options.',
      execute: async (args) =>
        structurePropertyOptions(
          await this.connections.connect(args.connectionId, args.database),
          this.connections.get(args.connectionId).engine,
        ),
    });
    register('structure.preview', {
      schema: tableSchema.extend({ change: structureChangeSchema }).strict(),
      risk: 'read',
      description: 'Preview a scoped table or view structure change without executing it.',
      execute: async (args) => {
        const adapter = await this.connections.connect(args.connectionId, args.database);
        const detail = await describeStructure(
          adapter,
          this.connections.get(args.connectionId),
          args,
        );
        if (args.change.action === 'generated-add' || args.change.action === 'generated-edit')
          return planGeneratedChange(adapter, detail, args.change);
        return args.change.action === 'table-properties' ||
          args.change.action === 'column-properties'
          ? planPropertyChange(adapter, detail, args.change)
          : planStructure(detail, args.change);
      },
    });
    register('structure.apply', {
      schema: tableSchema
        .extend({ change: structureChangeSchema, version: z.string().length(64) })
        .strict(),
      risk: (args) =>
        ['drop', 'type', 'primary-key', 'constraint-drop', 'generated-edit'].includes(
          args.change.action,
        ) ||
        ((args.change.action === 'table-properties' ||
          args.change.action === 'column-properties') &&
          Object.keys(args.change.properties).some((key) => key !== 'comment')) ||
        (args.change.action === 'constraint-upsert' && args.change.id !== undefined) ||
        (args.change.action === 'add' && args.change.primaryKey) ||
        (args.change.action === 'edit-columns' &&
          (args.change.primaryKey !== undefined ||
            args.change.changes.some((change: ColumnPropertyChange) => change.action === 'type')))
          ? 'destructive'
          : 'ddl',
      description:
        'Apply a version-checked table or view structure change. Column removal, type conversion and primary-key replacement require destructive-operation approval.',
      execute: async (args) => {
        const result = await applyStructure(
          await this.connections.connect(args.connectionId, args.database),
          this.connections.get(args.connectionId),
          args,
          args.change,
          args.version,
          this.getSettings().queryTimeout,
        );
        this.events.emit('TableStructureChanged', { ...args, schema: result.schema });
        return result;
      },
    });
    register('table.describe', {
      schema: tableSchema.strict(),
      risk: 'read',
      description: 'Describe columns, types, nullability, defaults and primary keys.',
      execute: async (args) =>
        (await this.connections.connect(args.connectionId, args.database)).describe(args),
    });
    register('query.validate', {
      schema: querySchema.pick({ connectionId: true, sql: true }).strict(),
      risk: 'read',
      description: 'Classify SQL without executing it.',
      execute: (args) => this.query.validate(args.connectionId, args.sql),
    });
    register('query.read', {
      schema: querySchema.strict(),
      risk: 'read',
      description: 'Execute one verified read-only SELECT with bounded results.',
      execute: (args, actor) => this.query.execute(args, actor, true),
    });
    register('query.next', {
      schema: idSchema.extend({ cursor: z.string().min(1).max(128) }).strict(),
      risk: 'read',
      description:
        'Read the next bounded page of a query. Cursors expire after five minutes and are single-use. Pages re-run the original read query against current data; use ORDER BY for consistent ordering.',
      execute: (args, actor) => this.query.next(args.connectionId, args.cursor, actor),
    });
    register('query.execute', {
      schema: querySchema.strict(),
      risk: (args) => this.query.validate(args.connectionId, args.sql).risk,
      description: 'Execute SQL subject to connection policy and user approval.',
      execute: (args, actor) =>
        this.query.execute(
          args,
          actor,
          this.query.validate(args.connectionId, args.sql).risk === 'read',
        ),
    });
    register('query.cancel', {
      schema: z.object({ id: z.string() }).strict(),
      risk: 'read',
      description: 'Cancel a running query owned by the caller.',
      execute: (args, actor) => this.query.cancel(args.id, actor),
    });
    register('data.select', {
      schema: selectSchema.strict(),
      risk: 'read',
      description: 'Read a bounded table page using structured filters and sorting.',
      execute: (args) => this.data.select(args.connectionId, args),
    });
    register('data.insert', {
      schema: tableSchema.extend({ values: valuesSchema }).strict(),
      risk: 'insert',
      description: 'Insert a row with parameterized values.',
      execute: (args) => this.data.mutate('insert', args.connectionId, args, args.values, []),
    });
    register('data.update', {
      schema: tableSchema
        .extend({ values: valuesSchema, filters: z.array(filterSchema).min(1).max(30) })
        .strict(),
      risk: 'update',
      description: 'Update matching rows, subject to approval.',
      execute: (args) =>
        this.data.mutate('update', args.connectionId, args, args.values, args.filters),
    });
    register('data.delete', {
      schema: tableSchema.extend({ filters: z.array(filterSchema).min(1).max(30) }).strict(),
      risk: 'delete',
      description: 'Delete matching rows, subject to approval.',
      execute: (args) => this.data.mutate('delete', args.connectionId, args, {}, args.filters),
    });
    register('workspace.update', {
      schema: z
        .object({
          id: z.string(),
          patch: z
            .object({
              sql: z.string().optional(),
              title: z.string().optional(),
              dirty: z.boolean().optional(),
              objectVersion: z.string().max(64).optional(),
              selectedRows: z.array(z.unknown()).optional(),
            })
            .strict(),
        })
        .strict(),
      humanOnly: true,
      risk: 'workspace',
      description: 'Update a desktop tab.',
      execute: (args) => this.workspace.update(args.id, args.patch),
    });
    register('workspace.activate', {
      schema: z.object({ id: z.string() }).strict(),
      humanOnly: true,
      risk: 'workspace',
      description: 'Activate a tab.',
      execute: (args) => this.workspace.activate(args.id),
    });
    register('workspace.close', {
      schema: z
        .object({
          id: z.string(),
          discard: z.boolean().default(false),
          others: z.boolean().default(false),
        })
        .strict(),
      humanOnly: true,
      risk: 'workspace',
      description: 'Close tabs with a dirty-state guard.',
      execute: (args) => this.workspace.close(args.id, args.discard, args.others),
    });
    register('workspace.reorder', {
      schema: z.object({ ids: z.array(z.string()) }).strict(),
      humanOnly: true,
      risk: 'workspace',
      description: 'Reorder tabs.',
      execute: (args) => this.workspace.reorder(args.ids),
    });
    register('settings.get', {
      schema: empty,
      humanOnly: true,
      risk: 'read',
      description: 'Read settings.',
      execute: () => this.getSettings(),
    });
    register('settings.save', {
      schema: settingsSchema,
      humanOnly: true,
      risk: 'workspace',
      description: 'Save application settings.',
      execute: (args) => {
        this.stores.settings.write(args);
        this.settings = args;
        this.events.emit('SettingsChanged');
        return this.getSettings();
      },
    });
    register('history.list', {
      schema: z.object({ search: z.string().default('') }).strict(),
      humanOnly: true,
      risk: 'read',
      description: 'Search query history.',
      execute: (args) => this.query.listHistory(args.search),
    });
    register('audit.list', {
      schema: z.object({ search: z.string().default('') }).strict(),
      humanOnly: true,
      risk: 'read',
      description: 'Search the activity audit.',
      execute: (args) => this.audit.list(args.search),
    });
    register('approval.list', {
      schema: empty,
      humanOnly: true,
      risk: 'read',
      description: 'List approval requests.',
      execute: () => this.permissions.list(),
    });
    register('approval.resolve', {
      schema: z
        .object({
          id: z.string(),
          approve: z.boolean(),
          mode: z.enum(['once', 'session']).default('once'),
        })
        .strict(),
      humanOnly: true,
      risk: 'workspace',
      description:
        'Approve once, grant this session ten minutes on the same operation and target, or reject.',
      execute: (args, actor) =>
        this.commands.resolveApproval(args.id, args.approve, actor, args.mode),
    });
  }
}
