import { expect, it } from 'vitest';
import {
  formatType,
  typeOptions,
  typeParts,
  TYPE_SUGGESTIONS,
} from '../src/renderer/src/column-types';

it('splits numeric modifiers without rewriting enum, custom or array declarations', () => {
  for (const sql of [
    'DECIMAL(18,2)',
    'int(11) unsigned',
    'numeric(12,-2)[]',
    'varchar(MAX)',
    'datetime2(7)',
    'timestamp(6) with time zone',
    "enum('a','b')",
    '"app"."CustomType"',
  ]) {
    const parts = typeParts(sql);
    expect(formatType(parts.base, parts.length, parts.scale, parts.suffix).toLowerCase()).toBe(
      sql.toLowerCase(),
    );
  }
  expect(formatType('INT UNSIGNED', '11', '')).toBe('INT(11) UNSIGNED');
  expect(formatType('TIMESTAMP WITH TIME ZONE', '6', '')).toBe('TIMESTAMP(6) WITH TIME ZONE');
});

it('uses engine-specific suggestions and supported dimension controls', () => {
  expect(TYPE_SUGGESTIONS.postgres).toContain('JSONB');
  expect(TYPE_SUGGESTIONS.mysql).not.toContain('JSONB');
  expect(TYPE_SUGGESTIONS.sqlserver).toContain('NVARCHAR');
  expect(typeOptions('postgres', 'INTEGER').length).toBe(false);
  expect(typeOptions('mysql', 'INT')).toMatchObject({
    length: true,
    scale: false,
    deprecated: true,
  });
  expect(typeOptions('sqlserver', 'DECIMAL')).toMatchObject({ length: true, scale: true });
  expect(typeOptions('sqlserver', 'FLOAT')).toMatchObject({ length: true, scale: false });
  expect(typeOptions('postgres', 'NUMERIC').scaleMin).toBe(-1000);
  expect(typeOptions('sqlserver', 'NVARCHAR').max).toBe(true);
  expect(typeOptions('mysql', "ENUM('a','b')").length).toBe(false);
});
