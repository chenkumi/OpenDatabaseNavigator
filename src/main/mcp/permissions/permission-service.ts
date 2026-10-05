import { randomUUID } from 'node:crypto';
import { assertEngineRisk } from '../../../shared/engine-capabilities';
import type { Actor, Approval, Connection, Risk, Settings } from '../../../shared/types';
import { EventBus } from '../../application/events/event-bus';
const MAX_PENDING_PER_ACTOR = 20;
export class PermissionService {
  private pending = new Map<string, Approval>();
  private grants = new Map<
    string,
    { approvalId: string; connectionId?: string; expiresAt: number }
  >();
  private epoch = 0;
  get revision() {
    return this.epoch;
  }
  constructor(
    private settings: () => Settings,
    private events: EventBus,
  ) {
    events.subscribe((event) => {
      if (event.type === 'ConnectionChanged') {
        // Connect/disconnect status changes do not alter what was approved.
        // Only edits to a connection's target or agent access revoke its grants.
        const payload = event.payload as { connectionId?: string; permissionChanged?: boolean };
        if (payload?.permissionChanged !== true) return;
        for (const [key, grant] of this.grants)
          if (!payload.connectionId || grant.connectionId === payload.connectionId)
            this.grants.delete(key);
        this.epoch++;
        return;
      }
      if (['SettingsChanged', 'McpStopped'].includes(event.type)) {
        this.grants.clear();
        this.epoch++;
      }
      if (event.type === 'McpStopped')
        // The agent sessions that asked are gone; a late approval would run work
        // nobody is waiting for (for example after revoking a suspicious token).
        for (const item of this.pending.values())
          if (item.status === 'pending') {
            item.status = 'expired';
            events.emit('ApprovalResolved', { id: item.id, status: item.status });
          }
    });
  }
  private scope(actor: Actor, command: string, args: Record<string, unknown>, risk: Risk) {
    // SQL text is itself the target; generic data/Redis commands bind to a
    // concrete database/table/key. Never infer a target by parsing arbitrary SQL.
    // Inserts are scoped to the table (new rows are the approved intent), and Redis
    // writes other than deletes to the key (changing the value is the intent). Every
    // other risk (update, delete, DDL, ...) binds the complete validated arguments,
    // so a different filter, member or payload on the same target asks again.
    const keyScoped = risk === 'insert' || (command.startsWith('redis.') && risk !== 'delete');
    return JSON.stringify([
      actor.id,
      command,
      risk,
      args.connectionId,
      args.database,
      args.schema,
      args.table,
      args.key,
      args.sql,
      args.change,
      keyScoped ? undefined : args,
    ]);
  }
  grant(request: Approval) {
    if (request.risk === 'destructive')
      throw new Error('Destructive actions require approval every time.');
    if (!request.connectionId) throw new Error('A connection is required for a temporary grant.');
    this.expire();
    if (this.grants.size >= 500) this.grants.delete(this.grants.keys().next().value!);
    this.grants.set(this.scope(request.actor, request.command, request.args, request.risk), {
      approvalId: request.id,
      connectionId: request.connectionId,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  }
  granted(actor: Actor, command: string, args: Record<string, unknown>, risk: Risk) {
    this.expire();
    if (risk === 'destructive') return undefined;
    return this.grants.get(this.scope(actor, command, args, risk))?.approvalId;
  }
  evaluate(actor: Actor, connection: Connection | undefined, risk: Risk): 'allow' | 'ask' {
    assertEngineRisk(connection?.engine, risk);
    if (actor.kind === 'human') return 'allow';
    const settings = this.settings();
    if (connection?.agentAccess === 'disabled')
      throw new Error('Agent access is disabled for this connection.');
    if (risk === 'read') return 'allow';
    if (settings.agentLevel === 'observe')
      throw new Error('Observe permission does not allow this action.');
    if (risk === 'workspace') return 'allow';
    if (connection?.agentAccess !== 'write')
      throw new Error('This connection does not permit agent writes.');
    if (settings.policy[risk] === 'deny') throw new Error(`Policy denies ${risk} operations.`);
    if (
      risk === 'destructive' ||
      settings.agentLevel === 'assist' ||
      settings.policy[risk] === 'ask'
    )
      return 'ask';
    return 'allow';
  }
  request(actor: Actor, command: string, args: Record<string, unknown>, risk: Risk) {
    this.expire();
    // A retrying agent must not stack identical prompts, and one actor must not be
    // able to bury the user's queue until a real request is approved by fatigue.
    const identity = JSON.stringify([actor.id, command, args]);
    const pendingOfActor = [...this.pending.values()].filter(
      (item) => item.status === 'pending' && item.actor.id === actor.id,
    );
    const same = pendingOfActor.find(
      (item) => JSON.stringify([item.actor.id, item.command, item.args]) === identity,
    );
    if (same) return structuredClone(same);
    if (pendingOfActor.length >= MAX_PENDING_PER_ACTOR)
      throw new Error(
        'Too many approvals are waiting. Ask the desktop user to resolve them first.',
      );
    const approval: Approval = {
      id: randomUUID(),
      actor: structuredClone(actor),
      command,
      connectionId: typeof args.connectionId === 'string' ? args.connectionId : undefined,
      args: structuredClone(args),
      risk,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      status: 'pending',
    };
    this.pending.set(approval.id, approval);
    this.events.emit('ApprovalRequested', approval);
    return structuredClone(approval);
  }
  list() {
    this.expire();
    return [...this.pending.values()].map((value) => structuredClone(value));
  }
  consume(id: string, approve: boolean, mode: 'once' | 'session' = 'once'): Approval {
    this.expire();
    const item = this.pending.get(id);
    if (!item || item.status !== 'pending') throw new Error('Approval is no longer pending.');
    if (approve && mode === 'session' && item.risk === 'destructive')
      throw new Error('Destructive actions require approval every time.');
    item.status = approve ? 'approved' : 'rejected';
    this.events.emit('ApprovalResolved', { id, status: item.status });
    return structuredClone(item);
  }
  private expire() {
    for (const [key, grant] of this.grants)
      if (grant.expiresAt <= Date.now()) this.grants.delete(key);
    for (const item of this.pending.values())
      if (item.status === 'pending' && Date.parse(item.expiresAt) <= Date.now()) {
        item.status = 'expired';
        this.events.emit('ApprovalResolved', { id: item.id, status: item.status });
      }
    if (this.pending.size > 500)
      for (const [id, item] of this.pending) if (item.status !== 'pending') this.pending.delete(id);
  }
}
