import { connectionIdentity } from './connection-service';
import { createHash } from 'node:crypto';
import type { Actor, Risk, Settings } from '../../../shared/types';
import type { ScriptProgress } from '../../../shared/sql-script';
import { splitSqlScript } from '../../database/sql-script-parser';
import { analyzeSql } from '../../security/sql-policy';
import type { ConnectionService } from './connection-service';
import type { EventBus } from '../events/event-bus';
import type { PermissionService } from '../../mcp/permissions/permission-service';
import type { AuditService } from '../../mcp/audit/audit-service';

export interface ScriptInput {
  connectionId: string;
  database: string;
  sql: string;
  fileName: string;
  mysqlSqlMode?: string;
}
export class SqlScriptService {
  private jobs = new Map<
    string,
    { actor: Actor; controller: AbortController; progress: ScriptProgress }
  >();
  constructor(
    private connections: ConnectionService,
    private events: EventBus,
    private permissions: PermissionService,
    private audit: AuditService,
    private settings: () => Settings,
  ) {
    events.subscribe((event) => {
      if (event.type === 'ConnectionChanged' && (event.payload as any)?.disconnecting)
        this.cancelConnection((event.payload as any).connectionId);
      if (event.type === 'McpStopped')
        for (const job of this.jobs.values())
          if (job.actor.kind === 'agent') job.controller.abort();
    });
  }
  auditArguments(input: ScriptInput) {
    const { sql, ...rest } = input;
    return {
      ...rest,
      bytes: Buffer.byteLength(sql),
      sha256: createHash('sha256').update(sql).digest('hex'),
    };
  }
  private units(input: ScriptInput) {
    const engine = this.connections.get(input.connectionId).engine;
    if (engine !== 'mysql' && input.mysqlSqlMode !== undefined)
      throw new Error('mysqlSqlMode is supported only for MySQL / MariaDB.');
    return splitSqlScript(
      input.sql,
      engine,
      input.mysqlSqlMode?.split(',').includes('NO_BACKSLASH_ESCAPES'),
      input.mysqlSqlMode?.split(',').includes('ANSI_QUOTES'),
    );
  }
  async risks(input: ScriptInput): Promise<Risk[]> {
    const engine = this.connections.get(input.connectionId).engine;
    const risks = new Set<Risk>(['destructive']);
    let index = 0;
    for (const unit of this.units(input)) {
      if (index++ % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const analysis = analyzeSql(unit.sql, engine);
      // A batch, procedure or unrecognized SQL can contain any class of write.
      if (analysis.risk === 'destructive')
        for (const r of ['insert', 'update', 'delete', 'ddl', 'destructive'] as const) risks.add(r);
      else risks.add(analysis.risk);
      if (['insert', 'update', 'delete', 'ddl', 'destructive'].every((r) => risks.has(r as Risk)))
        break;
    }
    return [...risks];
  }
  async preview(input: ScriptInput) {
    const engine = this.connections.get(input.connectionId).engine;
    if (engine === 'mysql' && input.mysqlSqlMode === undefined) {
      const adapter = await this.connections.connect(input.connectionId, input.database);
      const result = await adapter.query('SELECT @@SESSION.sql_mode AS mode', [], {
        limit: 1,
        timeout: 10000,
        readOnly: true,
      });
      input = { ...input, mysqlSqlMode: String(result.rows[0].mode) };
    }
    const units = this.units(input);
    return {
      total: units.length,
      mysqlSqlMode: input.mysqlSqlMode,
      units: units
        .slice(0, 200)
        .map((unit, index) => ({ index: index + 1, line: unit.line, sql: unit.sql.slice(0, 300) })),
    };
  }
  async start(input: ScriptInput & { id: string; continueOnError: boolean }, actor: Actor) {
    const config = connectionIdentity(this.connections.get(input.connectionId));
    const units = this.units(input),
      risks = await this.risks(input);
    if (config !== connectionIdentity(this.connections.get(input.connectionId)))
      throw new Error('Connection configuration changed. Preview the file again.');
    this.connections.assertAvailable(input.connectionId);
    if (
      this.connections.get(input.connectionId).engine === 'mysql' &&
      input.mysqlSqlMode === undefined
    )
      throw new Error('Preview the MySQL script first and provide its mysqlSqlMode.');
    if (this.jobs.has(input.id)) throw new Error('This script run ID has already been used.');
    if (
      [...this.jobs.values()].some(
        (j) => j.progress.state === 'running' && j.progress.connectionId === input.connectionId,
      )
    )
      throw new Error('A SQL file is already running on this connection.');
    if ([...this.jobs.values()].filter((j) => j.progress.state === 'running').length >= 4)
      throw new Error('At most four SQL files can run at once.');
    for (const risk of risks)
      this.permissions.evaluate(actor, this.connections.get(input.connectionId), risk);
    while (this.jobs.size >= 20) {
      const old = [...this.jobs].find(([, j]) => j.progress.state !== 'running');
      if (!old) break;
      this.jobs.delete(old[0]);
    }
    const controller = new AbortController();
    const progress: ScriptProgress = {
      id: input.id,
      connectionId: input.connectionId,
      database: input.database,
      fileName: input.fileName,
      state: 'running',
      total: units.length,
      completed: 0,
      failed: 0,
      results: [],
    };
    this.jobs.set(input.id, { actor, controller, progress });
    let lastEvent = 0;
    const emit = (force = false) => {
      if (force || Date.now() - lastEvent >= 100) {
        lastEvent = Date.now();
        this.events.emit('SqlScriptProgress', this.audit.sanitize(structuredClone(progress)));
      }
    };
    void (async () => {
      try {
        const adapter = await this.connections.connect(input.connectionId, input.database);
        if (!adapter.withScriptSession)
          throw new Error('SQL files are not supported for this engine.');
        const revision = this.permissions.revision;
        await adapter.withScriptSession(async (execute) => {
          if (this.connections.get(input.connectionId).engine === 'postgres')
            await execute(
              'SET standard_conforming_strings = on',
              controller.signal,
              this.settings().queryTimeout,
            );
          if (input.mysqlSqlMode !== undefined) {
            if (!/^[A-Z0-9_,]*$/.test(input.mysqlSqlMode))
              throw new Error('Invalid MySQL SQL mode.');
            await execute(
              `SET SESSION sql_mode = '${input.mysqlSqlMode}'`,
              controller.signal,
              this.settings().queryTimeout,
            );
          }
          for (let index = 0; index < units.length; index++) {
            if (controller.signal.aborted) throw new Error('Script cancelled.');
            this.connections.assertAvailable(input.connectionId);
            if (config !== connectionIdentity(this.connections.get(input.connectionId)))
              throw new Error('Connection configuration changed. Script stopped.');
            if (actor.kind === 'agent' && revision !== this.permissions.revision)
              throw new Error('Permissions changed. Start a new approved script run.');
            for (const risk of risks)
              this.permissions.evaluate(actor, this.connections.get(input.connectionId), risk);
            const unit = units[index],
              started = performance.now();
            progress.currentLine = unit.line;
            emit();
            let error: string | undefined;
            try {
              await execute(unit.sql, controller.signal, this.settings().queryTimeout);
            } catch (failure) {
              error = (failure as Error).message;
              progress.failed++;
            }
            progress.completed++;
            progress.results.push({
              index: index + 1,
              line: unit.line,
              success: !error,
              error,
              duration: performance.now() - started,
            });
            if (progress.results.length > 200) progress.results.shift();
            if (error && progress.failed <= 200)
              this.audit.record({
                actor,
                command: 'script.statement',
                connectionId: input.connectionId,
                database: input.database,
                summary: `${input.fileName}: batch ${index + 1}, line ${unit.line}`,
                sql: unit.sql.slice(0, 8192),
                status: 'error',
                duration: performance.now() - started,
                result: error,
              });
            emit();
            if (
              error &&
              (!input.continueOnError ||
                controller.signal.aborted ||
                /timed out|cancelled|session is closed|connection.*closed|socket/i.test(error))
            )
              throw new Error(error);
          }
        });
        progress.state = progress.failed ? 'failed' : 'completed';
      } catch (error) {
        progress.state = controller.signal.aborted ? 'cancelled' : 'failed';
        progress.error = (error as Error).message;
      } finally {
        this.audit.record({
          actor,
          command: 'script.finished',
          connectionId: input.connectionId,
          database: input.database,
          summary: JSON.stringify(this.auditArguments(input)),
          status: progress.state === 'completed' ? 'success' : 'error',
          duration: 0,
          result: JSON.stringify({
            state: progress.state,
            completed: progress.completed,
            total: progress.total,
            failed: progress.failed,
            error: progress.error,
          }),
        });
        emit(true);
        this.events.emit('SqlScriptFinished', {
          connectionId: input.connectionId,
          database: input.database,
          id: input.id,
        });
      }
    })();
    return structuredClone(progress);
  }
  status(id: string, actor: Actor) {
    const job = this.jobs.get(id);
    if (
      !job ||
      (actor.kind === 'agent' && (job.actor.kind !== actor.kind || job.actor.id !== actor.id))
    )
      throw new Error('Script run not found.');
    return structuredClone(job.progress);
  }
  cancel(id: string, actor: Actor) {
    this.status(id, actor);
    this.jobs.get(id)!.controller.abort();
    return { cancelled: true };
  }
  cancelConnection(id: string) {
    for (const job of this.jobs.values())
      if (job.progress.connectionId === id) job.controller.abort();
  }
  cancelAll() {
    for (const job of this.jobs.values()) job.controller.abort();
  }
}
