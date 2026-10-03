import { z } from 'zod';
import type { CommandBus } from '../../application/commands/command-bus';
import type { Actor, AgentLevel, CommandResult } from '../../../shared/types';

// This is the public MCP surface, not another command bus. Each action delegates
// to its original command so policy, approvals, ownership and audit stay shared.
export const MCP_TOOL_GROUPS = [
  {
    name: 'app.inspect',
    description: 'Inspect the shared desktop workspace.',
    actions: {
      state: 'app.get_state',
      tabs: 'app.list_tabs',
    },
  },
  {
    name: 'app.open',
    description: 'Open a desktop workspace tab without executing SQL.',
    actions: {
      query: 'app.open_query',
      table: 'app.open_table',
      redis: 'app.open_redis',
      object: 'app.open_object',
      create_object: 'app.open_create_object',
    },
  },
  {
    name: 'connection.manage',
    description:
      'List, inspect, connect or disconnect existing permitted connections. Credentials remain in the desktop.',
    actions: {
      list: 'connection.list',
      status: 'connection.status',
      statuses: 'connection.statuses',
      connect: 'connection.connect',
      disconnect: 'connection.disconnect',
    },
  },
  {
    name: 'catalog.list',
    description: 'List SQL database, schema, table/view, index or trigger metadata.',
    actions: {
      databases: 'database.list',
      schemas: 'schema.list',
      tables: 'table.list',
      indexes: 'index.list',
      triggers: 'trigger.list',
    },
  },
  {
    name: 'database.manage',
    description:
      'Inspect database creation options and properties, preview property changes or apply changes/create a database under write policy.',
    actions: {
      options: 'database.options',
      create: 'database.create',
      describe: 'database.properties.describe',
      preview: 'database.properties.preview',
      apply: 'database.properties.apply',
    },
  },
  {
    name: 'object.inspect',
    description: 'Read an index/trigger definition and version, or index capabilities.',
    actions: {
      describe: 'object.describe',
      index_options: 'index.options',
    },
  },
  {
    name: 'object.preview',
    description:
      'Validate and preview SQL object creation, deletion, renaming or index/trigger editing without executing changes.',
    actions: {
      create: 'object.create_preview',
      drop: 'object.drop_preview',
      rename: 'object.rename_preview',
      edit: 'object.preview',
    },
  },
  {
    name: 'object.apply',
    description:
      'Create, delete, rename or edit SQL objects under the original DDL/destructive policy and version checks.',
    actions: {
      create: 'object.create',
      drop: 'object.drop',
      rename: 'object.rename',
      edit: 'object.apply',
    },
  },
  {
    name: 'structure.inspect',
    description:
      'Describe table/view structure, inspect server capabilities or preview a structure change without applying it.',
    actions: {
      columns: 'table.describe',
      describe: 'structure.describe',
      options: 'structure.options',
      view_options: 'view.options',
      generation_options: 'generation.options',
      preview: 'structure.preview',
    },
  },
  {
    name: 'structure.apply',
    description:
      'Apply a version-checked table/view structure change under DDL or destructive policy.',
    actions: {
      apply: 'structure.apply',
    },
  },
  {
    name: 'query.manage',
    description:
      'Validate SQL, execute a bounded read or policy-controlled single statement, page results or cancel an owned query.',
    actions: {
      validate: 'query.validate',
      read: 'query.read',
      next: 'query.next',
      execute: 'query.execute',
      cancel: 'query.cancel',
    },
  },
  {
    name: 'data.manage',
    description:
      'Select bounded table rows or insert/update/delete rows under per-operation write policy.',
    actions: {
      select: 'data.select',
      insert: 'data.insert',
      update: 'data.update',
      delete: 'data.delete',
    },
  },
  {
    name: 'script.manage',
    description:
      'Preview SQL text, execute a batch with destructive approval, inspect status or cancel an owned run. No local file access.',
    actions: {
      preview: 'script.preview',
      execute: 'script.execute',
      status: 'script.status',
      cancel: 'script.cancel',
    },
  },
  {
    name: 'export.manage',
    description:
      'Start, inspect, read, cancel or release an owned SQL export. Read returns at most 64 KiB base64; no arbitrary file access.',
    actions: {
      start: 'export.start',
      status: 'export.status',
      read: 'export.read',
      cancel: 'export.cancel',
      release: 'export.release',
    },
  },
  {
    name: 'redis.read',
    description:
      'List Redis databases, scan keys or read typed values/TTL with bounded pagination.',
    actions: {
      databases: 'redis.databases',
      scan: 'redis.scan',
      get: 'redis.get',
      hgetall: 'redis.hgetall',
      lrange: 'redis.lrange',
      smembers: 'redis.smembers',
      zrange: 'redis.zrange',
      xrange: 'redis.xrange',
      ttl: 'redis.ttl',
    },
  },
  {
    name: 'redis.write',
    description:
      'Write Redis values, members, stream entries or TTL under per-operation policy. expire with ttl=0 requires delete permission.',
    actions: {
      set: 'redis.set',
      json_set: 'redis.json_set',
      hset: 'redis.hset',
      hdelete: 'redis.hdelete',
      lset: 'redis.lset',
      rpush: 'redis.rpush',
      sadd: 'redis.sadd',
      srem: 'redis.srem',
      zadd: 'redis.zadd',
      zrem: 'redis.zrem',
      xadd: 'redis.xadd',
      xdelete: 'redis.xdelete',
      delete: 'redis.delete',
      expire: 'redis.expire',
    },
  },
] as const;

export class McpToolCatalog {
  constructor(
    private commands: CommandBus,
    private level: () => AgentLevel,
  ) {}

  private tools() {
    const commands = new Map(this.commands.tools().map((command) => [command.name, command]));
    return MCP_TOOL_GROUPS.flatMap((group) => {
      const actions = Object.entries(group.actions).flatMap(([action, name]) => {
        const command = commands.get(name);
        if (!command) throw new Error(`Missing MCP command: ${name}`);
        if (this.level() === 'observe' && command.risk !== 'read') return [];
        if (!(command.schema instanceof z.ZodObject))
          throw new Error(`MCP action must have an object schema: ${name}`);
        return [
          {
            action,
            name,
            schema: command.schema
              .extend({ action: z.literal(action) })
              .strict()
              .describe(command.description),
          },
        ];
      });
      if (!actions.length) return [];
      // Branches retain each operation's required fields, defaults and limits.
      const schema = z.discriminatedUnion('action', [
        actions[0].schema,
        ...actions.slice(1).map((action) => action.schema),
      ]);
      return [{ ...group, actions, schema }];
    });
  }

  list() {
    return this.tools().map((tool) => ({
      name: tool.name,
      description:
        tool.description + '\nActions: ' + tool.actions.map((action) => action.action).join(', '),
      inputSchema: { ...z.toJSONSchema(tool.schema), type: 'object' as const },
    }));
  }

  async call(name: string, raw: unknown, actor: Actor): Promise<CommandResult> {
    const tool = this.tools().find((tool) => tool.name === name);
    if (!tool) return { success: false, error: 'Unknown or unavailable MCP tool. Use tools/list.' };
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success)
      return {
        success: false,
        error: 'Invalid or unavailable action/arguments. Use the tool input schema.',
      };
    const { action, ...args } = parsed.data;
    const target = tool.actions.find((candidate) => candidate.action === action)!;
    return this.commands.dispatch(target.name, args, actor);
  }
}
