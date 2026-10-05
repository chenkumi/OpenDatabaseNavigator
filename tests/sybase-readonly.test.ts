import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aseLegacySql } from '../src/main/database/adapters/sybase/legacy-sql';
import { assertAseReadOnly } from '../src/main/security/ase-readonly';
import { analyzeSql } from '../src/main/security/sql-policy';
import { SybaseAdapter } from '../src/main/database/adapters/sybase/sybase-adapter';
import { CommandBus } from '../src/main/application/commands/command-bus';
import { PermissionService } from '../src/main/mcp/permissions/permission-service';
import { AuditService } from '../src/main/mcp/audit/audit-service';
import { EventBus } from '../src/main/application/events/event-bus';
import { MemoryStore } from '../src/main/application/services/store';
import { connectionSchema } from '../src/shared/schemas';
import { DEFAULT_SETTINGS, type Actor, type Risk } from '../src/shared/types';

const connection = {
  ...connectionSchema.parse({
    name: 'ASE',
    engine: 'sybase',
    host: 'localhost',
    agentAccess: 'write',
  }),
  id: 'ase',
};
const actors: Actor[] = [
  { kind: 'human', id: 'human', name: 'Human' },
  { kind: 'agent', id: 'agent', name: 'Agent' },
];
const blockedSql = [
  'SELECT CASE WHEN 1=1 THEN 1 ELSE 0 END',
  "SELECT REPLACE('a','a','b')",
  'SELECT 1 END',
  'INSERT INTO t VALUES(1)',
  'UPDATE t SET x=1',
  'DELETE FROM t',
  'DROP TABLE t',
  'SELECT * INTO other FROM t',
  'SELECT 1; DROP TABLE t',
  'SELECT 1 DROP TABLE t',
  'SELECT 1 SELECT 2',
  'SELECT 1 EXEC p',
  'SELECT 1 SET x=1',
  'EXEC p',
  'SELECT dbo.write_probe()',
  'SELECT dbo.write$probe()',
  'SELECT 寫入()',
  'SELECT [write_probe]()',
  'SELECT "write_probe"()',
  'SELECT arbitrary_function()',
  'SELECT dbo.COUNT(*)',
  'SELECT identity_burn_max(t)',
  'SELECT @x=1',
  'SELECT 1 /* unterminated',
  "SELECT 'unterminated",
  'SELECT 1 FOR UPDATE',
  'WITH x AS (DELETE FROM t) SELECT * FROM x',
  'SELECT 1; /* c */ EXEC p',
  'SELECT 1 /* outer /* nested */ end */ INTO t',
  "SELECT 1 WAITFOR DELAY '00:00:01'",
];
it.each(blockedSql)(
  'rejects %s before a driver is loaded, even with readOnly=true',
  async (sql) => {
    expect(() => assertAseReadOnly(sql)).toThrow();
    expect(analyzeSql(sql, 'sybase').risk).not.toBe('read');
    const load = vi.fn(async () => {
      throw new Error('Must not load');
    });
    const adapter = new SybaseAdapter(connection, undefined, load);
    await expect(
      adapter.query(sql, [], { limit: 10, timeout: 1000, readOnly: true }),
    ).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  },
);
it.each([
  'SELECT @@version AS version',
  'SELECT CONVERT(int, ?) AS value',
  "SELECT 'DROP TABLE t; EXEC p' AS value",
  'SELECT COUNT(*) FROM dbo.sysusers',
  'SELECT * FROM [dbo].[table] WHERE [column] = ?',
  'SELECT 1 UNION ALL SELECT 2',
  'SELECT * FROM t WHERE x IN (SELECT x FROM u)',
  'SELECT x FROM t WHERE (x & 8)=8',
])('accepts bounded read profile %s', (sql) => {
  expect(() => assertAseReadOnly(sql)).not.toThrow();
  expect(analyzeSql(sql, 'sybase').risk).toBe('read');
});

it('legacy identifiers cannot turn quoted names into executable effects', () => {
  expect(
    aseLegacySql("SELECT [uid] FROM [dbo].[sysusers] WHERE [name]='[unchanged]' /* [comment] */"),
  ).toBe("SELECT uid FROM dbo.sysusers WHERE name='[unchanged]' /* [comment] */");
  for (const name of ['a]]b', 'a;b', 'a b'])
    expect(() => aseLegacySql(`SELECT [${name}] FROM t`)).toThrow();
  const sql = 'SELECT 1 [INTO] t';
  expect(() => assertAseReadOnly(sql)).not.toThrow();
  expect(() => assertAseReadOnly(aseLegacySql(sql))).toThrow();
});

const commands: [string, Risk][] = [
  ['data.insert', 'insert'],
  ['data.update', 'update'],
  ['data.delete', 'delete'],
  ['database.create', 'ddl'],
  ['database.properties.apply', 'ddl'],
  ['object.create', 'ddl'],
  ['object.drop', 'destructive'],
  ['object.rename', 'ddl'],
  ['object.apply', 'ddl'],
  ['structure.apply', 'ddl'],
  ['query.execute', 'destructive'],
  ['script.execute', 'read'],
  ['export.start', 'read'],
];
function fixture() {
  const events = new EventBus();
  const settings = {
    ...DEFAULT_SETTINGS,
    agentLevel: 'execute' as const,
    policy: {
      insert: 'allow',
      update: 'allow',
      delete: 'allow',
      ddl: 'allow',
      destructive: 'allow',
    } as typeof DEFAULT_SETTINGS.policy,
  };
  const permissions = new PermissionService(() => settings, events);
  const audit = new AuditService(new MemoryStore([]), events);
  const bus = new CommandBus(permissions, audit, events, () => connection);
  return { bus, permissions, audit };
}
it.each(commands)('GUI and MCP cannot execute %s despite write permissions', async (name, risk) => {
  const { bus, permissions } = fixture();
  const execute = vi.fn();
  bus.register(name, {
    schema: z.object({ connectionId: z.string() }),
    risk,
    description: name,
    execute,
  });
  for (const actor of actors) {
    const result = await bus.dispatch(name, { connectionId: connection.id }, actor);
    expect(result.success).toBe(false);
    expect(result.approvalId).toBeUndefined();
  }
  expect(execute).not.toHaveBeenCalled();
  expect(permissions.list()).toHaveLength(0);
});
it('approval replay cannot override the engine restriction', async () => {
  const { bus, permissions } = fixture();
  const execute = vi.fn();
  bus.register('data.update', {
    schema: z.object({ connectionId: z.string() }),
    risk: 'update',
    description: '',
    execute,
  });
  const request = permissions.request(
    actors[1],
    'data.update',
    { connectionId: connection.id },
    'update',
  );
  expect((await bus.resolveApproval(request.id, true, actors[0], 'session')).success).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  expect(
    permissions.granted(actors[1], 'data.update', { connectionId: connection.id }, 'update'),
  ).toBeUndefined();
});
it('read and workspace operations remain available for GUI and MCP', async () => {
  const { bus } = fixture();
  for (const risk of ['read', 'workspace'] as const) {
    const execute = vi.fn(() => 'ok');
    bus.register(risk, {
      schema: z.object({ connectionId: z.string() }),
      risk,
      description: '',
      execute,
    });
    for (const actor of actors)
      expect((await bus.dispatch(risk, { connectionId: connection.id }, actor)).success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  }
});
