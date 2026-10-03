import type { Engine, Filter, SelectInput, TableRef } from '../../shared/types';
export class SqlBuilder {
  private params: unknown[] = [];
  constructor(private engine: Engine) {}
  quote(name: string) {
    if (!name || name.includes('\0')) throw new Error('Invalid SQL identifier.');
    if (this.engine === 'mysql') return '`' + name.replaceAll('`', '``') + '`';
    if (this.engine === 'sqlserver' || this.engine === 'sybase')
      return '[' + name.replaceAll(']', ']]') + ']';
    return '"' + name.replaceAll('"', '""') + '"';
  }
  table(ref: TableRef) {
    return [ref.schema, ref.table]
      .filter((v): v is string => !!v)
      .map((v) => this.quote(v))
      .join('.');
  }
  bind(value: unknown) {
    this.params.push(value);
    return this.engine === 'postgres'
      ? `$${this.params.length}`
      : this.engine === 'sqlserver'
        ? `@p${this.params.length}`
        : '?';
  }
  where(filters: Filter[] = []) {
    return filters.length
      ? ' WHERE ' +
          filters
            .map((filter) => {
              if (
                !['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IS NULL', 'IS NOT NULL'].includes(
                  filter.operator,
                )
              )
                throw new Error('Invalid filter operator.');
              const column = this.quote(filter.column);
              if (filter.operator === 'IS NULL' || filter.operator === 'IS NOT NULL')
                return `${column} ${filter.operator}`;
              // `col = NULL` is never true in SQL; an explicit null means "is / is not null".
              if (filter.value == null && (filter.operator === '=' || filter.operator === '!='))
                return `${column} ${filter.operator === '=' ? 'IS NULL' : 'IS NOT NULL'}`;
              return `${column} ${filter.operator} ${this.bind(filter.value ?? null)}`;
            })
            .join(' AND ')
      : '';
  }
  select(input: SelectInput, limit: number) {
    let sql = `SELECT ${input.columns?.map((name) => this.quote(name)).join(', ') ?? '*'} FROM ${this.table(input)}${this.where(input.filters)}`;
    if (input.sort?.length)
      sql +=
        ' ORDER BY ' +
        input.sort
          .map((sort) => `${this.quote(sort.column)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`)
          .join(', ');
    if (this.engine === 'sqlserver')
      sql += `${input.sort?.length ? '' : ' ORDER BY (SELECT NULL)'} OFFSET ${this.bind(input.offset ?? 0)} ROWS FETCH NEXT ${this.bind(limit + 1)} ROWS ONLY`;
    else if (this.engine !== 'sybase')
      sql += ` LIMIT ${this.bind(limit + 1)} OFFSET ${this.bind(input.offset ?? 0)}`;
    return { sql, params: this.params };
  }
  insert(ref: TableRef, values: Record<string, unknown>) {
    const keys = Object.keys(values);
    if (!keys.length && this.engine === 'sybase')
      throw new Error('ASE default-only inserts require an explicit column value in this release.');
    if (!keys.length)
      return {
        sql: `INSERT INTO ${this.table(ref)} ${this.engine === 'mysql' ? '() VALUES ()' : 'DEFAULT VALUES'}`,
        params: [],
      };
    return {
      sql: `INSERT INTO ${this.table(ref)} (${keys.map((key) => this.quote(key)).join(', ')}) VALUES (${keys.map((key) => this.bind(values[key])).join(', ')})`,
      params: this.params,
    };
  }
  update(ref: TableRef, values: Record<string, unknown>, filters: Filter[]) {
    if (!filters.length || !Object.keys(values).length)
      throw new Error('Updates require values and a row predicate.');
    const sql = `UPDATE ${this.table(ref)} SET ${Object.entries(values)
      .map(([key, value]) => `${this.quote(key)} = ${this.bind(value)}`)
      .join(', ')}${this.where(filters)}`;
    return { sql, params: this.params };
  }
  delete(ref: TableRef, filters: Filter[]) {
    if (!filters.length) throw new Error('Deletes require a row predicate.');
    return { sql: `DELETE FROM ${this.table(ref)}${this.where(filters)}`, params: this.params };
  }
}
