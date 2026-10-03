import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { stat, readdir } from 'node:fs/promises';
import { delimiter, isAbsolute, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Connection } from '../../../../shared/types';
import type { SqlExportOptions } from '../../../../shared/sql-export';
import { SQL_FILE_LIMIT } from '../../../../shared/sql-script';
import { nativeRelay } from '../network/native-relay';

export async function findPgDump(explicit?: string): Promise<string> {
  const executable = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
  if (explicit) {
    if (!isAbsolute(explicit) || basename(explicit).toLowerCase() !== executable)
      throw new Error('Choose an absolute path to the pg_dump executable.');
    if (!(await stat(explicit).catch(() => undefined))?.isFile())
      throw new Error('The configured pg_dump executable does not exist.');
    return explicit;
  }
  const candidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(isAbsolute)
    .map((dir) => join(dir, executable));
  const roots =
    process.platform === 'win32'
      ? [
          join(
            process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files',
            'PostgreSQL',
          ),
        ]
      : process.platform === 'darwin'
        ? ['/Library/PostgreSQL', '/Applications/Postgres.app/Contents/Versions']
        : ['/usr/lib/postgresql'];
  for (const root of roots) {
    const versions = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter(
      (item) => item.isDirectory() && /^\d+(?:\.\d+)?$/.test(item.name),
    );
    versions.sort((a, b) => Number(b.name) - Number(a.name));
    candidates.push(...versions.map((version) => join(root, version.name, 'bin', executable)));
  }
  if (process.platform === 'darwin')
    candidates.push('/opt/homebrew/bin/pg_dump', '/usr/local/bin/pg_dump');
  for (const path of new Set(candidates))
    if ((await stat(path).catch(() => undefined))?.isFile()) return path;
  throw new Error(
    'PostgreSQL SQL export requires pg_dump. Install PostgreSQL client tools or set the pg_dump path in this connection.',
  );
}

export function pgDumpEnvironment(connection: Connection, password?: string) {
  const env = { ...process.env };
  // libpq service/options/passfile variables must not silently redirect a saved
  // connection or run session options from the desktop process environment.
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('PG')) delete env[key];
  env.PGSSLMODE = connection.tls ? 'verify-full' : 'disable';
  env.PGCONNECT_TIMEOUT = String(
    Math.max(1, Math.ceil((connection.connectionTimeout ?? 10000) / 1000)),
  );
  env.PGPASSFILE = join(tmpdir(), 'dw-unused-pgpass-' + randomBytes(24).toString('hex'));
  if (password !== undefined) env.PGPASSWORD = password;
  env.LC_ALL = 'C';
  return env;
}

/** Explicit conninfo prevents db names containing '=' from being interpreted as
 * caller-supplied libpq options. The password is never an argv parameter. */
export function pgDumpConnectionString(connection: Connection, relayPort?: number) {
  const quote = (value: string) => {
    if (value.includes('\0')) throw new Error('Invalid PostgreSQL connection value.');
    return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
  };
  return [
    ['host', connection.host || 'localhost'],
    ['port', String(relayPort ?? connection.port ?? 5432)],
    ...(relayPort ? [['hostaddr', '127.0.0.1']] : []),
    ['user', connection.username || ''],
    // Same default as the regular connection, instead of libpq's user-name database.
    ['dbname', connection.database || 'postgres'],
  ]
    .map(([key, value]) => key + '=' + quote(value))
    .join(' ');
}

async function probe(path: string, args: string[], signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('SQL export cancelled.');
  const child = spawn(path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '',
    failure: Error | undefined;
  const stop = () => {
    failure = new Error('SQL export cancelled.');
    child.kill();
  };
  const timer = setTimeout(() => {
    failure = new Error('pg_dump did not respond.');
    child.kill();
  }, 5000);
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await new Promise((resolve, reject) => {
      const collect = (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (Buffer.byteLength(text) > 128 * 1024) {
          failure = new Error('Invalid pg_dump tool output.');
          child.kill();
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', reject);
      child.once('close', (code) =>
        failure
          ? reject(failure)
          : code === 0
            ? resolve(text)
            : reject(new Error('Could not run pg_dump.')),
      );
      if (signal.aborted) stop();
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

export async function postgresSqlExport(
  connection: Connection,
  password: string | undefined,
  options: SqlExportOptions,
) {
  const path = await findPgDump(connection.pgDumpPath);
  const version = await probe(path, ['--version'], options.signal);
  if (!/^pg_dump \(PostgreSQL\) \d+/m.test(version))
    throw new Error('The selected program is not PostgreSQL pg_dump.');
  const help = await probe(path, ['--help'], options.signal);
  const key = randomBytes(32).toString('hex');
  const restrict = help.includes('--restrict-key');
  // Validate before opening the listener so malformed conninfo cannot leak it.
  pgDumpConnectionString(connection);
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    child?.kill();
  };
  const relay =
    connection.readTimeout || connection.writeTimeout
      ? await nativeRelay(
          {
            host: connection.host || 'localhost',
            port: connection.port ?? 5432,
            path: connection.host?.startsWith('/')
              ? `${connection.host}/.s.PGSQL.${connection.port ?? 5432}`
              : undefined,
            connectionTimeout: connection.connectionTimeout ?? 10000,
          },
          connection,
          fail,
        )
      : undefined;
  const args = [
    '--format=plain',
    '--encoding=UTF8',
    '--quote-all-identifiers',
    '--column-inserts',
    '--rows-per-insert=100',
    '--no-password',
    '--verbose',
    '--no-publications',
    '--no-subscriptions',
    '--lock-wait-timeout=' + options.timeout + 'ms',
    '--dbname=' + pgDumpConnectionString(connection, relay?.port),
  ];
  if (!options.includeData) args.push('--schema-only');
  if (restrict) args.push('--restrict-key=' + key);
  if (options.signal.aborted) {
    await relay?.close();
    throw new Error('SQL export cancelled.');
  }
  try {
    child = spawn(path, args, {
      windowsHide: true,
      env: pgDumpEnvironment(connection, password),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    await relay?.close();
    throw error;
  }
  let stderr = '',
    currentTable: string | undefined,
    tables = 0,
    processing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pulse = () => {
    clearTimeout(timer);
    if (!processing)
      timer = setTimeout(
        () => fail(new Error('pg_dump timed out waiting for database output.')),
        options.timeout,
      );
  };
  const abort = () => fail(new Error('SQL export cancelled.'));
  options.signal.addEventListener('abort', abort, { once: true });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  // Observe early process errors while stdout is consumed with backpressure.
  void completed.catch(() => {});
  let diagnosticLine = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-65536);
    diagnosticLine += chunk;
    const lines = diagnosticLine.split('\n');
    diagnosticLine = lines.pop()!.slice(-8192);
    for (const line of lines) {
      const created = /creating TABLE "(.*)"\r?$/.exec(line);
      const reading = /(?:dumping contents of table|processing data for table) "(.*)"\r?$/.exec(
        line,
      );
      if (created || reading) {
        if (created) tables++;
        currentTable = (reading ?? created)![1];
        try {
          options.progress({ tables, rows: options.includeData ? null : 0, currentTable });
        } catch (error) {
          fail(error as Error);
        }
      }
    }
    pulse();
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    guards = 0;
  const writeLine = async (line: string) => {
    if (failure) throw failure;
    const value = line.replace(/\r?\n$/, '');
    if (restrict && (value === '\\restrict ' + key || value === '\\unrestrict ' + key)) {
      guards++;
      return;
    }
    // Windows pg_dump writes stdout in CRT text mode: every LF receives an
    // additional CR, including inside SQL literals. Undo exactly that transport
    // conversion (CRCRLF becomes CRLF); the SQL importer preserves literal bytes.
    await options.write(process.platform === 'win32' ? line.replace(/\r\n$/, '\n') : line);
  };
  try {
    options.progress({ tables: 0, rows: options.includeData ? null : 0 });
    pulse();
    if (options.signal.aborted) abort();
    for await (const chunk of child.stdout) {
      processing = true;
      relay?.pauseRead(true);
      clearTimeout(timer);
      if (failure) throw failure;
      pending += decoder.decode(chunk as Buffer, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        await writeLine(line);
      }
      if (Buffer.byteLength(pending) > SQL_FILE_LIMIT)
        throw new Error('SQL export exceeds the 16 MiB SQL-file limit.');
      processing = false;
      relay?.pauseRead(false);
      pulse();
    }
    processing = true;
    relay?.pauseRead(true);
    clearTimeout(timer);
    pending += decoder.decode();
    if (pending) await writeLine(pending);
    processing = false;
    relay?.pauseRead(false);
    pulse();
    const code = await completed;
    if (failure) throw failure;
    if (code !== 0) throw new Error('pg_dump failed: ' + stderr.trim().slice(-8192));
    if (restrict && guards !== 2) throw new Error('Unexpected pg_dump restriction markers.');
    options.progress({ tables, rows: options.includeData ? null : 0, currentTable });
  } catch (error) {
    fail(error as Error);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    child.kill();
    await relay?.close();
    await completed.catch(() => {});
  }
}
