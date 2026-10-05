import type { Engine, Filter, SelectInput, TableRef } from '../../shared/types';
export type ExactNumericProjection = {
  kind: 'numeric' | 'money';
  precision: number;
  scale: number;
};
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
  where(
    filters: Filter[] = [],
    textColumns: ReadonlyMap<string, ExactNumericProjection> = new Map(),
  ) {
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
              const type = this.engine === 'sybase' ? textColumns.get(filter.column) : undefined;
              if (type && filter.operator === 'LIKE') {
                const exact = type.kind === 'money' ? `CONVERT(numeric(38,4), ${column})` : column;
                return `CONVERT(varchar(80), ${exact}) LIKE ${this.bind(filter.value ?? null)}`;
              }
              let parameter = this.bind(filter.value ?? null);
              if (type && typeof filter.value === 'string') {
                // ASE11 disallows implicit CHAR -> DECIMAL comparison. Size the
                // parameter from its OWN digits, not the column scale (no rounding).
                const decimal = /^[+-]?(\d*)(?:\.(\d*))?$/.exec(filter.value.trim());
                if (!decimal || !(decimal[1] || decimal[2]))
                  throw new Error('ASE numeric filters require a plain decimal value.');
                const scale = (decimal[2] ?? '').length;
                const precision = Math.max(1, decimal[1].replace(/^0+/, '').length + scale);
                if (precision > 38)
                  throw new Error('ASE numeric filter exceeds 38-digit precision.');
                parameter = `CONVERT(numeric(38,${scale}), ${parameter})`;
              }
              return `${column} ${filter.operator} ${parameter}`;
            })
            .join(' AND ')
      : '';
  }
  select(
    input: SelectInput,
    limit: number,
    textColumns: ReadonlyMap<string, ExactNumericProjection> = new Map(),
  ) {
    const source =
      this.engine === 'sybase' && textColumns.size ? this.quote('ase_read_source') : undefined;
    const projection =
      input.columns
        ?.map((name) => {
          const column = this.quote(name);
          // ASE precision <=38 plus sign/decimal point fits in 80 chars.
          // WHERE uses source values; ORDER BY is explicitly numeric below.
          if (this.engine !== 'sybase' || !textColumns.has(name)) return column;
          // Legacy ASE ignores money-to-text style 2; normalize to exact scale 4 first.
          const exact =
            textColumns.get(name)?.kind === 'money' ? `CONVERT(numeric(38,4), ${column})` : column;
          return `CONVERT(varchar(80), ${exact}) AS ${column}`;
        })
        .join(', ') ?? '*';
    let sql = `SELECT ${projection} FROM ${this.table(input)}${source ? ` ${source}` : ''}${this.where(input.filters, textColumns)}`;
    if (input.sort?.length)
      sql +=
        ' ORDER BY ' +
        input.sort
          .map((sort) => {
            const column = `${source ? `${source}.` : ''}${this.quote(sort.column)}`;
            const type = this.engine === 'sybase' ? textColumns.get(sort.column) : undefined;
            // ASE11 can resolve even qualified names to the text SELECT alias.
            // An exact original-precision expression forces numeric ordering either way.
            const ordered = type
              ? `CONVERT(numeric(${type.precision},${type.scale}), ${column})`
              : column;
            return `${ordered} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`;
          })
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
