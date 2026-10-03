import { randomUUID } from 'node:crypto';
import type { Actor, QueryResult, Settings } from '../../../shared/types';
import { analyzeSql } from '../../security/sql-policy';
import { assertSingleStatement } from '../../security/single-statement';
import { ConnectionService, connectionIdentity } from './connection-service';
import { WorkspaceService } from './workspace-service';
import { EventBus } from '../events/event-bus';
import type { Store } from './store';
import { CursorStore } from './cursor-store';
interface QueryInput {
  connectionId: string;
  database?: string;
  sql: string;
  limit?: number;
  showInApp?: boolean;
  tabId?: string;
}
export interface HistoryEntry {
  id: string;
  sql: string;
  connectionId: string;
  database: string;
  executedAt: string;
  duration: number;
  success: boolean;
  error?: string;
}
export class QueryService {
  private cursors = new CursorStore<{ input: QueryInput; offset: number; connection: string }>();
  private resultSequence = 0;
  private latestResult = new Map<string, number>();
  private running = new Map<
    string,
    { controller: AbortController; actorId: string; connectionId: string }
  >();
  constructor(
    private connections: ConnectionService,
    private workspace: WorkspaceService,
    private settings: () => Settings,
    private history: Store<HistoryEntry[]>,
    private events: EventBus,
    private sanitize: <T>(value: T) => T = (value) => value,
  ) {
    // Every disconnect path (heartbeat failure, shutdown, connection edits) must
    // stop in-flight statements instead of waiting for the query timeout.
    events.subscribe((event) => {
      const payload = event.payload as { connectionId?: string; disconnecting?: boolean };
      if (event.type === 'ConnectionChanged' && payload?.disconnecting && payload.connectionId)
        this.cancelConnection(payload.connectionId);
    });
  }
  validate(connectionId: string, sql: string) {
    return analyzeSql(sql, this.connections.get(connectionId).engine);
  }
  async next(connectionId: string, cursor: string, actor: Actor) {
    const saved = this.cursors.take(
      cursor,
      { actorId: actor.id, connectionId, operation: 'query' },
      actor.kind === 'human',
    );
    if (saved.connection !== connectionIdentity(this.connections.get(connectionId)))
      throw new Error('Connection configuration changed; run the query again.');
    return this.execute(saved.input, actor, true, saved.offset);
  }
  async execute(
    input: QueryInput,
    actor: Actor,
    readOnly: boolean,
    offset = 0,
  ): Promise<QueryResult> {
    const connection = this.connections.get(input.connectionId);
    this.connections.assertAvailable(connection.id);
    assertSingleStatement(input.sql, connection.engine);
    if (readOnly && this.validate(connection.id, input.sql).risk !== 'read')
      throw new Error('query.read accepts only a single verified read-only SELECT.');
    const settings = this.settings();
    let resultTab: string | undefined;
    if (input.showInApp || input.tabId) {
      const target =
        input.tabId &&
        this.workspace.get().tabs.find(
          (tab) =>
            tab.id === input.tabId &&
            tab.type === 'query' &&
            tab.connectionId === connection.id &&
            tab.database === (input.database ?? connection.database) &&
            // An agent may refresh the tab that already shows this very query, but must not
            // overwrite the results of a query the user is working on.
            (actor.kind !== 'agent' || tab.sql === input.sql),
        );
      const tab =
        target ||
        this.workspace.open({
          type: 'query',
          title: actor.kind === 'agent' ? 'Agent Analysis' : 'Query',
          connectionId: connection.id,
          database: input.database ?? connection.database,
          sql: input.sql,
        });
      resultTab = tab.id;
    }
    // Queries on one tab can finish out of order; only the latest started may show.
    const sequence = ++this.resultSequence;
    if (resultTab) this.latestResult.set(resultTab, sequence);
    const id = randomUUID();
    const controller = new AbortController();
    const started = performance.now();
    this.running.set(id, { controller, actorId: actor.id, connectionId: connection.id });
    this.events.emit('QueryStarted', {
      id,
      actor,
      connectionId: connection.id,
      tabId: resultTab,
    });
    let error: string | undefined;
    try {
      const adapter = await this.connections.connect(connection.id, input.database);
      const result = await adapter.query(input.sql, [], {
        limit: Math.min(input.limit ?? settings.pageSize, settings.maxRows),
        offset,
        timeout: settings.queryTimeout,
        readOnly,
        truncate: readOnly || this.validate(connection.id, input.sql).risk === 'read',
        signal: controller.signal,
      });
      if (readOnly && result.hasMore)
        result.nextCursor = this.cursors.put(
          { actorId: actor.id, connectionId: connection.id, operation: 'query' },
          {
            input: { ...input, tabId: resultTab },
            offset: offset + result.rowCount,
            connection: connectionIdentity(connection),
          },
        );
      try {
        if (
          resultTab &&
          this.latestResult.get(resultTab) === sequence &&
          this.workspace.get().tabs.some((tab) => tab.id === resultTab)
        )
          this.workspace.update(resultTab, { result });
      } catch (error) {
        // The statement already ran; failing to show it must not report a failure.
        console.error('Result tab update failed:', (error as Error).message);
      }
      this.events.emit('QueryExecuted', {
        id,
        connectionId: connection.id,
        rowCount: result.rowCount,
      });
      return result;
    } catch (failure) {
      error = (failure as Error).message;
      throw failure;
    } finally {
      this.running.delete(id);
      try {
        this.history.write(
          this.sanitize(
            [
              ...this.history.read(),
              {
                id,
                sql: input.sql,
                connectionId: connection.id,
                database: input.database ?? connection.database,
                executedAt: new Date().toISOString(),
                duration: performance.now() - started,
                success: !error,
                error,
              },
            ].slice(-1000),
          ),
        );
      } catch (error) {
        console.error('History write failed:', (error as Error).message);
      }
      this.events.emit('QueryFinished', { id });
    }
  }
  cancel(id: string, actor: Actor) {
    const query = this.running.get(id);
    if (!query) throw new Error('Query is no longer running.');
    if (actor.kind === 'agent' && query.actorId !== actor.id)
      throw new Error('Cannot cancel another actor’s query.');
    query.controller.abort();
    return { cancelled: true };
  }
  cancelConnection(connectionId: string) {
    for (const query of this.running.values())
      if (query.connectionId === connectionId) query.controller.abort();
  }
  listHistory(search = '') {
    return this.history
      .read()
      .filter((item) => item.sql.toLowerCase().includes(search.toLowerCase()))
      .reverse();
  }
}
