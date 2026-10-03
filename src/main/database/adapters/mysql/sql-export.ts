import mysql from 'mysql2';
import type { Readable } from 'node:stream';
import type { Connection } from '../../../../shared/types';
import type { SqlExportOptions } from '../../../../shared/sql-export';
import { scriptDeadline } from '../../script-session';
import { sqlTokens } from '../../object-sql';
import { mysqlConnectionOptions } from './connection-options';
import { mysqlViewDependencies } from './view-dependencies';
import { mysqlSocketTimeouts } from './socket-timeouts';

const qi = (name: string) => '`' + name.replaceAll('`', '``') + '`';
const textLiteral = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const exportMode = 'NO_AUTO_VALUE_ON_ZERO,NO_BACKSLASH_ESCAPES';
type Row = Record<string, any>;
interface Definition {
  kind: string;
  name: string;
  sql: string;
  mode: string;
  collation: string;
}

/** Only identifier references, never literals/comments, form view dependencies. */
export function mysqlViewOrder(views: Definition[], database: string) {
  const byName = new Map(views.map((view) => [view.name, view]));
  const ordered: Definition[] = [],
    visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (view: Definition) => {
    if (done.has(view.name)) return;
    if (visiting.has(view.name)) throw new Error('Cyclic view dependencies cannot be exported.');
    visiting.add(view.name);
    for (const name of mysqlViewDependencies(view.sql, database)) {
      const dependency = byName.get(name);
      if (dependency) visit(dependency);
    }
    visiting.delete(view.name);
    done.add(view.name);
    ordered.push(view);
  };
  for (const view of views) visit(view);
  return ordered;
}

function stableTableDdl(sql: string) {
  // Concurrent INSERTs may advance AUTO_INCREMENT without changing structure.
  // Ignore only the table option's number, not text in comments or defaults.
  const tokens = sqlTokens(sql, 'mysql', true);
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.quoted) continue;
    if (t.value === '(') depth++;
    if (t.value === ')') depth--;
    if (
      !depth &&
      t.value.toUpperCase() === 'AUTO_INCREMENT' &&
      tokens[i + 1]?.value === '=' &&
      /^\d+$/.test(tokens[i + 2]?.value ?? '')
    )
      return sql.slice(0, tokens[i + 2].start) + '<sequence>' + sql.slice(tokens[i + 2].end);
  }
  return sql;
}

export async function mysqlSqlExport(
  connection: Connection,
  password: string | undefined,
  options: SqlExportOptions,
) {
  if (!connection.database) throw new Error('Choose a database to export.');
  if (
    ['mysql', 'information_schema', 'performance_schema', 'sys'].includes(
      connection.database.toLowerCase(),
    )
  )
    throw new Error('SQL export does not support server system databases.');
  const client = mysql.createConnection(mysqlConnectionOptions(connection, password, 'utf8mb4'));
  mysqlSocketTimeouts(client, connection);
  let failure: Error | undefined, stream: Readable | undefined;
  const writer = options.write;
  options = {
    ...options,
    write: async (chunk) => {
      if (options.signal.aborted) throw new Error('SQL export cancelled.');
      if (failure) throw failure;
      await writer(chunk);
      if (options.signal.aborted) throw new Error('SQL export cancelled.');
    },
  };
  client.on('error', (error) => {
    failure = error;
  });
  const stop = () => {
    stream?.destroy(new Error('SQL export cancelled or timed out.'));
    client.destroy();
  };
  const run = <T>(task: () => Promise<T>) => {
    if (failure) return Promise.reject(failure);
    return scriptDeadline(options.signal, options.timeout, stop, task);
  };
  const query = (sql: string, values: string[] = []) =>
    run(async () => {
      const [rows] = values.length
        ? await client.promise().execute(sql, values)
        : await client.promise().query(sql);
      return rows as Row[];
    });
  const mode = async (value: string) => {
    if (!/^[A-Z0-9_,]*$/.test(value)) throw new Error('Unsupported SQL mode in exported metadata.');
    await options.write('SET SESSION sql_mode=' + textLiteral(value) + ';\n');
  };
  const ddl = async (definition: Definition) => {
    await mode(definition.mode);
    if (!/^[A-Za-z0-9_]+$/.test(definition.collation))
      throw new Error('Invalid metadata collation.');
    await options.write('SET collation_connection=' + textLiteral(definition.collation) + ';\n');
    // A random punctuation delimiter must not collide with an authored body.
    let delimiter = '$$';
    while (definition.sql.includes(delimiter)) delimiter += '$';
    if (delimiter.length > 32) throw new Error('Cannot choose a safe SQL delimiter.');
    await options.write(
      'DELIMITER ' +
        delimiter +
        '\n' +
        definition.sql.trim() +
        '\n' +
        delimiter +
        '\nDELIMITER ;\n',
    );
  };
  const objects = () =>
    query(
      'SELECT TABLE_NAME AS name,TABLE_TYPE AS kind,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME',
      [connection.database],
    );
  const definitions = async (tables: Row[]): Promise<Definition[]> => {
    const result: Definition[] = [];
    for (const table of tables) {
      const row = (
        await query('SHOW CREATE ' + (table.kind === 'VIEW' ? 'VIEW ' : 'TABLE ') + qi(table.name))
      )[0];
      const sql = String(row[table.kind === 'VIEW' ? 'Create View' : 'Create Table'] ?? '');
      if (!sql)
        throw new Error(
          'Missing definition for ' + table.name + '. Check SHOW VIEW / SELECT privileges.',
        );
      result.push({
        kind: table.kind,
        name: table.name,
        sql,
        mode: exportMode,
        collation: String(row.collation_connection || 'utf8mb4_general_ci'),
      });
    }
    const routines = await query(
      'SELECT ROUTINE_NAME AS name,ROUTINE_TYPE AS kind FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_TYPE,ROUTINE_NAME',
      [connection.database],
    );
    for (const routine of routines) {
      if (!['FUNCTION', 'PROCEDURE'].includes(routine.kind))
        throw new Error('Unsupported routine type.');
      const row = (await query('SHOW CREATE ' + routine.kind + ' ' + qi(routine.name)))[0];
      const sql = String(
        row[routine.kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure'] ?? '',
      );
      if (!sql)
        throw new Error('Missing routine definition. SHOW ROUTINE privileges are required.');
      result.push({
        kind: routine.kind,
        name: routine.name,
        sql,
        mode: String(row.sql_mode ?? ''),
        collation: String(row.collation_connection),
      });
    }
    const triggers = await query(
      'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION,ACTION_ORDER',
      [connection.database],
    );
    for (const trigger of triggers) {
      const row = (await query('SHOW CREATE TRIGGER ' + qi(trigger.name)))[0];
      const sql = String(row['SQL Original Statement'] ?? '');
      if (!sql) throw new Error('Missing trigger definition. TRIGGER privileges are required.');
      result.push({
        kind: 'TRIGGER',
        name: trigger.name,
        sql,
        mode: String(row.sql_mode ?? ''),
        collation: String(row.collation_connection),
      });
    }
    return result;
  };
  try {
    await run(
      () =>
        new Promise<void>((resolve, reject) =>
          client.connect((error) => (error ? reject(error) : resolve())),
        ),
    );
    await query('SET SESSION sql_mode=?', [exportMode]);
    await query("SET time_zone='+00:00'");
    await query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const tables = await objects();
    if (tables.some((t) => !['BASE TABLE', 'VIEW'].includes(t.kind)))
      throw new Error('SQL export does not yet support sequences or system-versioned tables.');
    const lockTables =
      options.includeData && tables.some((t) => t.kind === 'BASE TABLE' && t.engine !== 'InnoDB');
    if (lockTables) {
      if (
        tables.some(
          (t) =>
            t.kind === 'BASE TABLE' &&
            !['InnoDB', 'MyISAM', 'Aria', 'MEMORY', 'CSV', 'ARCHIVE'].includes(t.engine),
        )
      )
        throw new Error(
          'Consistent export is not supported for this storage engine. Choose structure only.',
        );
      await query('ROLLBACK');
      await query('SET SESSION TRANSACTION READ ONLY');
      await query('SET autocommit=0');
      await query('SET SESSION innodb_table_locks=1');
      await query('LOCK TABLES ' + tables.map((t) => qi(t.name) + ' READ').join(','));
      if (JSON.stringify(tables) !== JSON.stringify(await objects()))
        throw new Error('Database objects changed while acquiring export locks. Retry.');
    }
    // Keep metadata locks for all captured objects until the snapshot closes.
    for (const table of tables) await query('SELECT * FROM ' + qi(table.name) + ' LIMIT 0');
    const initial = await definitions(tables);
    const views = mysqlViewOrder(
      initial.filter((d) => d.kind === 'VIEW'),
      connection.database,
    );
    const schema = (
      await query(
        'SELECT DEFAULT_CHARACTER_SET_NAME AS charset,DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
        [connection.database],
      )
    )[0];
    await options.write(
      '-- Database Workspace / MySQL-MariaDB SQL export\n-- Restore into an empty database with the original database name and collation.\n-- Original qualified references and DEFINER accounts are preserved.\n-- Scheduled events are not exported (the same default as mysqldump).\n-- Source database (UTF-8 hex): ' +
        Buffer.from(connection.database).toString('hex') +
        '\n-- Source defaults: ' +
        schema.charset +
        ' / ' +
        schema.collation +
        '\n',
    );
    await options.write("SET NAMES utf8mb4;\nSET time_zone='+00:00';\nSET foreign_key_checks=0;\n");
    for (const d of initial.filter((d) => d.kind === 'BASE TABLE')) await ddl(d);
    for (const d of initial.filter((d) => d.kind === 'FUNCTION' || d.kind === 'PROCEDURE'))
      await ddl(d);
    await mode(exportMode);
    await options.write('START TRANSACTION;\n');
    let rows = 0,
      completed = 0;
    for (const table of tables.filter((t) => t.kind === 'BASE TABLE')) {
      if (options.includeData) {
        const columns = await query(
          'SELECT COLUMN_NAME AS name,DATA_TYPE AS type,CHARACTER_SET_NAME AS charset,EXTRA AS extra,GENERATION_EXPRESSION AS expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
          [connection.database, table.name],
        );
        const writable = columns.filter(
          (c) => !c.expression && !/VIRTUAL GENERATED|STORED GENERATED/.test(c.extra),
        );
        if (!writable.length) throw new Error('Cannot export a table without writable columns.');
        const expressions = writable.map((c, i) => {
          const name = qi(c.name),
            type = String(c.type).toLowerCase();
          let value: string;
          if (type === 'float') value = 'CAST((' + name + '+0e0) AS CHAR)';
          else if (
            [
              'tinyint',
              'smallint',
              'mediumint',
              'int',
              'integer',
              'bigint',
              'decimal',
              'numeric',
              'double',
              'real',
              'year',
            ].includes(type)
          )
            value = 'CAST(' + name + ' AS CHAR)';
          else if (type === 'enum' || type === 'set')
            value = 'CAST(CAST(' + name + ' AS UNSIGNED) AS CHAR)';
          else if (
            [
              'geometry',
              'point',
              'linestring',
              'polygon',
              'multipoint',
              'multilinestring',
              'multipolygon',
              'geometrycollection',
            ].includes(type)
          )
            value =
              "CONCAT('ST_GeomFromWKB(X''',HEX(ST_AsWKB(" +
              name +
              ")),''',',ST_SRID(" +
              name +
              "),')')";
          else if (type === 'bit') value = "CONCAT('0x',HEX(" + name + '))';
          else if (
            ['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'].includes(type)
          )
            value = "CONCAT('X''',HEX(" + name + "),'''')";
          else {
            if (
              ![
                'char',
                'varchar',
                'tinytext',
                'text',
                'mediumtext',
                'longtext',
                'json',
                'date',
                'datetime',
                'timestamp',
                'time',
                'uuid',
                'inet4',
                'inet6',
              ].includes(type)
            )
              throw new Error(
                'SQL data export does not yet support column type ' +
                  type +
                  ' (' +
                  table.name +
                  '.' +
                  c.name +
                  ').',
              );
            const textualAddress = ['uuid', 'inet4', 'inet6'].includes(type);
            const charset = textualAddress ? 'utf8mb4' : String(c.charset || 'utf8mb4');
            if (!/^[A-Za-z0-9_]+$/.test(charset))
              throw new Error('Unsupported column character set.');
            const source = textualAddress ? 'CAST(' + name + ' AS CHAR)' : name;
            value = "CONCAT('CONVERT(X''',HEX(" + source + "),''' USING " + charset + ")')";
          }
          return 'IF(' + name + " IS NULL,'NULL'," + value + ') AS ' + qi('c' + i);
        });
        const prefix =
          'INSERT INTO ' +
          qi(table.name) +
          ' (' +
          writable.map((c) => qi(c.name)).join(',') +
          ') VALUES\n';
        let batch: string[] = [],
          bytes = 0;
        const flush = async () => {
          if (batch.length) {
            await options.write(prefix + batch.join(',\n') + ';\n');
            batch = [];
            bytes = 0;
            options.progress({ tables: completed, rows, currentTable: table.name });
          }
        };
        await run(async () => {
          stream = client
            .query('SELECT ' + expressions.join(',') + ' FROM ' + qi(table.name))
            .stream({ highWaterMark: 16 });
          for await (const row of stream) {
            if (writable.some((_, i) => row['c' + i] === null || row['c' + i] === undefined))
              throw new Error(
                'A database value could not be serialized, possibly because it exceeds max_allowed_packet. No partial file was saved.',
              );
            const value = '(' + writable.map((_, i) => String(row['c' + i])).join(',') + ')';
            if (bytes + Buffer.byteLength(value) > 65536) await flush();
            batch.push(value);
            bytes += Buffer.byteLength(value);
            rows++;
            if (batch.length >= 100) await flush();
          }
          stream = undefined;
          await flush();
        });
      }
      completed++;
      options.progress({ tables: completed, rows, currentTable: table.name });
    }
    await options.write('COMMIT;\n');
    for (const view of views) await ddl(view);
    for (const trigger of initial.filter((d) => d.kind === 'TRIGGER')) await ddl(trigger);
    // MySQL 8's dictionary is transactional too. End the read snapshot before
    // checking the live catalog, otherwise new objects are invisible here.
    await query('ROLLBACK');
    if (lockTables) {
      await query('UNLOCK TABLES');
      await query('SET autocommit=1');
    }
    const finalTables = await objects();
    if (JSON.stringify(tables) !== JSON.stringify(finalTables))
      throw new Error('Database objects changed during export. Retry after schema changes finish.');
    const final = await definitions(finalTables);
    const fingerprint = (all: Definition[]) =>
      JSON.stringify(
        all.map((d) => ({ ...d, sql: d.kind === 'BASE TABLE' ? stableTableDdl(d.sql) : d.sql })),
      );
    if (fingerprint(initial) !== fingerprint(final))
      throw new Error('Database definitions changed during export. No partial file was saved.');
    await options.write('SET foreign_key_checks=1;\n');
  } finally {
    stop();
  }
}
