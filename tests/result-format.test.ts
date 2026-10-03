import { expect, it } from 'vitest';
import { cellText, prettyJson, serializeRows } from '../src/shared/result-format';

it('exports selected columns in order and preserves JSON null, empty strings and precise number strings', () => {
  const row = {
    ignored: 3,
    id: '9223372036854775807',
    text: '中文\r\n"quoted",value',
    empty: '',
    missing: null,
    active: false,
  };
  const columns = ['id', 'text', 'empty', 'missing', 'active'];
  expect(JSON.parse(serializeRows(columns, [row], 'json'))).toEqual([
    { id: row.id, text: row.text, empty: '', missing: null, active: false },
  ]);
  expect(serializeRows(columns, [row], 'csv')).toBe(
    '"id","text","empty","missing","active"\r\n"9223372036854775807","中文\r\n""quoted"",value","",,false',
  );
  expect(serializeRows(['text'], [{ text: 'tab\tline\nvalue' }], 'tsv')).toBe(
    '"text"\r\n"tab\tline\nvalue"',
  );
});

it('formats JSON without rounding numeric literals or changing escapes and whitespace in strings', () => {
  const raw =
    '{"number":9223372036854775807,"decimal":1.123456789012345678901,"string":" a \\" b ","nested":[{},[],null,false]}';
  const formatted = prettyJson(raw)!;
  expect(formatted).toContain('9223372036854775807');
  expect(formatted).toContain('1.123456789012345678901');
  expect(JSON.parse(formatted)).toEqual(JSON.parse(raw));
  expect(prettyJson('not JSON')).toBeUndefined();
  expect(prettyJson('['.repeat(65) + '0' + ']'.repeat(65))).toBeUndefined();
  expect(prettyJson('"' + 'x'.repeat(1024 * 1024) + '"')).toBeUndefined();
  expect(cellText(null)).toBe('NULL');
});
