import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { SQL_FILE_LIMIT } from '../../../shared/sql-script';
export async function readSqlFile(path: string) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > SQL_FILE_LIMIT)
      throw new Error('Choose a SQL file no larger than 16 MiB.');
    const buffer = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== stat.size)
      throw new Error('The file changed while being read. Select it again.');
    const bytes = buffer.subarray(0, bytesRead);
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    let sql: string;
    try {
      sql = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Save the SQL file as UTF-8 or UTF-16 with a byte-order mark.');
    }
    if (sql.includes('\0'))
      throw new Error('The SQL file contains binary data or an unsupported encoding.');
    if (Buffer.byteLength(sql, 'utf8') > SQL_FILE_LIMIT)
      throw new Error('Decoded SQL files are limited to 16 MiB.');
    return { fileName: basename(path), sql };
  } finally {
    await file.close();
  }
}
