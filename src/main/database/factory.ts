import type { SqlAdapterFactory } from './adapter';
import { SqliteAdapter } from './adapters/sqlite/sqlite-adapter';
import { PostgresAdapter } from './adapters/postgres/postgres-adapter';
import { MysqlAdapter } from './adapters/mysql/mysql-adapter';
import { SqlServerAdapter } from './adapters/sqlserver/sqlserver-adapter';
import { RedisAdapter } from './adapters/redis/redis-adapter';
import { SybaseAdapter } from './adapters/sybase/sybase-adapter';
export const createAdapter: SqlAdapterFactory = (connection, password) => {
  switch (connection.engine) {
    case 'sybase':
      return new SybaseAdapter(connection, password);
    case 'sqlite':
      return new SqliteAdapter(connection.database);
    case 'postgres':
      return new PostgresAdapter(connection, password);
    case 'mysql':
      return new MysqlAdapter(connection, password);
    case 'sqlserver':
      return new SqlServerAdapter(connection, password);
    case 'redis':
      return new RedisAdapter(connection, password);
  }
};
