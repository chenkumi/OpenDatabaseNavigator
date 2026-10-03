import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, dirname, resolve } from 'node:path';
import type { Connection } from '../../../../shared/types';
import type { SqlExportOptions } from '../../../../shared/sql-export';
import { SQL_FILE_LIMIT } from '../../../../shared/sql-script';
import { splitSqlScript } from '../../sql-script-parser';
import { sqlTokens, keyword } from '../../object-sql';
import { nativeRelay } from '../network/native-relay';
import { aseDataExport } from './data-export';
import { aseJavaTools, aseToolFile } from './java-tools';

export async function aseExportTools(connection: Connection) {
  return {
    ...(await aseJavaTools(connection)),
    ddlgen: await aseToolFile(connection.aseDdlgenPath, ['ddlgen.jar'], 'SAP DDLGen.jar'),
  };
}

/** Preserve the native script, but reject an unexpected database selection.
 * ddlgen supports wildcard names; a match must never silently export another DB. */
export function validateAseDdl(sql: string, database: string) {
  const batches = splitSqlScript(sql, 'sybase');
  let selected = false,
    tables = 0;
  for (const batch of batches) {
    const tokens = sqlTokens(batch.sql, 'sybase');
    // Stored definitions may contain dynamic SQL or procedure-local identifiers.
    // They remain native text; only top-level batches are scope markers.
    if (
      ['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'VIEW', 'RULE', 'DEFAULT'].some(
        (kind) => keyword(tokens[0], 'CREATE') && keyword(tokens[1], kind),
      )
    )
      continue;
    for (let index = 0; index < tokens.length; index++) {
      if (keyword(tokens[index], 'USE')) {
        const name = tokens[index + 1]?.value;
        if (name !== database && name !== 'master')
          throw new Error('ASE ddlgen returned a different database. No export was saved.');
        if (name === database) selected = true;
      }
      if (
        ['CREATE', 'ALTER', 'DROP'].some((word) => keyword(tokens[index], word)) &&
        keyword(tokens[index + 1], 'DATABASE') &&
        tokens[index + 2]?.value !== database
      )
        throw new Error('ASE ddlgen returned a different database definition.');
      if (keyword(tokens[index], 'CREATE') && keyword(tokens[index + 1], 'TABLE')) tables++;
    }
  }
  if (!selected || !batches.length)
    throw new Error('ASE ddlgen did not return a complete database script.');
  return tables;
}

export async function aseSqlExport(
  connection: Connection,
  password: string | undefined,
  options: SqlExportOptions,
) {
  if (
    !connection.database ||
    ['master', 'model', 'tempdb', 'sybsystemdb', 'sybsystemprocs', 'sybsecurity'].includes(
      connection.database.toLowerCase(),
    )
  )
    throw new Error('Choose an ASE user database to export.');
  for (const value of [connection.database, connection.username || '', password || ''])
    if (/[\r\n\0]/.test(value))
      throw new Error('ASE native export does not accept line breaks or NUL in connection values.');
  if (connection.database.includes('%'))
    throw new Error('ASE ddlgen database wildcards are not allowed.');
  if (options.signal.aborted) throw new Error('SQL export cancelled.');
  const tools = await aseExportTools(connection);
  if (options.includeData)
    return aseDataExport(connection, password, options, tools, (options, filter) =>
      aseDdlExport(connection, password, options, tools, filter),
    );
  return aseDdlExport(connection, password, options, tools);
}

async function aseDdlExport(
  connection: Connection,
  password: string | undefined,
  options: SqlExportOptions,
  tools: Awaited<ReturnType<typeof aseExportTools>>,
  filter?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), 'database-workspace-ase-ddl-'));
  const output = join(directory, 'schema.sql'),
    errors = join(directory, 'errors.log'),
    progress = join(directory, 'progress.log');
  let child: ReturnType<typeof spawn> | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    child?.kill();
  };
  let relay: Awaited<ReturnType<typeof nativeRelay>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let completed: Promise<number | null> | undefined;
  const abort = () => fail(new Error('SQL export cancelled.'));
  const check = () => {
    if (options.signal.aborted) abort();
    if (failure) throw failure;
  };
  const safe = (text: string) => text.replaceAll(password || '\0', '[REDACTED]').slice(0, 4000);
  try {
    if (connection.tls && !connection.aseTrustedFile?.trim())
      throw new Error('ASE TLS requires a PEM CA certificates file.');
    relay = await nativeRelay(
      {
        host: connection.host || 'localhost',
        port: connection.port ?? 5000,
        connectionTimeout: connection.connectionTimeout ?? 10000,
        tls: connection.tls ? { ca: await readFile(connection.aseTrustedFile!) } : undefined,
      },
      connection,
      fail,
    );
    check();
    // Launch the documented Java main class directly: no shell/batch escaping.
    // -Pext consumes the actual password from stdin, never argv or a disk file.
    const env = { ...process.env };
    for (const name of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'])
      delete env[name];
    child = spawn(
      tools.java,
      [
        '-Dfile.encoding=UTF-8',
        '-Dstdout.encoding=UTF-8',
        '-Dstderr.encoding=UTF-8',
        '-cp',
        [tools.ddlgen, tools.jdbc].join(delimiter),
        'com.sybase.ddlgen.DDLGenerator',
        '-U' + (connection.username || ''),
        '-Pext',
        '-S127.0.0.1:' + relay.port,
        '-TDB',
        '-N' + connection.database,
        '-XDE',
        ...(filter ? ['-F' + filter] : []),
        '-CNUMBER=1',
        '-Jutf8',
        '-O' + output,
        '-E' + errors,
        '-L' + progress,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env },
    );
    const nativeProcess = child;
    let stderr = '',
      lastProgress = Date.now(),
      previousSize = '',
      polling = false;
    completed = new Promise((resolve) => {
      nativeProcess.once('error', (error) =>
        fail(new Error('ASE Java tool could not start: ' + safe(error.message))),
      );
      nativeProcess.once('close', resolve);
    });
    nativeProcess.stdin!.on('error', (error) =>
      fail(new Error('ASE tool input failed: ' + safe(error.message))),
    );
    nativeProcess.stdout!.on('data', () => {
      lastProgress = Date.now();
    });
    nativeProcess.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    options.signal.addEventListener('abort', abort, { once: true });
    timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void Promise.all([
        stat(output).catch(() => undefined),
        stat(progress).catch(() => undefined),
        stat(errors).catch(() => undefined),
      ])
        .then(([sql, log, errorLog]) => {
          if (
            (sql?.size || 0) > SQL_FILE_LIMIT ||
            (log?.size || 0) > SQL_FILE_LIMIT ||
            (errorLog?.size || 0) > 65536
          ) {
            fail(new Error('ASE export exceeds the output limit. No partial file was saved.'));
            return;
          }
          const size = [sql?.size, log?.size].join(':');
          if (size !== previousSize) {
            previousSize = size;
            lastProgress = Date.now();
          }
          if (Date.now() - lastProgress > options.timeout)
            fail(new Error('ASE export timed out waiting for ddlgen.'));
        })
        .finally(() => {
          polling = false;
        });
    }, 100);
    check();
    nativeProcess.stdin!.end((password || '') + '\n', 'utf8');
    const code = await completed;
    clearInterval(timer);
    check();
    if (((await stat(errors).catch(() => undefined))?.size ?? 0) > 65536)
      throw new Error('ASE ddlgen diagnostics exceed the output limit.');
    const diagnostics = await readFile(errors).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    });
    if (code !== 0 || diagnostics.length)
      throw new Error(
        'ASE ddlgen failed: ' + safe(diagnostics.toString('utf8') || stderr || `exit ${code}`),
      );
    if (!(await stat(output).catch(() => undefined))?.isFile())
      throw new Error('ASE ddlgen did not create an SQL file.');
    if ((await stat(output)).size > SQL_FILE_LIMIT)
      throw new Error('ASE export exceeds the 16 MiB limit.');
    const sql = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(output));
    const tables = validateAseDdl(sql, connection.database);
    check();
    // No source writes: native output retains CREATE DATABASE / USE / devices.
    // Restoration is explicitly reviewed in Execute SQL file, never auto-run.
    await options.write(sql);
    check();
    options.progress({ tables, rows: 0 });
  } catch (error) {
    throw new Error(safe((error as Error).message));
  } finally {
    clearInterval(timer);
    options.signal.removeEventListener('abort', abort);
    child?.kill();
    await relay?.close();
    await completed;
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('database-workspace-ase-ddl-')
    )
      throw new Error('ASE temporary export path is outside its expected directory.');
    await rm(directory, { recursive: true, force: true });
  }
}
