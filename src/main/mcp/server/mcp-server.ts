import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { McpToolCatalog } from './tool-catalog';
import type { Application } from '../../application/application';
import type { Actor, Settings } from '../../../shared/types';
import type { Credentials } from '../../credentials/credential-service';
interface Session {
  server: Server;
  transport: StreamableHTTPServerTransport;
  touched: number;
}
export class McpGateway {
  private http?: HttpServer;
  private sessions = new Map<string, Session>();
  private initializing = 0;
  private generation = 0;
  private requests = new Map<string, { count: number; reset: number }>();
  private sweeper?: ReturnType<typeof setInterval>;
  constructor(
    private application: Application,
    private credentials: Credentials,
  ) {}
  status() {
    return {
      running: !!this.http?.listening,
      agents: this.sessions.size,
      address: this.http?.address(),
    };
  }
  token() {
    let token = this.credentials.get('__mcp_token');
    if (!token) {
      token = 'mcp_' + randomBytes(32).toString('base64url');
      this.credentials.set('__mcp_token', token);
    }
    return token;
  }
  async rotateToken() {
    await this.stop();
    this.credentials.delete('__mcp_token');
    return this.token();
  }
  async start(config: Settings['mcp']) {
    await this.stop();
    if (!config.enabled) return;
    validateMcpConfig(config);
    const token = this.token();
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      void this.handle(request, response, config, token).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    };
    const server = config.remote
      ? createHttpsServer(
          {
            cert: readFileSync(config.tlsCert),
            key: readFileSync(config.tlsKey),
            minVersion: 'TLSv1.2',
          },
          handler,
        )
      : createServer(handler);
    server.requestTimeout = 35000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 50;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.http = server;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      this.expireSessions(now);
      for (const [ip, entry] of this.requests) if (entry.reset <= now) this.requests.delete(ip);
    }, 60000);
    this.sweeper.unref();
    this.changed();
  }
  async stop() {
    this.generation++;
    this.application.events.emit('McpStopped');
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((session) => session.server.close()));
    this.sessions.clear();
    const http = this.http;
    this.http = undefined;
    if (http)
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      });
    this.requests.clear();
    this.changed();
  }
  private changed() {
    this.application.events.emit('McpStatusChanged', this.status());
  }
  private expireSessions(now: number) {
    for (const [id, session] of this.sessions)
      if (now - session.touched > 30 * 60 * 1000) {
        this.sessions.delete(id);
        void session.server.close();
        this.changed();
      }
  }
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    config: Settings['mcp'],
    token: string,
  ) {
    const generation = this.generation;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = (status: number, message: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    };
    const host = req.headers.host;
    let hostname: string;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      fail(403, 'Invalid host');
      return;
    }
    if (!host || !config.allowedHosts.includes(hostname)) {
      fail(403, 'Host is not allowed');
      return;
    }
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (
          !config.allowedHosts.includes(origin.hostname) ||
          origin.host !== host ||
          origin.protocol !== (config.remote ? 'https:' : 'http:')
        )
          throw new Error();
      } catch {
        fail(403, 'Origin is not allowed');
        return;
      }
    }
    if (req.url !== '/mcp') {
      fail(404, 'Not found');
      return;
    }
    const provided = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    const authenticated =
      provided.length === expected.length && timingSafeEqual(provided, expected);
    // Budgets are kept apart: any local process can send unauthenticated requests,
    // and those must not use up the quota of the agent holding the real token.
    const ip = `${authenticated ? 'ok' : 'bad'}:${req.socket.remoteAddress ?? 'unknown'}`;
    const now = Date.now();
    let budget = this.requests.get(ip);
    if (!budget || budget.reset <= now) {
      budget = { count: 0, reset: now + 60000 };
      this.requests.set(ip, budget);
    }
    if (++budget.count > 120 || this.requests.size > 10000) {
      res.setHeader('Retry-After', '60');
      fail(429, 'Rate limit exceeded');
      return;
    }
    if (!authenticated) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="Database Workspace"');
      fail(401, 'Authentication required');
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (Array.isArray(sessionId)) {
      fail(400, 'Invalid session');
      return;
    }
    this.expireSessions(now);
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      fail(404, 'Unknown session');
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) {
        fail(415, 'Expected JSON');
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          fail(413, 'Request too large');
          return;
        }
        chunks.push(chunk);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        fail(400, 'Invalid JSON');
        return;
      }
    }
    if (!session) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        fail(400, 'Initialize a session first');
        return;
      }
      if (this.sessions.size + this.initializing >= 32) {
        fail(503, 'Session limit reached');
        return;
      }
      this.initializing++;
      const server = this.createProtocolServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          this.sessions.set(id, { server, transport, touched: Date.now() });
          this.changed();
        },
      });
      try {
        await server.connect(transport);
        if (generation !== this.generation) {
          fail(503, 'Server is restarting');
          return;
        }
        const originalClose = transport.onclose;
        transport.onclose = () => {
          originalClose?.();
          if (transport.sessionId) this.sessions.delete(transport.sessionId);
          this.changed();
        };
        await transport.handleRequest(req, res, body);
        return;
      } finally {
        this.initializing--;
        if (!transport.sessionId || generation !== this.generation) await server.close();
      }
    }
    session.touched = now;
    await session.transport.handleRequest(req, res, body);
  }
  private createProtocolServer() {
    const server = new Server(
      { name: 'database-workspace', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true }, resources: {} } },
    );
    const actor: Actor = { kind: 'agent', id: randomUUID(), name: 'MCP Agent' };
    server.oninitialized = () => {
      actor.name = server.getClientVersion()?.name.slice(0, 100) || 'MCP Agent';
    };
    const catalog = new McpToolCatalog(
      this.application.commands,
      () => this.application.getSettings().agentLevel,
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.list() }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await catalog.call(request.params.name, request.params.arguments ?? {}, actor);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { ...result },
        isError: !result.success,
      };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        { uri: 'app://workspace', name: 'Shared workspace', mimeType: 'application/json' },
        { uri: 'app://connections', name: 'Available connections', mimeType: 'application/json' },
      ],
    }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [
        {
          uriTemplate: 'db://connection/{connectionId}/schema',
          name: 'Database schema',
          mimeType: 'application/json',
        },
        {
          uriTemplate: 'db://connection/{connectionId}/table/{schema}/{table}',
          name: 'Table structure',
          mimeType: 'application/json',
        },
      ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      let result;
      if (uri === 'app://workspace')
        result = await this.application.commands.dispatch('app.get_state', {}, actor);
      else if (uri === 'app://connections')
        result = await this.application.commands.dispatch('connection.list', {}, actor);
      else {
        const match = /^db:\/\/connection\/([^/]+)\/(?:schema|table\/([^/]+)\/([^/]+))$/.exec(uri);
        if (!match) throw new Error('Unknown resource URI.');
        const connectionId = decodeURIComponent(match[1]);
        if (match[2]) {
          const schema = decodeURIComponent(match[2]);
          const table = decodeURIComponent(match[3]);
          result = await this.application.commands.dispatch(
            'table.describe',
            { connectionId, schema, table },
            actor,
          );
          if (result.success)
            result = { success: true, data: { connectionId, schema, table, columns: result.data } };
        } else {
          const schemas = await this.application.commands.dispatch(
            'schema.list',
            { connectionId },
            actor,
          );
          if (!schemas.success) throw new Error(schemas.error);
          const names = schemas.data as string[];
          if (names.length > 100)
            throw new Error(
              'Schema resource is too large; use schema.list and table.list for individual schemas.',
            );
          const structure = [];
          for (const schema of names) {
            const tables = await this.application.commands.dispatch(
              'table.list',
              { connectionId, schema },
              actor,
            );
            if (!tables.success) throw new Error(tables.error);
            structure.push({ name: schema, tables: tables.data });
          }
          result = { success: true, data: { connectionId, schemas: structure } };
        }
      }
      if (!result.success) throw new Error(result.error);
      const text = JSON.stringify(result.data);
      if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024)
        throw new Error('Resource exceeds 8 MiB; use scoped tools to retrieve smaller results.');
      return { contents: [{ uri, mimeType: 'application/json', text }] };
    });
    return server;
  }
}
export function validateMcpConfig(config: Settings['mcp']) {
  if (!config.remote && !['127.0.0.1', '::1', 'localhost'].includes(config.host))
    throw new Error('Enable Remote Access before binding a network interface.');
  if (config.remote && (!config.tlsCert || !config.tlsKey))
    throw new Error('Remote Access requires a TLS certificate and private key.');
  if (!config.allowedHosts.length || config.allowedHosts.includes('*'))
    throw new Error('An explicit host allowlist is required.');
}
