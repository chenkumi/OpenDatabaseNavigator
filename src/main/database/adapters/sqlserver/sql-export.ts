import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import type { Connection } from '../../../../shared/types';
import type { SqlExportOptions } from '../../../../shared/sql-export';
import source from './sql-export.ps1?raw';
import dataSource from './sql-export-data.ps1?raw';
import { nativeRelay } from '../network/native-relay';
import { sqlServerRelayTarget } from './transport';

export function sqlServerExportRelayTarget(connection: Connection) {
  return sqlServerRelayTarget(connection);
}

export async function findSqlServerPowerShell(explicit?: string) {
  const names = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh'];
  if (explicit) {
    if (!isAbsolute(explicit) || !names.includes(basename(explicit).toLowerCase()))
      throw new Error('Choose an absolute path to PowerShell (powershell.exe or pwsh).');
    if (!(await stat(explicit).catch(() => undefined))?.isFile())
      throw new Error('The configured PowerShell executable does not exist.');
    return explicit;
  }
  const candidates =
    process.platform === 'win32'
      ? [
          join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
        ]
      : [];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute))
    for (const name of names) candidates.push(join(dir, name));
  for (const candidate of candidates)
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  throw new Error(
    'SQL Server SQL export requires PowerShell and the SqlServer module. Install these tools or configure the PowerShell path.',
  );
}

export async function sqlServerSqlExport(
  connection: Connection,
  password: string | undefined,
  options: SqlExportOptions,
) {
  const executable = await findSqlServerPowerShell(connection.sqlServerPowerShellPath);
  if (options.signal.aborted) throw new Error('SQL export cancelled.');
  const target = sqlServerExportRelayTarget(connection);
  let child: ChildProcessWithoutNullStreams | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    child?.kill();
  };
  const relay = target ? await nativeRelay(target, connection, fail) : undefined;
  // Only this bundled script is evaluated. User connection values arrive in a
  // separate JSON stdin record and are assigned with SqlConnectionStringBuilder.
  const bootstrap =
    '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))))';
  if (options.signal.aborted) {
    await relay?.close();
    throw new Error('SQL export cancelled.');
  }
  try {
    child = spawn(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(bootstrap, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (error) {
    await relay?.close();
    throw error;
  }
  let done = false,
    pending = '',
    stderr = '',
    writing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pulse = () => {
    clearTimeout(timer);
    if (!writing)
      timer = setTimeout(
        () => fail(new Error('SQL Server export timed out waiting for the native tool.')),
        options.timeout,
      );
  };
  const abort = () => fail(new Error('SQL export cancelled.'));
  options.signal.addEventListener('abort', abort, { once: true });
  child.stdin.on('error', (error) => fail(error));
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  void completed.catch(() => {});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const decoder = new TextDecoder('utf-8', { fatal: true }),
    sqlDecoder = new TextDecoder('utf-8', { fatal: true });
  const config = {
    host: connection.host,
    port: connection.port ?? 1433,
    username: connection.username ?? '',
    password: password ?? '',
    database: connection.database,
    integrated: connection.sqlServerAuth === 'windows',
    tls: connection.tls,
    connectionTimeout: connection.connectionTimeout ?? 10000,
    includeData: options.includeData,
    timeout: options.timeout,
    relayPort: relay?.port,
    certificateHost: target?.host,
    serverSpn: connection.sqlServerSpn,
  };
  try {
    child.stdin.write(
      Buffer.from(dataSource + '\n' + source, 'utf8').toString('base64') +
        '\n' +
        JSON.stringify(config) +
        '\n',
    );
    pulse();
    if (options.signal.aborted) abort();
    for await (const chunk of child.stdout) {
      writing = true;
      relay?.pauseRead(true);
      clearTimeout(timer);
      if (failure) throw failure;
      pending += decoder.decode(chunk as Buffer, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.error) throw new Error(message.error);
        if (message.chunk !== undefined) {
          if (failure) throw failure;
          await options.write(
            sqlDecoder.decode(Buffer.from(message.chunk, 'base64'), { stream: true }),
          );
          child.stdin.write('ACK\n');
        } else if (message.progress) options.progress(message.progress);
        else if (message.done) done = true;
        else throw new Error('Unexpected SQL Server export response.');
      }
      if (pending.length > 128 * 1024)
        throw new Error('Invalid SQL Server export protocol message.');
      writing = false;
      relay?.pauseRead(false);
      pulse();
    }
    decoder.decode();
    sqlDecoder.decode();
    const code = await completed;
    if (failure) throw failure;
    if (code !== 0 || !done || pending.trim())
      throw new Error(
        'SQL Server export failed: ' + stderr.replaceAll(password || '\0', '[redacted]').trim(),
      );
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
