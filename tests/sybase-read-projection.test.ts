import { expect, it, vi } from 'vitest';
import { aseTables } from '../src/main/database/adapters/sybase/sybase-catalog';
import { SqlBuilder } from '../src/main/database/sql-builder';
import { assertAseReadOnly } from '../src/main/security/ase-readonly';
import { DataService } from '../src/main/application/services/data-service';
import type { ConnectionService } from '../src/main/application/services/connection-service';
import { EventBus } from '../src/main/application/events/event-bus';
import type { SqlAdapter } from '../src/main/database/adapter';
import { DEFAULT_SETTINGS } from '../src/shared/types';

it('classifies padded ASE view types rather than placing them in tables', async () => {
  const adapter = {
    query: async () => ({
      rows: [
        { name: 't', schema_name: 'dbo', kind: 'U ' },
        { name: 'v', schema_name: 'dbo', kind: 'V ' },
        { name: 'v2', schema_name: 'reporting', kind: 'v' },
      ],
      hasMore: false,
    }),
  } as unknown as SqlAdapter;
  expect((await aseTables(adapter)).map((item) => item.kind)).toEqual(['table', 'view', 'view']);
});
it('only converts the Sybase projection while retaining numeric WHERE/ORDER BY and params', () => {
  const result = new SqlBuilder('sybase').select(
    {
      table: 't',
      schema: 'dbo',
      columns: ['amount', 'name'],
      filters: [{ column: 'amount', operator: '>', value: '9007199254740993.25' }],
      sort: [{ column: 'amount', direction: 'desc' }],
      offset: 30,
    },
    20,
    new Map([['amount', { kind: 'numeric', precision: 38, scale: 2 }]]),
  );
  expect(result.sql).toBe(
    'SELECT CONVERT(varchar(80), [amount]) AS [amount], [name] FROM [dbo].[t] [ase_read_source] WHERE [amount] > CONVERT(numeric(38,2), ?) ORDER BY CONVERT(numeric(38,2), [ase_read_source].[amount]) DESC',
  );
  expect(result.params).toEqual(['9007199254740993.25']);
  expect(() => assertAseReadOnly(result.sql)).not.toThrow();
});
it('preserves a filter threshold scale finer than the stored column rather than rounding it', () => {
  const built = new SqlBuilder('sybase').select(
    {
      table: 't',
      columns: ['amount'],
      filters: [{ column: 'amount', operator: '>=', value: '1.251' }],
    },
    10,
    new Map([['amount', { kind: 'numeric', precision: 6, scale: 2 }]]),
  );
  expect(built.sql).toContain('[amount] >= CONVERT(numeric(38,3), ?)');
  expect(built.params).toEqual(['1.251']);
});
it('supports textual LIKE for exact numeric values and leaves NULL tests parameter-free', () => {
  const built = new SqlBuilder('sybase').select(
    {
      table: 't',
      columns: ['amount'],
      filters: [
        { column: 'amount', operator: 'LIKE', value: '1.%' },
        { column: 'amount', operator: '!=', value: null },
      ],
    },
    10,
    new Map([['amount', { kind: 'money', precision: 38, scale: 4 }]]),
  );
  expect(built.sql).toContain(
    'WHERE CONVERT(varchar(80), CONVERT(numeric(38,4), [amount])) LIKE ? AND [amount] IS NOT NULL',
  );
  expect(built.params).toEqual(['1.%']);
  expect(() => assertAseReadOnly(built.sql)).not.toThrow();
});
it.each(['.', '1e3', 'NaN', '1; SELECT 1', '123456789012345678901234567890123456789'])(
  'rejects invalid or excessive numeric filter %s',
  (value) => {
    expect(() =>
      new SqlBuilder('sybase').select(
        { table: 't', columns: ['amount'], filters: [{ column: 'amount', operator: '>=', value }] },
        10,
        new Map([['amount', { kind: 'numeric', precision: 6, scale: 2 }]]),
      ),
    ).toThrow(/numeric filter/);
  },
);
it.each(['numeric(38,4)', 'decimal(38,38)', 'numeric(1,0)'])(
  'permits bounded CONVERT numeric type %s',
  (type) => {
    expect(() =>
      assertAseReadOnly(`SELECT CONVERT(varchar(80), CONVERT(${type}, 1))`),
    ).not.toThrow();
  },
);
it.each([
  'numeric(38,4)',
  'dbo.numeric(38,4)',
  '[numeric](38,4)',
  'CONVERT(numeric(0,0),1)',
  'CONVERT(numeric(39,4),1)',
  'CONVERT(decimal(3,4),1)',
  'CONVERT(numeric(38,-1),1)',
  "CONVERT(numeric('38',4),1)",
  'CONVERT(numeric(38,4), dbo.write$probe())',
])('rejects unsafe numeric constructors %s', (expression) => {
  expect(() => assertAseReadOnly(`SELECT ${expression}`)).toThrow();
});
it.each([1, 80, 255])('permits VARCHAR(%i) solely as a fixed CONVERT type', (size) => {
  expect(() =>
    assertAseReadOnly(`SELECT CONVERT(varchar(${size}), [amount]) FROM [dbo].[t]`),
  ).not.toThrow();
});
it.each([
  'SELECT varchar(80)',
  'SELECT dbo.varchar(80)',
  'SELECT [varchar](80)',
  'SELECT CONVERT(dbo.varchar(80), 1)',
  'SELECT CONVERT([varchar](80), 1)',
  'SELECT CONVERT(varchar(0), 1)',
  'SELECT CONVERT(varchar(256), 1)',
  "SELECT CONVERT(varchar('80'), 1)",
  'SELECT CONVERT(varchar(80, 1), 1)',
  'SELECT CONVERT(varchar(80), dbo.write$probe())',
  'SELECT CONVERT(varchar(80), 寫入())',
  'SELECT CONVERT(varchar(80), 1) INTO t',
])('does not broaden the function/write allowlist: %s', (sql) => {
  expect(() => assertAseReadOnly(sql)).toThrow();
});
const fields = [
  { name: 'amount', storage_type: '106', col_precision: 38, col_scale: 2 },
  { name: 'alias_numeric', storage_type: 108, col_precision: 38, col_scale: 18 },
  { name: 'money', storage_type: 60 },
  { name: 'smallmoney', storage_type: 122 },
  { name: 'label', storage_type: 39 },
];
function fixture(engine = 'sybase', columns = fields, hasMore = false, major = 11) {
  const result = {
    columns: columns.map((column) => column.name),
    rows: [{ amount: '9007199254740993.25', label: null }],
    hasMore: true,
    durationMs: 1,
  };
  const query = vi.fn(async (sql: string) =>
    sql.includes('dbo.syscolumns')
      ? { columns: ['name', 'storage_type'], rows: columns, hasMore, durationMs: 1 }
      : result,
  );
  const adapter = {
    connect: vi.fn(async () => undefined),
    query,
    aseMajorVersion: major,
  } as unknown as SqlAdapter;
  const connect = vi.fn(async () => adapter);
  const connections = { get: () => ({ engine }), connect } as unknown as ConnectionService;
  const service = new DataService(connections, () => DEFAULT_SETTINGS, new EventBus());
  return { service, query, connect, result };
}
it('expands wildcard in catalog order and preserves exact string values/null/hasMore/offset', async () => {
  const { service, query, connect, result } = fixture();
  expect(
    await service.select('ase', {
      database: 'kyclaim',
      schema: 'dbo',
      table: 't',
      offset: 20,
      limit: 10,
    }),
  ).toBe(result);
  expect(connect).toHaveBeenCalledWith('ase', 'kyclaim');
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0][0]).toContain('dbo.syscolumns');
  const [sql, params, options] = (
    query.mock.calls as unknown as [
      string,
      unknown[],
      { offset: number; readOnly: boolean; limit: number },
    ][]
  )[1];
  expect(sql).toBe(
    'SELECT CONVERT(varchar(80), [amount]) AS [amount], CONVERT(varchar(80), [alias_numeric]) AS [alias_numeric], CONVERT(varchar(80), CONVERT(numeric(38,4), [money])) AS [money], CONVERT(varchar(80), CONVERT(numeric(38,4), [smallmoney])) AS [smallmoney], [label] FROM [dbo].[t] [ase_read_source]',
  );
  expect(params).toEqual([]);
  expect(options).toMatchObject({ offset: 20, readOnly: true, limit: 10 });
});
it('applies the same conversion to explicitly selected columns without adding others', async () => {
  const { service, query } = fixture();
  await service.select('ase', { schema: 'dbo', table: 't', columns: ['label', 'amount'] });
  expect(query.mock.calls.at(-1)?.[0]).toBe(
    'SELECT [label], CONVERT(varchar(80), [amount]) AS [amount] FROM [dbo].[t] [ase_read_source]',
  );
});
it.each(['mysql', 'postgres', 'sqlserver', 'sqlite'])(
  'leaves %s data reads unchanged and does not query ASE metadata',
  async (engine) => {
    const { service, query } = fixture(engine);
    const input = { schema: 'dbo', table: 't', offset: 10, limit: 5 };
    await service.select('id', input);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(new SqlBuilder(engine as 'mysql').select(input, 5).sql);
  },
);
it.each([
  { columns: [], hasMore: false },
  { columns: fields, hasMore: true },
])('fails closed on absent/truncated projection metadata', async ({ columns, hasMore }) => {
  const { service, query } = fixture('sybase', columns, hasMore);
  await expect(service.select('ase', { schema: 'dbo', table: 't' })).rejects.toThrow(/metadata/i);
  expect(query).toHaveBeenCalledTimes(1);
});
it.each([
  [11, 'dbo.t'],
  [16, '[dbo].[t]'],
] as const)('uses correct object_id parameter for ASE%i', async (major, target) => {
  const { service, query } = fixture('sybase', fields, false, major);
  await service.select('ase', { schema: 'dbo', table: 't' });
  expect(query.mock.calls[0]).toEqual([
    expect.stringContaining('object_id(?)'),
    [target],
    expect.objectContaining({ readOnly: true, timeout: DEFAULT_SETTINGS.queryTimeout }),
  ]);
});
it.each([
  { col_precision: 0, col_scale: 0 },
  { col_precision: 39, col_scale: 2 },
  { col_precision: 4, col_scale: 5 },
  { col_precision: 38, col_scale: null },
  { col_precision: undefined, col_scale: 0 },
])('rejects corrupt numeric metadata before querying data', async (bad) => {
  const { service, query } = fixture('sybase', [
    { name: 'amount', storage_type: 106, ...bad },
  ] as unknown as typeof fields);
  await expect(service.select('ase', { schema: 'dbo', table: 't' })).rejects.toThrow(/metadata/i);
  expect(query).toHaveBeenCalledTimes(1);
});
it.each([{ columns: ['unknown'] }, { sort: [{ column: 'UNKNOWN', direction: 'asc' as const }] }])(
  'rejects unknown projection/order columns before querying data',
  async (extra) => {
    const { service, query } = fixture();
    await expect(service.select('ase', { schema: 'dbo', table: 't', ...extra })).rejects.toThrow(
      /metadata/i,
    );
    expect(query).toHaveBeenCalledTimes(1);
  },
);
it('does not attempt a data SELECT when metadata lookup fails', async () => {
  const { service, query } = fixture();
  query.mockRejectedValueOnce(new Error('Catalog access denied'));
  await expect(service.select('ase', { schema: 'dbo', table: 't' })).rejects.toThrow(
    'Catalog access denied',
  );
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).toContain('dbo.syscolumns');
});
