import { expect, it } from 'vitest';
import { Application, HUMAN } from '../src/main/application/application';
import { SqliteAdapter } from '../src/main/database/adapters/sqlite/sqlite-adapter';
import { EventBus } from '../src/main/application/events/event-bus';
import { PermissionService } from '../src/main/mcp/permissions/permission-service';
import { AuditService } from '../src/main/mcp/audit/audit-service';
import { MemoryStore } from '../src/main/application/services/store';
import { WorkspaceService } from '../src/main/application/services/workspace-service';
import { ConnectionService } from '../src/main/application/services/connection-service';
import { redact } from '../src/main/security/redact';
import { DEFAULT_SETTINGS, type Actor } from '../src/shared/types';

const agent: Actor = { kind: 'agent', id: 'agent-1', name: 'Agent' };

it('identical pending approvals are merged and one actor cannot flood the queue', () => {
  const permissions = new PermissionService(() => DEFAULT_SETTINGS, new EventBus());
  const args = { connectionId: 'c', table: 't', values: { a: 1 } };
  const first = permissions.request(agent, 'data.insert', args, 'insert');
  expect(permissions.request(agent, 'data.insert', structuredClone(args), 'insert').id).toBe(
    first.id,
  );
  for (let i = 1; i < 20; i++)
    permissions.request(agent, 'data.insert', { ...args, values: { a: i + 1 } }, 'insert');
  expect(() =>
    permissions.request(agent, 'data.insert', { ...args, values: { a: 999 } }, 'insert'),
  ).toThrow('Too many approvals');
  // Another actor is unaffected.
  expect(() =>
    permissions.request({ ...agent, id: 'agent-2' }, 'data.insert', args, 'insert'),
  ).not.toThrow();
});

it('very short secrets no longer rewrite ordinary text, longer ones still do', () => {
  expect(redact('order 1 of 12 items', ['1'])).toBe('order 1 of 12 items');
  expect(redact('token hunter2x leaked', ['hunter2x'])).toBe('token [REDACTED] leaked');
});

it('audit secrets are loaded once and reloaded after a connection change', () => {
  const events = new EventBus();
  let loads = 0;
  let current = 'firstsecret';
  const audit = new AuditService(new MemoryStore([]), events, () => {
    loads++;
    return [current];
  });
  expect(audit.sanitize('x firstsecret y')).toBe('x [REDACTED] y');
  audit.sanitize('again');
  audit.sanitize('and again');
  expect(loads).toBe(1);
  current = 'secondsecret';
  events.emit('ConnectionChanged', { connectionId: 'c', permissionChanged: true });
  expect(audit.sanitize('a secondsecret b')).toBe('a [REDACTED] b');
  expect(loads).toBe(2);
});

it('the workspace refuses to open an unbounded number of tabs', () => {
  const workspace = new WorkspaceService(new MemoryStore({ tabs: [] }), new EventBus());
  for (let i = 0; i < 100; i++)
    workspace.open({ type: 'query', title: String(i), connectionId: 'c', sql: '' });
  expect(() =>
    workspace.open({ type: 'query', title: 'one more', connectionId: 'c', sql: '' }),
  ).toThrow('At most 100 tabs');
});

it('saving a connection keeps its place in the list', async () => {
  const connections = new ConnectionService(
    new MemoryStore([]),
    { get: () => undefined, set() {}, delete() {} },
    () => {
      throw new Error('unused');
    },
    new EventBus(),
  );
  const a = await connections.save({ name: 'a', engine: 'sqlite', database: ':memory:' });
  const b = await connections.save({ name: 'b', engine: 'sqlite', database: ':memory:' });
  const c = await connections.save({ name: 'c', engine: 'sqlite', database: ':memory:' });
  await connections.save({ ...a, name: 'a renamed' } as never);
  expect(connections.list().map((item) => item.name)).toEqual(['a renamed', 'b', 'c']);
  await connections.delete(b.id);
  expect(connections.list().map((item) => item.id)).toEqual([a.id, c.id]);
});

it('an equality filter on null becomes IS NULL instead of a condition that never matches', async () => {
  const { SqlBuilder } = await import('../src/main/database/sql-builder');
  const built = new SqlBuilder('postgres').delete({ table: 't', schema: 'public' } as never, [
    { column: 'a', operator: '=', value: null },
    { column: 'b', operator: '!=', value: null },
    { column: 'c', operator: '=', value: 0 },
  ]);
  expect(built.sql).toContain('"a" IS NULL AND "b" IS NOT NULL AND "c" = $1');
  expect(built.params).toEqual([0]);
});

it('the audit trail records the DDL that actually ran, not only the requested arguments', async () => {
  const app = new Application(
    {
      connections: new MemoryStore([]),
      workspace: new MemoryStore({ tabs: [] }),
      settings: new MemoryStore(DEFAULT_SETTINGS),
      history: new MemoryStore([]),
      audit: new MemoryStore([]),
    },
    { get: () => undefined, set() {}, delete() {} },
    (c) => new SqliteAdapter(c.database),
  );
  try {
    const connection = await app.connections.save({
      name: 'a',
      engine: 'sqlite',
      database: ':memory:',
    });
    await app.commands.dispatch(
      'query.execute',
      { connectionId: connection.id, sql: 'CREATE TABLE doomed (id integer)' },
      HUMAN,
    );
    const ref = {
      connectionId: connection.id,
      database: ':memory:',
      schema: 'main',
      objectName: 'doomed',
      table: '',
      kind: 'table',
    };
    const preview = await app.commands.dispatch('object.drop_preview', ref, HUMAN);
    expect(preview.success, preview.error).toBe(true);
    const dropped = await app.commands.dispatch(
      'object.drop',
      { ...ref, version: (preview.data as { version: string }).version },
      HUMAN,
    );
    expect(dropped.success, dropped.error).toBe(true);
    const entry = app.audit.list().find((item) => item.command === 'object.drop');
    expect(entry?.sql).toContain('DROP TABLE');
    expect(entry?.sql).toContain('doomed');
  } finally {
    await app.connections.shutdown();
  }
});

it('Redis updates are granted per key, Redis deletes per exact member', () => {
  const permissions = new PermissionService(() => DEFAULT_SETTINGS, new EventBus());
  const set = { connectionId: 'c', database: '0', key: 'k', value: 'one' };
  permissions.grant(permissions.request(agent, 'redis.set', set, 'update'));
  expect(permissions.granted(agent, 'redis.set', { ...set, value: 'two' }, 'update')).toBeTruthy();
  expect(
    permissions.granted(agent, 'redis.set', { ...set, key: 'other' }, 'update'),
  ).toBeUndefined();
  const del = { connectionId: 'c', database: '0', key: 'k', member: 'a' };
  permissions.grant(permissions.request(agent, 'redis.srem', del, 'delete'));
  expect(permissions.granted(agent, 'redis.srem', { ...del }, 'delete')).toBeTruthy();
  expect(
    permissions.granted(agent, 'redis.srem', { ...del, member: 'b' }, 'delete'),
  ).toBeUndefined();
});
