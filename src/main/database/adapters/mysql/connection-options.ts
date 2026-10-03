import type mysql from 'mysql2';
import type { Connection } from '../../../../shared/types';

export function mysqlConnectionOptions(
  connection: Connection,
  password?: string,
  charset?: string,
): mysql.ConnectionOptions {
  return {
    host: connection.host,
    port: connection.port ?? 3306,
    user: connection.username,
    password,
    database: connection.database || undefined,
    ssl: connection.tls ? { rejectUnauthorized: true } : undefined,
    connectTimeout: connection.connectionTimeout ?? 10000,
    charset: charset || connection.charset || undefined,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  };
}
