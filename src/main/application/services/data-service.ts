import type { Filter, SelectInput, Settings, TableRef } from '../../../shared/types';
import { SqlBuilder } from '../../database/sql-builder';
import { aseReadSelect } from '../../database/adapters/sybase/read-select';
import { ConnectionService } from './connection-service';
import { EventBus } from '../events/event-bus';
export class DataService {
  constructor(
    private connections: ConnectionService,
    private settings: () => Settings,
    private events: EventBus,
  ) {}
  async select(connectionId: string, input: SelectInput) {
    const settings = this.settings();
    const limit = Math.min(input.limit ?? settings.pageSize, settings.maxRows);
    const engine = this.connections.get(connectionId).engine;
    const adapter = await this.connections.connect(connectionId, input.database);
    const built =
      engine === 'sybase'
        ? await aseReadSelect(adapter, input, limit, settings.queryTimeout)
        : new SqlBuilder(engine).select(input, limit);
    return adapter.query(built.sql, built.params, {
      limit,
      offset: engine === 'sybase' ? (input.offset ?? 0) : 0,
      timeout: settings.queryTimeout,
      readOnly: true,
    });
  }
  async mutate(
    action: 'insert' | 'update' | 'delete',
    connectionId: string,
    ref: TableRef,
    values: Record<string, unknown>,
    filters: Filter[],
  ) {
    const adapter = await this.connections.connect(connectionId, ref.database);
    if (action !== 'delete') {
      const columns = await adapter.describe(ref);
      // Most engines treat column names case-insensitively, so compare that way.
      const supplied = new Set(Object.keys(values).map((name) => name.toLowerCase()));
      if (columns.some((column) => column.generated && supplied.has(column.name.toLowerCase())))
        throw new Error('Generated column values are maintained by the database.');
    }
    const builder = new SqlBuilder(this.connections.get(connectionId).engine);
    const built =
      action === 'insert'
        ? builder.insert(ref, values)
        : action === 'update'
          ? builder.update(ref, values, filters)
          : builder.delete(ref, filters);
    const result = await adapter.query(built.sql, built.params, {
      limit: 1,
      timeout: this.settings().queryTimeout,
      readOnly: false,
    });
    this.events.emit(
      action === 'update' ? 'RowUpdated' : action === 'insert' ? 'RowInserted' : 'RowDeleted',
      {
        connectionId,
        database: ref.database ?? this.connections.get(connectionId).database,
        schema: ref.schema,
        table: ref.table,
        affectedRows: result.affectedRows,
      },
    );
    return result;
  }
}
