import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from '../../../../shared/types';
import { ASE_ENCODINGS } from '../../../../shared/client-encodings';
import type { AseSession } from './sybase-adapter';
import { aseJavaTools } from './java-tools';
import { nativeRelay } from '../network/native-relay';
import { sqlTokens, keyword } from '../../object-sql';
import source from './AseQuerySession.java?raw';

const MAX_FRAME = 16 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encodeText = (value: string) => {
  const bytes = Buffer.from(value);
  if (decoder.decode(bytes) !== value) throw new Error('Invalid Unicode in ASE input.');
  return bytes.toString('base64');
};
const decodeBytes = (value: string) => {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid ASE JDBC base64.');
  return bytes;
};
const decodeText = (value: string) => decoder.decode(decodeBytes(value));

export function aseJdbcParameter(value: unknown): string {
  if (value === null || value === undefined) return 'N';
  if (typeof value === 'string') return 'S' + encodeText(value);
  if (typeof value === 'boolean') return value ? 'B1' : 'B0';
  if (typeof value === 'number' && Number.isFinite(value)) return 'D' + String(value);
  if (typeof value === 'bigint') return 'D' + String(value);
  if (Buffer.isBuffer(value)) return 'X' + value.toString('base64');
  if (value instanceof Date && Number.isFinite(value.getTime())) return 'T' + value.toISOString();
  throw new Error('Unsupported ASE JDBC parameter value.');
}

/** One worker per physical session, including idle anchors. No implicit retries. */
export async function openAseJdbcSession(
  connection: Connection,
  password: string | undefined,
  timeout: number,
  signal?: AbortSignal,
  relayFactory = nativeRelay,
): Promise<AseSession> {
  if (!ASE_ENCODINGS.some((item) => item.value === connection.charset))
    throw new Error('Unsupported ASE JDBC character set.');
  const deadline = Date.now() + timeout;
  const check = () => {
    if (signal?.aborted) throw new Error('ASE connection cancelled.');
    if (Date.now() >= deadline) throw new Error('ASE JDBC connection timed out.');
  };
  check();
  const tools = await aseJavaTools(connection);
  check();
  const directory = await mkdtemp(join(tmpdir(), 'database-workspace-ase-session-'));
  let child: ReturnType<typeof spawn> | undefined;
  let relay: Awaited<ReturnType<typeof nativeRelay>> | undefined;
  let childClosed: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let query: EventEmitter | undefined;
  let ready = false,
    stopped = false,
    paused = false,
    acknowledgement = false;
  let failure: Error | undefined;
  let rejectOpen: ((error: Error) => void) | undefined;
  let resolveOpen: (() => void) | undefined;
  const safe = (error: unknown) =>
    new Error(
      String(error instanceof Error ? error.message : error)
        .replaceAll(password || '\0', '[REDACTED]')
        .slice(0, 4000),
    );
  const close = (error?: unknown): Promise<void> => {
    if (error) failure ??= safe(error);
    if (cleanup) return cleanup;
    stopped = true;
    // Defer until cleanup is assigned, including reentrant child/relay events.
    cleanup = Promise.resolve()
      .then(async () => {
        child?.kill();
        await relay?.close();
        await childClosed;
        // directory is the exact mkdtemp result created by this invocation.
        await rm(directory, { recursive: true, force: true });
      })
      .finally(() => {
        if (!ready) rejectOpen?.(failure ?? new Error('ASE JDBC session closed during login.'));
        const active = query;
        query = undefined;
        if (active) {
          if (failure) active.emit('error', failure);
          active.emit('free');
        }
      });
    return cleanup;
  };
  const fail = (error: unknown) => {
    void close(error).catch(() => {});
  };
  const send = (fields: string[]) => {
    if (stopped) throw failure ?? new Error('ASE JDBC session is closed.');
    const bytes = Buffer.from(fields.join('\t'), 'ascii');
    if (!bytes.length || bytes.length > MAX_FRAME)
      throw new Error('ASE JDBC request exceeds 16 MiB.');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    child!.stdin!.write(Buffer.concat([header, bytes]));
  };
  const acknowledge = () => {
    if (acknowledgement && !paused && !stopped) {
      acknowledgement = false;
      relay!.pauseRead(false);
      send(['A']);
    }
  };
  const session: AseSession = {
    boundedReads: true,
    setUseNumericString() {
      /* All JDBC exact numbers are already decimal strings. */
    },
    close(callback) {
      void close().then(
        () => callback(),
        (error) => callback(safe(error)),
      );
    },
    queryRaw(request, params) {
      if (stopped) throw failure ?? new Error('ASE JDBC session is closed.');
      if (query) throw new Error('ASE JDBC session is already executing a statement.');
      if (params.length > 5000) throw new Error('ASE JDBC allows at most 5000 parameters.');
      const tokens = sqlTokens(request.query_str, 'sybase');
      if (
        tokens.some(
          (token, index) => keyword(token, 'SET') && keyword(tokens[index + 1], 'CHAR_CONVERT'),
        )
      )
        throw new Error(
          'Change the ASE connection character set and reconnect instead of SET CHAR_CONVERT.',
        );
      const fields = [
        request.query_mode === 'script' ? 'S' : request.query_mode === 'verify' ? 'V' : 'Q',
        String(request.query_timeout),
        String(request.query_max_rows ?? 0),
        encodeText(request.query_str),
        String(params.length),
        ...params.map(aseJdbcParameter),
      ];
      if (fields.reduce((size, value) => size + value.length + 1, 0) > MAX_FRAME)
        throw new Error('ASE JDBC request exceeds 16 MiB.');
      const active = new EventEmitter();
      query = active;
      paused = false;
      acknowledgement = false;
      queueMicrotask(() => {
        if (stopped) return;
        try {
          relay!.pauseRead(false);
          send(fields);
        } catch (error) {
          fail(error);
        }
      });
      return Object.assign(active, {
        pauseQuery() {
          paused = true;
          relay?.pauseRead(true);
        },
        resumeQuery() {
          paused = false;
          try {
            acknowledge();
          } catch (error) {
            fail(error);
          }
        },
        cancelQuery(callback?: (error?: Error) => void) {
          void close().then(
            () => callback?.(),
            (error) => callback?.(safe(error)),
          );
        },
      });
    },
  };
  let columns = 0;
  const count = (value: string, maximum = 10000) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum)
      throw new Error('Invalid ASE JDBC count.');
    return Number(value);
  };
  const message = (bytes: Buffer) => {
    if (bytes.some((value) => value > 127)) throw new Error('Invalid ASE JDBC frame encoding.');
    const fields = bytes.toString('ascii').split('\t');
    if (!ready) {
      if (fields.length === 2 && fields[0] === 'E') throw new Error(decodeText(fields[1]));
      if (fields.length !== 1 || fields[0] !== 'READY')
        throw new Error('Invalid ASE JDBC startup response.');
      ready = true;
      relay!.pauseRead(true);
      resolveOpen!();
      return;
    }
    const active = query;
    if (!active) throw new Error('Unexpected ASE JDBC message without a query.');
    switch (fields[0]) {
      case 'M': {
        columns = count(fields[1]);
        if (!columns || fields.length !== 2 + columns * 2)
          throw new Error('Invalid ASE JDBC metadata.');
        active.emit(
          'meta',
          Array.from({ length: columns }, (_, index) => ({
            name: decodeText(fields[2 + index * 2]),
            sqlType: fields[3 + index * 2],
          })),
        );
        break;
      }
      case 'R': {
        if (
          !columns ||
          count(fields[1]) !== columns ||
          fields.length !== columns + 2 ||
          acknowledgement
        )
          throw new Error('Invalid ASE JDBC row.');
        const values = fields.slice(2).map((value) => {
          if (value === 'N') return null;
          if (value === 'B0' || value === 'B1') return value === 'B1';
          if (value.startsWith('S')) return decodeText(value.slice(1));
          if (value.startsWith('X')) return decodeBytes(value.slice(1));
          if (
            /^D-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) &&
            Number.isFinite(Number(value.slice(1)))
          )
            return Number(value.slice(1));
          throw new Error('Invalid ASE JDBC cell.');
        });
        acknowledgement = true;
        relay!.pauseRead(true);
        active.emit('row');
        values.forEach((value, index) => active.emit('column', index, value));
        acknowledge();
        break;
      }
      case 'U':
        if (fields.length !== 2) throw new Error('Invalid ASE JDBC row count.');
        active.emit('rowcount', count(fields[1], Number.MAX_SAFE_INTEGER));
        break;
      case 'E':
        if (fields.length !== 2) throw new Error('Invalid ASE JDBC error.');
        active.emit('error', safe(decodeText(fields[1])));
        break;
      case 'F':
        if (fields.length !== 1 || acknowledgement) throw new Error('Invalid ASE JDBC completion.');
        query = undefined;
        columns = 0;
        relay!.pauseRead(true);
        active.emit('free');
        break;
      default:
        throw new Error('Unknown ASE JDBC message.');
    }
  };
  try {
    check();
    if (connection.tls && !connection.aseTrustedFile?.trim())
      throw new Error('ASE JDBC TLS requires a PEM CA certificates file.');
    relay = await relayFactory(
      {
        host: connection.host || 'localhost',
        port: connection.port ?? 5000,
        connectionTimeout: Math.max(1, deadline - Date.now()),
        tls: connection.tls ? { ca: await readFile(connection.aseTrustedFile!) } : undefined,
      },
      connection,
      fail,
    );
    check();
    const file = join(directory, 'AseQuerySession.java');
    await writeFile(file, source, { encoding: 'utf8', mode: 0o600 });
    check();
    const env = { ...process.env };
    for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'])
      delete env[key];
    child = spawn(tools.java, ['-Dfile.encoding=UTF-8', '--class-path', tools.jdbc, file], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const worker = child;
    let stderr = '';
    childClosed = new Promise<void>((resolve) =>
      worker.once('close', () => {
        resolve();
        if (!stopped) fail(new Error('ASE JDBC worker exited unexpectedly. ' + stderr));
      }),
    );
    worker.once('error', fail);
    worker.stdin!.on('error', fail);
    worker.stderr!.on('data', (buffer: Buffer) => {
      stderr = (stderr + buffer.toString('utf8')).slice(-4096);
    });
    const header = Buffer.alloc(4);
    let headerUsed = 0,
      body: Buffer | undefined,
      bodyUsed = 0;
    worker.stdout!.on('data', (chunk: Buffer) => {
      try {
        let offset = 0;
        while (offset < chunk.length && !stopped) {
          if (!body) {
            const length = Math.min(4 - headerUsed, chunk.length - offset);
            chunk.copy(header, headerUsed, offset, offset + length);
            headerUsed += length;
            offset += length;
            if (headerUsed !== 4) continue;
            const size = header.readUInt32BE();
            if (!size || size > MAX_FRAME) throw new Error('ASE JDBC frame exceeds 16 MiB.');
            body = Buffer.allocUnsafe(size);
            bodyUsed = 0;
            headerUsed = 0;
          }
          const length = Math.min(body.length - bodyUsed, chunk.length - offset);
          chunk.copy(body, bodyUsed, offset, offset + length);
          bodyUsed += length;
          offset += length;
          if (bodyUsed === body.length) {
            const complete = body;
            body = undefined;
            message(complete);
          }
        }
      } catch (error) {
        fail(error);
      }
    });
    await new Promise<void>((resolve, reject) => {
      const abort = () => fail(new Error('ASE JDBC connection cancelled.'));
      const timer = setTimeout(
        () => fail(new Error('ASE JDBC connection timed out.')),
        Math.max(1, deadline - Date.now()),
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      resolveOpen = () => finish();
      rejectOpen = finish;
      signal?.addEventListener('abort', abort, { once: true });
      try {
        check();
        send([
          'I',
          encodeText(`jdbc:sybase:Tds:127.0.0.1:${relay!.port}`),
          encodeText(connection.username || ''),
          encodeText(password || ''),
          encodeText(connection.database || 'master'),
          connection.charset!,
          String(Math.max(1, Math.ceil((deadline - Date.now()) / 1000))),
        ]);
      } catch (error) {
        fail(error);
      }
    });
    return session;
  } catch (error) {
    await close(error);
    throw safe(error);
  }
}
