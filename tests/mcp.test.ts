import { afterEach, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Application, HUMAN } from '../src/main/application/application';
import { MemoryStore } from '../src/main/application/services/store';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';
import { McpGateway, validateMcpConfig } from '../src/main/mcp/server/mcp-server';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { McpToolCatalog, MCP_TOOL_GROUPS } from '../src/main/mcp/server/tool-catalog';
import { z } from 'zod';
const cleanup: Array<() => Promise<unknown>> = [];
// This Windows host allocates ephemeral ports from 1024, including Fetch's blocked ports.
// Use a safe high range and retry collisions without changing the OS configuration.
async function startHttpGateway(gateway: McpGateway) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await gateway.start({
        ...DEFAULT_SETTINGS.mcp,
        enabled: true,
        port: randomInt(30000, 50000),
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 9) throw error;
    }
  }
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const secrets = new Map<string, string>();
  const credentials = {
    get: (id: string) => secrets.get(id),
    set: (id: string, value: string) => {
      secrets.set(id, value);
    },
    delete: (id: string) => {
      secrets.delete(id);
    },
  };
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(DEFAULT_SETTINGS),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    credentials,
    (connection) => new SqliteAdapter(connection.database),
  );
  const gateway = new McpGateway(app, credentials);
  cleanup.push(
    () => app.connections.shutdown(),
    () => gateway.stop(),
  );
  await startHttpGateway(gateway);
  const port = (gateway.status().address as { port: number }).port;
  return { app, gateway, url: new URL(`http://127.0.0.1:${port}/mcp`), token: gateway.token() };
}
it('runs the official Streamable HTTP client through tools, resources, shared workspace and approval', async () => {
  const { app, gateway, url, token } = await fixture();
  const connection = await app.connections.save({
    name: 'MCP SQLite',
    engine: 'sqlite',
    database: ':memory:',
    agentAccess: 'write',
  });
  await app.commands.dispatch(
    'query.execute',
    { connectionId: connection.id, sql: 'CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)' },
    HUMAN,
  );
  const client = new Client({ name: 'Integration Agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  cleanup.push(() => client.close());
  expect(gateway.status().agents).toBe(1);
  const tools = await client.listTools();
  expect(tools.tools).toHaveLength(16);
  expect(tools.tools.map((tool) => tool.name)).toContain('query.manage');
  expect(tools.tools.map((tool) => tool.name)).not.toContain('query.read');
  expect(tools.tools.map((tool) => tool.name)).not.toContain('settings.save');
  const opened = await client.callTool({
    name: 'app.open',
    arguments: { action: 'query', connectionId: connection.id, sql: 'SELECT * FROM users' },
  });
  expect(opened.isError).toBe(false);
  expect(app.workspace.get().tabs).toHaveLength(1);
  const resource = await client.readResource({ uri: 'app://workspace' });
  expect(JSON.stringify(resource)).toContain('SELECT * FROM users');
  const schema = await client.readResource({
    uri: `db://connection/${connection.id}/table/main/users`,
  });
  expect(JSON.stringify(schema)).toContain('primaryKey');
  expect(JSON.parse((schema.contents[0] as { text: string }).text)).toMatchObject({
    table: 'users',
    schema: 'main',
    columns: expect.any(Array),
  });
  const databaseSchema = await client.readResource({
    uri: `db://connection/${connection.id}/schema`,
  });
  expect(JSON.parse((databaseSchema.contents[0] as { text: string }).text)).toMatchObject({
    schemas: [
      {
        name: 'main',
        tables: expect.arrayContaining([expect.objectContaining({ name: 'users' })]),
      },
    ],
  });
  const pending = await client.callTool({
    name: 'data.manage',
    arguments: {
      action: 'insert',
      connectionId: connection.id,
      table: 'users',
      values: { name: 'Via MCP' },
    },
  });
  const approvalId = (pending.structuredContent as any).approvalId;
  expect(approvalId).toBeTruthy();
  await app.commands.resolveApproval(approvalId, true, HUMAN);
  const read = await client.callTool({
    name: 'query.manage',
    arguments: {
      action: 'read',
      connectionId: connection.id,
      sql: 'SELECT * FROM users',
      showInApp: true,
    },
  });
  expect(read.structuredContent).toMatchObject({
    success: true,
    data: { rowCount: 1, rows: [{ name: 'Via MCP' }] },
  });
  expect(app.audit.list().some((entry) => entry.actor.name === 'Integration Agent')).toBe(true);
  await transport.terminateSession();
  expect(gateway.status().agents).toBe(0);
}, 15000);
it('maps every public internal command exactly once and preserves every action schema', async () => {
  const { app } = await fixture();
  const mapped = MCP_TOOL_GROUPS.flatMap((group) => Object.values(group.actions));
  expect(mapped).toHaveLength(80);
  expect(new Set(mapped).size).toBe(80);
  expect([...mapped].sort()).toEqual(
    app.commands
      .tools()
      .map((command) => command.name)
      .sort(),
  );
  const catalog = new McpToolCatalog(app.commands, () => app.getSettings().agentLevel);
  const tools = catalog.list();
  for (const group of MCP_TOOL_GROUPS) {
    const tool = tools.find((tool) => tool.name === group.name)!;
    expect(tool.inputSchema.type).toBe('object');
    const branches = (tool.inputSchema as any).oneOf;
    expect(branches).toHaveLength(Object.keys(group.actions).length);
    for (const [action, commandName] of Object.entries(group.actions)) {
      const command = app.commands.tools().find((command) => command.name === commandName)!;
      const original = z.toJSONSchema(command.schema) as any;
      const branch = branches.find((branch: any) => branch.properties.action.const === action);
      expect(branch.properties).toEqual({
        ...original.properties,
        action: { type: 'string', const: action },
      });
      expect(branch.required).toEqual([...(original.required ?? []), 'action']);
      expect(branch.additionalProperties).toBe(false);
    }
  }
  // Exercise every public route independently of driver availability.
  const definitions = app.commands
    .tools()
    .map((command) => ({ ...command, schema: z.object({ marker: z.string() }) }));
  vi.spyOn(app.commands, 'tools').mockReturnValue(definitions);
  const dispatch = vi
    .spyOn(app.commands, 'dispatch')
    .mockResolvedValue({ success: true, data: {} });
  const actor = { kind: 'agent' as const, id: 'routing-agent', name: 'Routing Agent' };
  for (const group of MCP_TOOL_GROUPS) {
    for (const [action, name] of Object.entries(group.actions)) {
      expect(await catalog.call(group.name, { action, marker: name }, actor)).toMatchObject({
        success: true,
      });
      expect(dispatch).toHaveBeenLastCalledWith(name, { marker: name }, actor);
    }
  }
  dispatch.mockRestore();
  vi.restoreAllMocks();
});

it('filters individual actions in observe mode and rejects old names, unknown actions and cross-action fields', async () => {
  const { app, url, token } = await fixture();
  const client = new Client({ name: 'Observe Agent', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  cleanup.push(() => client.close());
  const dispatch = vi.spyOn(app.commands, 'dispatch');
  const invalidCalls = [
    { name: 'connection.save', arguments: {} },
    { name: 'query.read', arguments: {} },
    { name: 'query.manage', arguments: { action: 'approval.resolve' } },
    { name: 'connection.manage', arguments: { action: 'list', discard: true } },
    { name: 'app.inspect', arguments: {} },
  ];
  for (const call of invalidCalls) expect((await client.callTool(call)).isError).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  await app.commands.dispatch(
    'settings.save',
    { ...app.getSettings(), agentLevel: 'observe' },
    HUMAN,
  );
  dispatch.mockClear();
  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name)).not.toContain('app.open');
  expect(tools.map((tool) => tool.name)).not.toContain('redis.write');
  expect(tools.map((tool) => tool.name)).not.toContain('object.apply');
  const query = tools.find((tool) => tool.name === 'query.manage')!;
  expect(
    (query.inputSchema as any).oneOf.map((branch: any) => branch.properties.action.const),
  ).toEqual(['validate', 'read', 'next', 'cancel']);
  expect(
    (
      await client.callTool({
        name: 'query.manage',
        arguments: {
          action: 'execute',
          connectionId: 'unused',
          sql: 'SELECT 1',
        },
      })
    ).isError,
  ).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  expect(
    (await client.callTool({ name: 'app.inspect', arguments: { action: 'state' } })).isError,
  ).toBe(false);
  dispatch.mockRestore();
});

it('keeps write policy, scoped approvals, read-only access and audit on the original operation', async () => {
  const { app, url, token } = await fixture();
  const connection = await app.connections.save({
    name: 'Policy SQLite',
    engine: 'sqlite',
    database: ':memory:',
    agentAccess: 'write',
  });
  await app.commands.dispatch(
    'query.execute',
    { connectionId: connection.id, sql: 'CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)' },
    HUMAN,
  );
  const client = new Client({ name: 'Policy Agent', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  cleanup.push(() => client.close());
  const insert = async (name: string) =>
    client.callTool({
      name: 'data.manage',
      arguments: {
        action: 'insert',
        connectionId: connection.id,
        table: 'items',
        values: { name },
      },
    });
  const pending = await insert('first');
  const approvalId = (pending.structuredContent as any).approvalId;
  expect(approvalId).toBeTruthy();
  expect(app.permissions.list().find((approval) => approval.id === approvalId)?.command).toBe(
    'data.insert',
  );
  await app.commands.resolveApproval(approvalId, true, HUMAN, 'session');
  expect((await insert('second')).isError).toBe(false);
  const deletion = await client.callTool({
    name: 'data.manage',
    arguments: {
      action: 'delete',
      connectionId: connection.id,
      table: 'items',
      filters: [{ column: 'id', operator: '=', value: 1 }],
    },
  });
  expect(deletion.isError).toBe(true);
  expect((deletion.structuredContent as any).approvalId).toBeTruthy();
  const dropped = await client.callTool({
    name: 'query.manage',
    arguments: {
      action: 'execute',
      connectionId: connection.id,
      sql: 'DROP TABLE items',
    },
  });
  expect(dropped.isError).toBe(true); // destructive policy is deny, never bypassed
  await app.connections.save({ ...connection, agentAccess: 'read' });
  expect((await insert('blocked')).isError).toBe(true);
  const read = await client.callTool({
    name: 'data.manage',
    arguments: {
      action: 'select',
      connectionId: connection.id,
      table: 'items',
    },
  });
  expect(read.isError).toBe(false);
  expect(
    app.audit
      .list()
      .some((entry) => entry.actor.name === 'Policy Agent' && entry.command === 'data.insert'),
  ).toBe(true);
});
it('rejects unauthenticated requests, DNS rebinding and foreign origins', async () => {
  const { url, token } = await fixture();
  expect((await fetch(url)).status).toBe(401);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      url,
      { headers: { Authorization: `Bearer ${token}`, Host: 'attacker.example' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(hostStatus).toBe(403);
  expect(
    (
      await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://attacker.example' },
      })
    ).status,
  ).toBe(403);
  expect((await fetch(url, { headers: { Authorization: `Bearer wrong-token` } })).status).toBe(401);
});
it('requires explicit remote enablement, TLS and a concrete host allowlist', () => {
  expect(() => validateMcpConfig({ ...DEFAULT_SETTINGS.mcp, host: '0.0.0.0' })).toThrow(
    'Remote Access',
  );
  expect(() => validateMcpConfig({ ...DEFAULT_SETTINGS.mcp, remote: true })).toThrow('TLS');
  expect(() => validateMcpConfig({ ...DEFAULT_SETTINGS.mcp, allowedHosts: ['*'] })).toThrow(
    'allowlist',
  );
});

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'Limit test', version: '1' },
  },
});
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
});

it('bounds concurrent initialization, expires idle sessions and rejects stale tokens after rotation', async () => {
  const { gateway, url, token } = await fixture();
  const responses = await Promise.all(
    Array.from({ length: 40 }, () =>
      fetch(url, {
        method: 'POST',
        headers: headers(token),
        body: initializeBody,
      }),
    ),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(32);
  expect(responses.filter((response) => response.status === 503)).toHaveLength(8);
  expect(gateway.status().agents).toBe(32);
  const session = responses
    .find((response) => response.status === 200)!
    .headers.get('mcp-session-id')!;
  await Promise.all(responses.map((response) => response.arrayBuffer()));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
  try {
    expect(
      (await fetch(url, { headers: { ...headers(token), 'mcp-session-id': session } })).status,
    ).toBe(404);
    expect(gateway.status().agents).toBe(0);
  } finally {
    clock.mockRestore();
  }
  const rotated = await gateway.rotateToken();
  expect(rotated).not.toBe(token);
  await startHttpGateway(gateway);
  const next = new URL(
    `http://127.0.0.1:${(gateway.status().address as { port: number }).port}/mcp`,
  );
  expect((await fetch(next, { headers: headers(token) })).status).toBe(401);
  expect(
    (await fetch(next, { method: 'POST', headers: headers(rotated), body: initializeBody })).status,
  ).toBe(200);
});

it('enforces the request budget and recovers after its window expires', async () => {
  const { url } = await fixture();
  const responses = await Promise.all(Array.from({ length: 121 }, () => fetch(url)));
  expect(responses.filter((response) => response.status === 401)).toHaveLength(120);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  expect(responses.find((response) => response.status === 429)!.headers.get('retry-after')).toBe(
    '60',
  );
  await Promise.all(responses.map((response) => response.arrayBuffer()));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  try {
    expect((await fetch(url)).status).toBe(401);
  } finally {
    clock.mockRestore();
  }
});

it('serves authenticated MCP over verified TLS and refuses an HTTP origin', async () => {
  const { gateway, token } = await fixture();
  const tlsCert = resolve('tests/fixtures/localhost-test-cert.pem');
  await gateway.start({
    ...DEFAULT_SETTINGS.mcp,
    enabled: true,
    port: 0,
    remote: true,
    tlsCert,
    tlsKey: resolve('tests/fixtures/localhost-test-key.pem'),
  });
  const port = (gateway.status().address as { port: number }).port;
  const send = (origin: string) =>
    new Promise<{ status?: number; body: string }>((done, reject) => {
      const req = secureRequest(
        `https://127.0.0.1:${port}/mcp`,
        {
          method: 'POST',
          ca: readFileSync(tlsCert),
          headers: { ...headers(token), Origin: origin },
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => done({ status: response.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end(initializeBody);
    });
  const accepted = await send(`https://127.0.0.1:${port}`);
  expect(accepted.status).toBe(200);
  expect(JSON.parse(accepted.body).result.serverInfo.name).toBe('database-workspace');
  expect((await send(`http://127.0.0.1:${port}`)).status).toBe(403);
});

it('an unauthenticated flood does not use up the quota of the token holder', async () => {
  const { url, token } = await fixture();
  const flood = await Promise.all(Array.from({ length: 130 }, () => fetch(url)));
  await Promise.all(flood.map((response) => response.arrayBuffer()));
  expect(flood.filter((response) => response.status === 429).length).toBeGreaterThan(0);
  const legitimate = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  await legitimate.arrayBuffer();
  expect([401, 429]).not.toContain(legitimate.status);
});
