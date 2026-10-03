import { expect, it } from 'vitest';
import { redact } from '../src/main/security/redact';
import { PermissionService } from '../src/main/mcp/permissions/permission-service';
import { EventBus } from '../src/main/application/events/event-bus';
import { ConnectionService } from '../src/main/application/services/connection-service';
import { MemoryStore } from '../src/main/application/services/store';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';
import { DEFAULT_SETTINGS, type Actor } from '../src/shared/types';

const BS = String.fromCharCode(92);
it('redact stays linear on long unterminated or scheme-like input', () => {
  for (const text of [
    'a'.repeat(200_000),
    `PASSWORD '${BS.repeat(5_000)}`,
    `IDENTIFIED BY "${BS.repeat(5_000)}`,
    'a://u:'.repeat(20_000),
  ]) {
    const started = performance.now();
    redact(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  }
  expect(redact('postgres://user:secret@host/db')).toBe('postgres://user:[REDACTED]@host/db');
  expect(redact(`IDENTIFIED BY 'p${BS}'w'`)).toBe('IDENTIFIED BY [REDACTED]');
});

it('session grants for delete/update bind the complete arguments, inserts stay table-scoped', () => {
  const permissions = new PermissionService(() => DEFAULT_SETTINGS, new EventBus());
  const actor: Actor = { kind: 'agent', id: 'agent-1' } as Actor;
  const args = {
    connectionId: 'c',
    table: 't',
    filters: [{ column: 'id', operator: '=', value: 1 }],
  };
  const request = permissions.request(actor, 'data.delete', args, 'delete');
  permissions.grant(request);
  expect(permissions.granted(actor, 'data.delete', structuredClone(args), 'delete')).toBe(
    request.id,
  );
  const wider = { ...args, filters: [{ column: 'id', operator: '>', value: 0 }] };
  expect(permissions.granted(actor, 'data.delete', wider, 'delete')).toBeUndefined();
  const insert = { connectionId: 'c', table: 't', values: { name: 'a' } };
  permissions.grant(permissions.request(actor, 'data.insert', insert, 'insert'));
  expect(
    permissions.granted(actor, 'data.insert', { ...insert, values: { name: 'b' } }, 'insert'),
  ).toBeTruthy();
});

it('a synchronous factory failure does not leave the scope stuck in connecting', async () => {
  let fail = true;
  const events = new EventBus();
  const connections = new ConnectionService(
    new MemoryStore([]),
    { get: () => undefined, set() {}, delete() {} },
    (c) => {
      if (fail) throw new Error('keychain unavailable');
      return new SqliteAdapter(c.database);
    },
    events,
  );
  const saved = await connections.save({ name: 'a', engine: 'sqlite', database: ':memory:' });
  await expect(connections.connect(saved.id, undefined, true)).rejects.toThrow('keychain');
  expect(connections.status(saved.id).connecting).toBe(false);
  fail = false;
  await connections.connect(saved.id, undefined, true);
  expect(connections.status(saved.id).connected).toBe(true);
  await connections.disconnect(saved.id);
});

it('workspace reset drops every tab, dirty or not, and persists the empty state', async () => {
  const { WorkspaceService } = await import('../src/main/application/services/workspace-service');
  const store = new MemoryStore<any>({ tabs: [] });
  const workspace = new WorkspaceService(store, new EventBus());
  const tab = workspace.open({ type: 'query', title: 'q', connectionId: 'c', sql: 'SELECT 1' });
  workspace.update(tab.id, { dirty: true });
  workspace.reset();
  expect(workspace.get()).toMatchObject({ tabs: [] });
  expect(workspace.get().activeTab).toBeUndefined();
  expect(store.read().tabs).toEqual([]);
  expect(new WorkspaceService(store, new EventBus()).get().tabs).toEqual([]);
});

it('connection status events keep grants; only target or access edits revoke that connection', () => {
  const events = new EventBus();
  const permissions = new PermissionService(() => DEFAULT_SETTINGS, events);
  const actor: Actor = { kind: 'agent', id: 'agent-1' } as Actor;
  const grantFor = (connectionId: string) => {
    const args = { connectionId, table: 't', values: { a: 1 } };
    permissions.grant(permissions.request(actor, 'data.insert', args, 'insert'));
    return args;
  };
  const a = grantFor('a');
  const b = grantFor('b');
  const revision = permissions.revision;
  events.emit('ConnectionChanged', { connectionId: 'a', connected: false });
  events.emit('ConnectionChanged', { connectionId: 'a', permissionChanged: false });
  expect(permissions.revision).toBe(revision);
  expect(permissions.granted(actor, 'data.insert', a, 'insert')).toBeTruthy();
  events.emit('ConnectionChanged', { connectionId: 'a', permissionChanged: true });
  expect(permissions.revision).toBe(revision + 1);
  expect(permissions.granted(actor, 'data.insert', a, 'insert')).toBeUndefined();
  expect(permissions.granted(actor, 'data.insert', b, 'insert')).toBeTruthy();
});

it('audit entries are bounded and redact short secret-like keys', async () => {
  const { AuditService } = await import('../src/main/mcp/audit/audit-service');
  const store = new MemoryStore<any[]>([]);
  const audit = new AuditService(store, new EventBus());
  const entry = audit.record({
    actor: { kind: 'human', id: 'u' } as Actor,
    command: 'query.execute',
    summary: 'x'.repeat(100_000),
    sql: 'y'.repeat(500_000),
    status: 'success',
    duration: 1,
  });
  expect(entry.summary.length).toBeLessThan(9_000);
  expect(entry.sql!.length).toBeLessThan(33_000);
  expect(entry.sql).toContain('truncated');
  expect(audit.sanitize({ api_key: 'k', pwd: 'p', passenger: 'ok' })).toEqual({
    api_key: '[REDACTED]',
    pwd: '[REDACTED]',
    passenger: 'ok',
  });
});

it('a failing audit or history write never turns a completed operation into a failure', async () => {
  const { Application, HUMAN } = await import('../src/main/application/application');
  class BrokenStore<T> extends MemoryStore<T> {
    override write(): void {
      throw new Error('disk full');
    }
  }
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(DEFAULT_SETTINGS),
      history: new BrokenStore([]),
      audit: new BrokenStore([]),
    },
    { get: () => undefined, set() {}, delete() {} },
    (c) => new SqliteAdapter(c.database),
  );
  const log = console.error;
  console.error = () => {};
  try {
    const connection = await app.connections.save({
      name: 'a',
      engine: 'sqlite',
      database: ':memory:',
    });
    const listed = await app.commands.dispatch('connection.list', {}, HUMAN);
    expect(listed.success).toBe(true);
    const result = await app.commands.dispatch(
      'query.execute',
      { connectionId: connection.id, sql: 'SELECT 1 AS one' },
      HUMAN,
    );
    expect(result.success, result.error).toBe(true);
    expect((result.data as { rows: unknown[] }).rows).toEqual([{ one: '1' }]);
  } finally {
    console.error = log;
    await app.connections.shutdown();
  }
});
