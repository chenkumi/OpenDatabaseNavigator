/** Explicit ASCII-compatible encodings offered for Redis text keys and values. */
export const REDIS_ENCODINGS = [
  { value: 'utf8', label: 'UTF-8' },
  { value: 'latin1', label: 'ISO-8859-1 (Latin-1)' },
  { value: 'windows1252', label: 'Windows-1252' },
  { value: 'big5', label: 'Big5' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'shiftjis', label: 'Shift JIS' },
  { value: 'eucjp', label: 'EUC-JP' },
] as const;

/** PostgreSQL names, paired with the local byte codec. SQL_ASCII is intentionally
 * excluded: arbitrary bytes cannot be represented as lossless UI text. */
export const POSTGRES_ENCODINGS = [
  { value: 'UTF8', codec: 'utf8', label: 'UTF-8' },
  { value: 'LATIN1', codec: 'latin1', label: 'ISO-8859-1 (Latin-1)' },
  { value: 'WIN1252', codec: 'windows1252', label: 'Windows-1252' },
  { value: 'BIG5', codec: 'big5', label: 'Big5' },
  { value: 'GBK', codec: 'gbk', label: 'GBK' },
  { value: 'GB18030', codec: 'gb18030', label: 'GB18030' },
  { value: 'SJIS', codec: 'shiftjis', label: 'Shift JIS' },
  { value: 'EUC_JP', codec: 'eucjp', label: 'EUC-JP' },
] as const;

/** SAP jConnect names. An omitted ASE charset retains the existing ODBC path. */
export const ASE_ENCODINGS = [
  { value: 'utf8', label: 'UTF-8 (JDBC)' },
  { value: 'iso_1', label: 'ISO-8859-1 (JDBC)' },
  { value: 'cp1252', label: 'Windows-1252 (JDBC)' },
  { value: 'big5', label: 'Big5 (JDBC)' },
  { value: 'cp936', label: 'GBK (JDBC)' },
  { value: 'gb18030', label: 'GB18030 (JDBC)' },
  { value: 'sjis', label: 'Shift JIS / MS932 (JDBC)' },
  { value: 'eucjis', label: 'EUC-JP (JDBC)' },
] as const;
