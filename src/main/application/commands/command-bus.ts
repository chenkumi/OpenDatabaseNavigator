import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Actor, CommandResult, Connection, Risk } from '../../../shared/types';
import { PermissionService } from '../../mcp/permissions/permission-service';
import { AuditService } from '../../mcp/audit/audit-service';
import { EventBus } from '../events/event-bus';
import { executedSql } from '../executed-sql';
export interface CommandDefinition {
  schema: z.ZodType<any>;
  humanOnly?: boolean;
  description: string;
  risk: Risk | ((args: any) => Risk);
  additionalRisks?: (args: any) => Risk[] | Promise<Risk[]>;
  auditArguments?: (args: any) => Record<string, unknown>;
  execute: (args: any, actor: Actor) => Promise<unknown> | unknown;
}
export class CommandBus {
  private definitions = new Map<string, CommandDefinition>();
  constructor(
    private permissions: PermissionService,
    private audit: AuditService,
    private events: EventBus,
    private connection: (id: string) => Connection,
  ) {}
  register(name: string, definition: CommandDefinition) {
    if (this.definitions.has(name)) throw new Error(`Duplicate command: ${name}`);
    this.definitions.set(name, definition);
  }
  tools() {
    return [...this.definitions.entries()]
      .filter(([, definition]) => !definition.humanOnly)
      .map(([name, definition]) => ({ name, ...definition }));
  }
  async dispatch(name: string, raw: unknown, actor: Actor): Promise<CommandResult> {
    return this.run(name, raw, actor);
  }
  async resolveApproval(
    id: string,
    approve: boolean,
    actor: Actor,
    mode: 'once' | 'session' = 'once',
  ): Promise<CommandResult> {
    if (actor.kind !== 'human')
      return { success: false, error: 'Only the desktop user can resolve approvals.' };
    let request;
    try {
      request = this.permissions.consume(id, approve, mode);
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
    if (!approve) {
      this.record({
        actor: request.actor,
        command: request.command,
        connectionId: request.connectionId,
        summary: 'Rejected by desktop user',
        status: 'denied',
        duration: 0,
        approvalId: id,
      });
      return { success: true, data: { rejected: true } };
    }
    // Revalidate current policy and connection access; an approval never grants
    // broader access and cannot be replayed or applied to different arguments (session grants bind the full arguments).
    const revision = this.permissions.revision;
    const result = await this.run(request.command, request.args, request.actor, id);
    if (result.success && mode === 'session' && revision === this.permissions.revision)
      this.permissions.grant(request);
    return result;
  }
  private async run(
    name: string,
    raw: unknown,
    actor: Actor,
    approvalId?: string,
  ): Promise<CommandResult> {
    const started = performance.now();
    let args: Record<string, any> = {};
    let connection: Connection | undefined;
    let auditArgs: Record<string, any> = {};
    let executed: string[] = [];
    try {
      const definition = this.definitions.get(name);
      if (!definition) throw new Error('Unknown command.');
      if (definition.humanOnly && actor.kind !== 'human')
        throw new Error('This command is available only to the desktop user.');
      args = definition.schema.parse(raw);
      auditArgs = definition.auditArguments?.(args) ?? args;
      connection =
        typeof args.connectionId === 'string' ? this.connection(args.connectionId) : undefined;
      const risk = typeof definition.risk === 'function' ? definition.risk(args) : definition.risk;
      const decision = this.permissions.evaluate(actor, connection, risk);
      const additionalRisks = definition.additionalRisks
        ? await definition.additionalRisks(args)
        : [];
      for (const extra of additionalRisks) {
        const extraDecision = this.permissions.evaluate(actor, connection, extra);
        if (extraDecision === 'ask' && decision === 'allow')
          throw new Error('This compound operation requires an approval-capable primary risk.');
      }
      if (decision === 'ask' && !approvalId)
        approvalId = this.permissions.granted(actor, name, args, risk);
      if (decision === 'ask' && !approvalId) {
        const request = this.permissions.request(actor, name, args, risk);
        this.record({
          actor,
          command: name,
          connectionId: connection?.id,
          database: args.database ?? connection?.database,
          summary: JSON.stringify(this.audit.sanitize(auditArgs)),
          sql: auditArgs.sql,
          status: 'pending',
          duration: performance.now() - started,
          approvalId: request.id,
        });
        return {
          success: false,
          approvalId: request.id,
          error: 'Waiting for desktop user approval.',
        };
      }
      this.events.emit('CommandStarted', { command: name, actor, connectionId: connection?.id });
      executed = [];
      const data = await executedSql.run(executed, () => definition.execute(args, actor));
      if (name !== 'audit.list')
        this.record({
          actor,
          command: name,
          connectionId: connection?.id,
          database: args.database ?? connection?.database,
          summary: JSON.stringify(this.audit.sanitize(auditArgs)),
          sql: auditArgs.sql ?? this.executedText(executed),
          status: 'success',
          duration: performance.now() - started,
          result: this.resultSummary(data),
          approvalId,
        });
      return { success: true, data: actor.kind === 'agent' ? this.audit.sanitize(data) : data };
    } catch (error) {
      // Driver errors can contain credentials or connection strings. The audit
      // sanitizer redacts known secrets, and agent-facing failures are generic.
      const message =
        error instanceof z.ZodError
          ? error.issues
              .map((issue) => `${issue.path.join('.') || 'Input'}: ${issue.message}`)
              .join('\n')
          : error instanceof Error
            ? error.message
            : 'Command failed.';
      this.record({
        actor,
        command: name,
        connectionId: connection?.id,
        database: args.database ?? connection?.database,
        summary: JSON.stringify(this.audit.sanitize(auditArgs)),
        sql: auditArgs.sql ?? this.executedText(executed),
        status: 'error',
        duration: performance.now() - started,
        result: message,
        approvalId,
      });
      return {
        success: false,
        error:
          actor.kind === 'agent'
            ? 'Command rejected or failed. Review the desktop activity log.'
            : message,
      };
    } finally {
      this.events.emit('CommandFinished', { command: name, actor });
    }
  }
  /**
   * Audit is bookkeeping. If it cannot be written (disk full, antivirus lock,
   * damaged file) the operation it describes has already happened, so the
   * caller must still receive the real outcome rather than a false failure.
   */
  private record(entry: Parameters<AuditService['record']>[0]) {
    try {
      this.audit.record(entry);
    } catch (error) {
      console.error('Audit write failed:', (error as Error).message);
    }
  }
  private executedText(statements: string[]) {
    return statements.length ? statements.join(';\n') : undefined;
  }
  private resultSummary(data: unknown) {
    if (data && typeof data === 'object' && 'rowCount' in data)
      return `${data.rowCount} rows; ${'affectedRows' in data ? data.affectedRows : 0} affected`;
    return 'Completed';
  }
}
