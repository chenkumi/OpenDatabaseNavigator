import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  decimalText,
  installExactDecimals,
} from '../src/main/database/adapters/sqlserver/exact-decimal';

const require = createRequire(import.meta.url);
const driverRequire = createRequire(require.resolve('mssql'));
const parser = driverRequire('tedious/lib/value-parser');
const { NotEnoughDataError } = driverRequire('tedious/lib/token/helpers');

it('decodes every decimal storage width without Number rounding and retries fragmented packets', () => {
  installExactDecimals();
  for (const [length, digits] of [
    [5, '123456789'],
    [9, '123456789012345678'],
    [13, '1234567890123456789012345678'],
    [17, '99999999999999999999999999999999999999'],
  ] as const) {
    const buffer = Buffer.alloc(length + 1);
    buffer[0] = length;
    buffer[1] = 1;
    let magnitude = BigInt(digits);
    for (let i = 2; i < buffer.length; i++) {
      buffer[i] = Number(magnitude & 255n);
      magnitude >>= 8n;
    }
    for (const name of ['DecimalN', 'NumericN']) {
      const metadata = { type: { name }, scale: 0 };
      expect(parser.readValue(buffer, 0, metadata, {})).toEqual({
        value: digits,
        offset: buffer.length,
      });
      for (let end = 0; end < buffer.length; end++)
        expect(() => parser.readValue(buffer.subarray(0, end), 0, metadata, {})).toThrow(
          NotEnoughDataError,
        );
      buffer[1] = 0;
      expect(parser.readValue(buffer, 0, metadata, {}).value).toBe('-' + digits);
      buffer[1] = 1;
    }
  }
  expect(decimalText(Buffer.alloc(5), 0, 5, 4)).toBe('0.0000');
  expect(
    parser.readValue(Buffer.from([0]), 0, { type: { name: 'DecimalN' }, scale: 6 }, {}),
  ).toEqual({ value: null, offset: 1 });
});
