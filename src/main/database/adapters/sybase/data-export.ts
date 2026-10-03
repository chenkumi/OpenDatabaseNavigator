import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Connection } from '../../../../shared/types';
import type { SqlExportOptions } from '../../../../shared/sql-export';
import { SQL_FILE_LIMIT } from '../../../../shared/sql-script';
import { nativeRelay } from '../network/native-relay';
import { aseDataRestorePlan, aseDdlSignature } from './export-plan';
import source from './AseDataExport.java?raw';
import { splitSqlScript } from '../../sql-script-parser';
import { sqlTokens, keyword } from '../../object-sql';

type Ddl = (options: SqlExportOptions, filter?: string) => Promise<void>;

export async function aseDataExport(
  connection: Connection,
  password: string | undefined,
  options: SqlExportOptions,
  tools: { java: string; jdbc: string },
  ddl: Ddl,
) {
  const directory = await mkdtemp(join(tmpdir(), 'database-workspace-ase-data-'));
  const controller = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  let relay: Awaited<ReturnType<typeof nativeRelay>> | undefined;
  let completed: Promise<number | null> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    controller.abort();
    child?.kill();
  };
  const abort = () => fail(new Error('SQL export cancelled.'));
  const pulse = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => fail(new Error('ASE export timed out waiting for the JDBC worker.')),
      options.timeout,
    );
  };
  const check = () => {
    if (options.signal.aborted) abort();
    if (failure) throw failure;
  };
  const safe = (message: string) =>
    message.replaceAll(password || '\0', '[REDACTED]').slice(0, 4000);
  options.signal.addEventListener('abort', abort, { once: true });
  let totalBytes = 0;
  const write = async (sql: string) => {
    check();
    totalBytes += Buffer.byteLength(sql);
    if (totalBytes > SQL_FILE_LIMIT) throw new Error('ASE export exceeds the 16 MiB limit.');
    await options.write(sql);
    check();
  };
  const nativeSchema = async (filter?: string) => {
    let text = '';
    await ddl(
      {
        ...options,
        includeData: false,
        signal: controller.signal,
        write: async (chunk) => {
          text += chunk;
        },
        progress: () => {},
      },
      filter,
    );
    check();
    return text;
  };
  try {
    check();
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
    const file = join(directory, 'AseDataExport.java');
    await writeFile(file, source, { encoding: 'utf8', mode: 0o600 });
    const env = { ...process.env };
    for (const name of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'])
      delete env[name];
    child = spawn(
      tools.java,
      [
        '-Dfile.encoding=UTF-8',
        '-Dstdout.encoding=UTF-8',
        '-Dstderr.encoding=UTF-8',
        '--class-path',
        tools.jdbc,
        file,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env },
    );
    const nativeProcess = child;
    completed = new Promise((resolve) => {
      nativeProcess.once('error', (error) =>
        fail(new Error('ASE JDBC worker could not start: ' + error.message)),
      );
      nativeProcess.once('close', resolve);
    });
    nativeProcess.stdin!.on('error', fail);
    let stderr = '';
    nativeProcess.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    const send = (line: string) => {
      check();
      nativeProcess.stdin!.write(line + '\n', 'utf8');
    };
    for (const value of [
      `jdbc:sybase:Tds:127.0.0.1:${relay.port}`,
      connection.username || '',
      password || '',
      connection.database,
    ])
      send(Buffer.from(value).toString('base64'));
    send(String(Math.max(1, Math.min(300, Math.ceil(options.timeout / 1000)))));
    pulse();
    let pending = '',
      phase: 'starting' | 'data' | 'finishing' | 'done' = 'starting';
    let beforeSignature = '',
      after = '',
      tables = 0,
      rows = 0;
    const tableNames = new Set<string>();
    const qualifiedName = (name: string) => {
      const tokens = sqlTokens(name, 'sybase');
      if (tokens.length !== 3 || tokens[1].value !== '.')
        throw new Error('ASE export requires owner-qualified table names.');
      return JSON.stringify([tokens[0].value, tokens[2].value]);
    };
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decode = (value: string) => {
      const buffer = Buffer.from(value, 'base64');
      if (buffer.toString('base64') !== value) throw new Error('Invalid ASE worker encoding.');
      return decoder.decode(buffer);
    };
    for await (const buffer of nativeProcess.stdout!) {
      check();
      pulse();
      if ((buffer as Buffer).some((byte) => byte > 127))
        throw new Error('Invalid ASE worker protocol encoding.');
      pending += (buffer as Buffer).toString('ascii');
      if (pending.length > Math.ceil((SQL_FILE_LIMIT * 4) / 3) + 256)
        throw new Error('ASE worker output exceeds its limit.');
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        // While writing local output or running ddlgen, this JDBC session is
        // intentionally idle. The ddlgen job monitors its own network deadline.
        clearTimeout(timer);
        relay.pauseRead(true);
        if (line.startsWith('ERROR:')) throw new Error(decode(line.slice(6)));
        if (line.startsWith('TABLE:') && phase === 'starting') {
          const name = qualifiedName(decode(line.slice(6)));
          if (tableNames.has(name) || tableNames.size >= 5000)
            throw new Error('Invalid ASE table manifest.');
          tableNames.add(name);
        } else if (/^READY:\d+$/.test(line) && phase === 'starting') {
          tables = Number(line.slice(6));
          if (tables !== tableNames.size) throw new Error('Invalid ASE table count.');
          const full = await nativeSchema();
          const filtered = await nativeSchema('RI,TR');
          const plan = aseDataRestorePlan(full, filtered);
          // Both ddlgen calls and the JDBC catalog must describe the same set.
          const nativeNames = splitSqlScript(full, 'sybase').flatMap((batch) => {
            const tokens = sqlTokens(batch.sql, 'sybase');
            if (!keyword(tokens[0], 'CREATE') || !keyword(tokens[1], 'TABLE')) return [];
            const opening = tokens.findIndex((token) => token.value === '(' && !token.quoted);
            if (opening < 0) throw new Error('Invalid ASE CREATE TABLE definition.');
            return [qualifiedName(batch.sql.slice(tokens[2].start, tokens[opening].start))];
          });
          if (
            nativeNames.length !== tables ||
            new Set(nativeNames).size !== tables ||
            nativeNames.some((name) => !tableNames.has(name))
          )
            throw new Error('ASE native schema and JDBC tables differ.');
          beforeSignature = aseDdlSignature(full);
          after = plan.after;
          await write(plan.before);
          options.progress({ tables, rows: 0 });
          phase = 'data';
          send('DATA');
        } else if (line.startsWith('SQL:') && phase === 'data') {
          await write(decode(line.slice(4)));
          send('ACK');
        } else if (line.startsWith('PROGRESS:') && phase === 'data') {
          const match = /^PROGRESS:(\d+):(\d+):([A-Za-z0-9+/=]*)$/.exec(line);
          if (!match || Number(match[1]) !== tables || Number(match[2]) !== rows + 1)
            throw new Error('Invalid ASE worker progress.');
          rows++;
          options.progress({ tables, rows, currentTable: decode(match[3]) });
        } else if (line === 'DATA_DONE' && phase === 'data') {
          if (aseDdlSignature(await nativeSchema()) !== beforeSignature)
            throw new Error('ASE schema changed during export. No partial file was saved.');
          await write(after);
          phase = 'finishing';
          send('COMMIT');
        } else if (line === 'DONE' && phase === 'finishing') {
          phase = 'done';
          nativeProcess.stdin!.end();
        } else throw new Error('Unexpected ASE JDBC worker output.');
        relay.pauseRead(false);
        pulse();
      }
    }
    const code = await completed;
    check();
    if (code !== 0 || pending || phase !== 'done')
      throw new Error(
        'ASE JDBC export did not complete. Requires JDK 11+ and SAP jconn4.jar. ' + stderr,
      );
    options.progress({ tables, rows });
  } catch (error) {
    fail(error as Error);
    throw new Error(safe(failure!.message));
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    controller.abort();
    child?.kill();
    await relay?.close();
    await completed;
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('database-workspace-ase-data-')
    )
      throw new Error('ASE temporary worker path is outside its expected directory.');
    await rm(directory, { recursive: true, force: true });
  }
}
