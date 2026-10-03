import type { Engine } from '../../shared/types';

export const TYPE_SUGGESTIONS: Record<Engine, string[]> = {
  sqlite: [
    'INTEGER',
    'REAL',
    'TEXT',
    'BLOB',
    'NUMERIC',
    'VARCHAR',
    'DECIMAL',
    'BOOLEAN',
    'DATE',
    'DATETIME',
  ],
  mysql: [
    'TINYINT',
    'SMALLINT',
    'MEDIUMINT',
    'INT',
    'BIGINT',
    'DECIMAL',
    'NUMERIC',
    'FLOAT',
    'DOUBLE',
    'BIT',
    'BOOLEAN',
    'CHAR',
    'VARCHAR',
    'BINARY',
    'VARBINARY',
    'TINYTEXT',
    'TEXT',
    'MEDIUMTEXT',
    'LONGTEXT',
    'TINYBLOB',
    'BLOB',
    'MEDIUMBLOB',
    'LONGBLOB',
    'DATE',
    'TIME',
    'DATETIME',
    'TIMESTAMP',
    'YEAR',
    'JSON',
    'ENUM',
    'SET',
    'GEOMETRY',
  ],
  postgres: [
    'SMALLINT',
    'INTEGER',
    'BIGINT',
    'NUMERIC',
    'DECIMAL',
    'REAL',
    'DOUBLE PRECISION',
    'BOOLEAN',
    'CHAR',
    'VARCHAR',
    'TEXT',
    'BYTEA',
    'DATE',
    'TIME',
    'TIMESTAMP',
    'TIMESTAMP WITH TIME ZONE',
    'INTERVAL',
    'UUID',
    'JSON',
    'JSONB',
    'INET',
    'CIDR',
    'MACADDR',
    'BIT',
    'BIT VARYING',
    'XML',
  ],
  sqlserver: [
    'BIT',
    'TINYINT',
    'SMALLINT',
    'INT',
    'BIGINT',
    'DECIMAL',
    'NUMERIC',
    'MONEY',
    'SMALLMONEY',
    'FLOAT',
    'REAL',
    'CHAR',
    'VARCHAR',
    'NCHAR',
    'NVARCHAR',
    'BINARY',
    'VARBINARY',
    'DATE',
    'TIME',
    'DATETIME',
    'DATETIME2',
    'SMALLDATETIME',
    'DATETIMEOFFSET',
    'UNIQUEIDENTIFIER',
    'XML',
    'ROWVERSION',
    'GEOGRAPHY',
    'GEOMETRY',
    'SQL_VARIANT',
  ],
  redis: [],
  sybase: [
    'BIT',
    'TINYINT',
    'SMALLINT',
    'INT',
    'BIGINT',
    'UNSIGNED INT',
    'UNSIGNED BIGINT',
    'NUMERIC',
    'DECIMAL',
    'MONEY',
    'SMALLMONEY',
    'FLOAT',
    'REAL',
    'CHAR',
    'VARCHAR',
    'UNICHAR',
    'UNIVARCHAR',
    'TEXT',
    'UNITEXT',
    'BINARY',
    'VARBINARY',
    'IMAGE',
    'DATE',
    'TIME',
    'DATETIME',
    'SMALLDATETIME',
    'BIGDATETIME',
    'BIGTIME',
    'TIMESTAMP',
  ],
};

export function typeParts(sql: string) {
  // Only split numeric modifiers. ENUM, domains and other expressions remain intact.
  const match = /^(\s*[a-z][a-z0-9\s]*?)\s*\(\s*(max|\d+)\s*(?:,\s*(-?\d+)\s*)?\)(.*)$/i.exec(sql);
  if (!match) return { base: sql, length: '', scale: '', suffix: '' };
  // Show semantic qualifiers in the editable type name, rather than hiding them
  // and accidentally carrying UNSIGNED/time-zone qualifiers onto an unrelated type.
  const qualifier =
    /^\s+(?:(?:UNSIGNED|ZEROFILL)(?:\s+(?:UNSIGNED|ZEROFILL))*|(?:WITH|WITHOUT) TIME ZONE)\s*$/i.test(
      match[4],
    );
  return {
    base: match[1].trim() + (qualifier ? match[4] : ''),
    length: match[2],
    scale: match[3] ?? '',
    suffix: qualifier ? '' : match[4],
  };
}

export function typeOptions(engine: Engine, base: string) {
  const name = base
    .trim()
    .toUpperCase()
    .replace(/\s+(UNSIGNED|ZEROFILL)\b/g, '')
    .trim();
  const decimal = /^(DECIMAL|NUMERIC|DEC)$/.test(name);
  const text =
    (!['sqlserver', 'sybase'].includes(engine) || name !== 'BIT') &&
    /^(CHAR|CHARACTER|VARCHAR|CHARACTER VARYING|NCHAR|NVARCHAR|UNICHAR|UNIVARCHAR|BINARY|VARBINARY|BIT|BIT VARYING)$/.test(
      name,
    );
  const integerWidth =
    engine === 'mysql' && /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)$/.test(name);
  const legacyFloat = engine === 'mysql' && /^(FLOAT|DOUBLE|DOUBLE PRECISION|REAL)$/.test(name);
  const floatPrecision = (engine === 'sqlserver' || engine === 'postgres') && name === 'FLOAT';
  const temporal =
    engine === 'mysql'
      ? /^(TIME|DATETIME|TIMESTAMP)$/.test(name)
      : engine === 'sqlserver'
        ? /^(TIME|DATETIME2|DATETIMEOFFSET)$/.test(name)
        : engine === 'postgres' && /^(TIME|TIMESTAMP)( (WITH|WITHOUT) TIME ZONE)?$/.test(name);
  return {
    length: decimal || text || integerWidth || legacyFloat || floatPrecision || temporal,
    scale: decimal || legacyFloat,
    max: engine === 'sqlserver' && /^(VARCHAR|NVARCHAR|VARBINARY)$/.test(name),
    min: temporal ? 0 : 1,
    scaleMin: engine === 'postgres' && decimal ? -1000 : 0,
    deprecated: integerWidth || legacyFloat,
  };
}

export function formatType(base: string, length: string, scale: string, suffix = '') {
  // PostgreSQL places time precision before the time-zone qualifier.
  const time = /^(TIME|TIMESTAMP)(\s+(?:WITH|WITHOUT) TIME ZONE)$/i.exec(base.trim());
  const modifier = length ? `(${length}${scale ? `,${scale}` : ''})` : '';
  const flags = /^(.*?)(\s+(?:UNSIGNED|ZEROFILL)(?:\s+(?:UNSIGNED|ZEROFILL))*)$/i.exec(base.trim());
  if (flags) return `${flags[1]}${modifier}${flags[2]}${suffix}`;
  return time ? `${time[1]}${modifier}${time[2]}${suffix}` : `${base}${modifier}${suffix}`;
}
