import { createRequire } from 'node:module';
import mssql from 'mssql';

// Tedious 20 decodes DECIMAL/NUMERIC into Number before mssql's valueHandler.
// Keep this small compatibility adapter pinned and test packet boundaries and
// actual servers. Do not rewrite arbitrary user SQL to CAST its result columns.
const require = createRequire(import.meta.url);
const driverRequire = createRequire(require.resolve('mssql'));
const valueHandlers = (
  mssql as typeof mssql & {
    valueHandler: Map<unknown, (value: unknown) => unknown>;
  }
).valueHandler;
type Metadata = { type: { name: string }; scale: number };
type ReadValue = (
  buffer: Buffer,
  offset: number,
  metadata: Metadata,
  options: unknown,
) => { value: unknown; offset: number };
const parser = driverRequire('tedious/lib/value-parser') as {
  readValue: ReadValue;
  exactDecimal?: boolean;
};
const { NotEnoughDataError } = driverRequire('tedious/lib/token/helpers') as {
  NotEnoughDataError: new (byteCount: number) => Error;
};

export function decimalText(buffer: Buffer, offset: number, length: number, scale: number) {
  if (![5, 9, 13, 17].includes(length) || !Number.isInteger(scale) || scale < 0 || scale > 38)
    throw new Error('Unsupported SQL Server decimal encoding.');
  if (buffer.length < offset + length) throw new NotEnoughDataError(offset + length);
  let magnitude = 0n;
  for (let index = offset + length - 1; index > offset; index--)
    magnitude = (magnitude << 8n) | BigInt(buffer[index]);
  const digits = magnitude.toString().padStart(scale + 1, '0');
  const sign = buffer[offset] === 0 && magnitude !== 0n ? '-' : '';
  return sign + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}

export function installExactDecimals() {
  if (driverRequire('tedious/package.json').version !== '20.0.0')
    throw new Error('Verify the SQL Server exact-decimal decoder before upgrading Tedious.');
  if (!parser.exactDecimal) {
    const original = parser.readValue;
    parser.readValue = (buffer, offset, metadata, options) => {
      if (['DecimalN', 'NumericN'].includes(metadata.type.name)) {
        if (buffer.length <= offset) throw new NotEnoughDataError(offset + 1);
        const length = buffer[offset++];
        if (!length) return { value: null, offset };
        return {
          value: decimalText(buffer, offset, length, metadata.scale),
          offset: offset + length,
        };
      }
      if (metadata.type.name === 'Variant') {
        if (buffer.length < offset + 4) throw new NotEnoughDataError(offset + 4);
        const length = buffer.readUInt32LE(offset);
        if (length && buffer.length < offset + 4 + length)
          throw new NotEnoughDataError(offset + 4 + length);
        if (length >= 4 && [0x6a, 0x6c].includes(buffer[offset + 4])) {
          const properties = buffer[offset + 5];
          if (properties !== 2) throw new Error('Unsupported SQL Server variant decimal encoding.');
          return {
            value: decimalText(buffer, offset + 8, length - 4, buffer[offset + 7]),
            offset: offset + 4 + length,
          };
        }
      }
      return original(buffer, offset, metadata, options);
    };
    parser.exactDecimal = true;
  }
  // msnodesqlv8 requests numeric strings; NUMERIC is lossless, but DECIMAL
  // still rounds natively and is rejected by the adapter's recordset guard.
  // Prevent mssql from converting exact NUMERIC strings back to Number.
  for (const type of [mssql.Decimal, mssql.Numeric])
    valueHandlers.set(type, (value) => {
      if (value === null || typeof value === 'string') return value;
      throw new Error('SQL Server returned an inexact decimal value.');
    });
  valueHandlers.set(mssql.Variant, (value) => value);
}
