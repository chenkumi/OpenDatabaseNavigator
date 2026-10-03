import { EventEmitter, once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { createServer as createTlsServer, rootCertificates, connect as tlsConnect } from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  SybaseAdapter,
  aseConnectionString,
  type AseDriver,
} from '../src/main/database/adapters/sybase/sybase-adapter';
import { nativeRelay } from '../src/main/database/adapters/network/native-relay';
import { connectionSchema } from '../src/shared/schemas';

const cert = readFileSync(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));
const key = readFileSync(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
const options = { limit: 10, timeout: 3000, readOnly: true };

// This is a simulated native driver speaking a test protocol over real TCP/TLS.
// It verifies application transport/lifecycle, not ASE TDS or SAP ODBC compatibility.
async function fixture(tls = false, writeStall = false, host = 'localhost', trusted = true) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  const statements: string[] = [];
  const accept = (socket: Socket) => {
    let input = '';
    const send = (value: unknown) => socket.write(JSON.stringify(value) + '\n');
    socket.on('data', (chunk) => {
      input += chunk.toString();
      let end: number;
      while ((end = input.indexOf('\n')) >= 0) {
        const sql = JSON.parse(input.slice(0, end)) as string;
        input = input.slice(end + 1);
        statements.push(sql);
        if (sql === 'login') send({ login: true });
        else if (sql.includes('@@version'))
          send({ value: 'Adaptive Server Enterprise/16.0 SP04', name: 'version' });
        else if (sql === 'hang') {
          /* intentionally no response */
        } else if (sql === 'progress') {
          let count = 0;
          const timer = setInterval(() => {
            send(++count < 7 ? { progress: true } : { value: 'done' });
            if (count === 7) {
              clearInterval(timer);
              timers.delete(timer);
            }
          }, 50);
          timers.add(timer);
        } else send({ value: sql });
      }
    });
  };
  const server = tls ? createTlsServer({ cert, key }, accept) : createServer(accept);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  server.listen(0, host === '127.0.0.2' ? host : '127.0.0.1');
  await once(server, 'listening');
  const ports: number[] = [];
  const closed: boolean[] = [];
  const driver: AseDriver = {
    open({ conn_str }, callback) {
      expect(conn_str).toContain('Server={127.0.0.1}');
      expect(conn_str).toContain('HASession=0;RetryCount=0;');
      expect(conn_str).not.toContain('Encryption=ssl');
      const port = Number(/;Port=(\d+);/.exec(conn_str)![1]);
      ports.push(port);
      const index = closed.push(false) - 1;
      const socket = createConnection({ host: '127.0.0.1', port });
      let input = '',
        loggedIn = false;
      let pending: EventEmitter | undefined;
      const session = {
        setUseNumericString() {},
        close(cb: (error?: Error) => void) {
          closed[index] = true;
          socket.destroy();
          cb();
        },
        queryRaw({ query_str }: { query_str: string }) {
          const emitter = new EventEmitter();
          pending = emitter;
          socket.write(JSON.stringify(query_str) + '\n');
          return Object.assign(emitter, {
            pauseQuery() {},
            resumeQuery() {},
            cancelQuery() {
              pending = undefined;
              queueMicrotask(() => emitter.emit('free'));
            },
          });
        },
      };
      socket.on('error', () => {});
      socket.once('connect', () => socket.write('"login"\n'));
      socket.on('data', (chunk) => {
        input += chunk.toString();
        let end: number;
        while ((end = input.indexOf('\n')) >= 0) {
          const data = JSON.parse(input.slice(0, end));
          input = input.slice(end + 1);
          if (data.login) {
            loggedIn = true;
            callback(null, session);
          } else if (!data.progress && pending) {
            const emitter = pending;
            pending = undefined;
            emitter.emit('meta', [{ name: data.name || 'value', sqlType: 'varchar' }]);
            emitter.emit('row');
            emitter.emit('column', 0, data.value);
            emitter.emit('free');
          }
        }
      });
      socket.once('close', () => {
        if (!loggedIn) callback(new Error('Login transport closed.'));
        if (pending) {
          pending.emit('error', new Error('Transport closed.'));
          pending.emit('free');
          pending = undefined;
        }
      });
    },
  };
  let upstreamCount = 0;
  const connector = ((...args: any[]) => {
    const socket = (createConnection as any)(...args) as Socket;
    // Stall actual upstream writes after the dedicated query session logs in.
    if (writeStall && ++upstreamCount === 2) socket.once('data', () => socket.cork());
    return socket;
  }) as typeof createConnection;
  const tlsConnector = ((...args: any[]) => {
    const socket = (tlsConnect as any)(...args);
    if (writeStall && ++upstreamCount === 2) socket.once('data', () => socket.cork());
    return socket;
  }) as typeof tlsConnect;
  const config = {
    ...connectionSchema.parse({
      name: 'ASE I/O fixture',
      engine: 'sybase',
      host,
      port: (server.address() as { port: number }).port,
      tls,
      aseTrustedFile: fileURLToPath(new URL('./fixtures/localhost-test-cert.pem', import.meta.url)),
      readTimeout: 250,
      writeTimeout: 150,
    }),
    id: 'ase-io',
  };
  const adapter = new SybaseAdapter(
    config,
    'secret',
    async () => driver,
    (target, timeouts, fail) =>
      nativeRelay(
        trusted ? target : { ...target, tls: { ca: Buffer.from(rootCertificates[0]) } },
        timeouts,
        fail,
        connector,
        tlsConnector,
      ),
  );
  return {
    adapter,
    statements,
    ports,
    closed,
    async close() {
      await adapter.disconnect();
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const port of ports) {
        const probe = createConnection({ host: '127.0.0.1', port });
        expect((await once(probe, 'error'))[0]).toMatchObject({ code: 'ECONNREFUSED' });
      }
    },
  };
}

it.each([false, true])(
  'ASE relay supports progress, idle heartbeat and isolated read failures (TLS %s)',
  async (tls) => {
    const f = await fixture(tls);
    try {
      await Promise.all([f.adapter.connect(), f.adapter.connect()]);
      expect(f.ports).toHaveLength(1);
      await delay(320);
      await f.adapter.heartbeat(2000);
      expect((await f.adapter.query('progress', [], options)).rows).toEqual([{ value: 'done' }]);
      const stalled = expect(f.adapter.query('hang', [], options)).rejects.toThrow(
        'Network read timed out',
      );
      expect((await f.adapter.query('healthy', [], options)).rows).toEqual([{ value: 'healthy' }]);
      await stalled;
      expect(f.statements.filter((sql) => sql === 'hang')).toHaveLength(1);
      expect((await f.adapter.query('recovered', [], options)).rows).toEqual([
        { value: 'recovered' },
      ]);
      expect(f.closed.slice(1).every(Boolean)).toBe(true);
      expect(new Set(f.ports).size).toBe(f.ports.length);
    } finally {
      await f.close();
    }
  },
);

it.each([false, true])(
  'ASE write deadlines stop the actual upstream and never replay a request (TLS %s)',
  async (tls) => {
    const f = await fixture(tls, true);
    try {
      await expect(f.adapter.query('write-stall', [], options)).rejects.toThrow(
        'Network write timed out',
      );
      expect(f.statements).not.toContain('write-stall');
      expect((await f.adapter.query('next', [], options)).rows).toEqual([{ value: 'next' }]);
    } finally {
      await f.close();
    }
  },
);

it('ASE scripts cannot continue or reconnect a failed session', async () => {
  const f = await fixture();
  try {
    await f.adapter.withScriptSession(async (execute) => {
      await execute('first', new AbortController().signal, 3000);
      await expect(execute('hang', new AbortController().signal, 3000)).rejects.toThrow(
        'Network read timed out',
      );
      await expect(execute('must-not-run', new AbortController().signal, 3000)).rejects.toThrow(
        'Network read timed out',
      );
    });
    expect(f.ports).toHaveLength(2);
    expect(f.statements).not.toContain('must-not-run');
  } finally {
    await f.close();
  }
});

it('ASE TLS checks the original host before sending login credentials', async () => {
  const f = await fixture(true, false, '127.0.0.2');
  try {
    await expect(f.adapter.connect()).rejects.toThrow(/IP.*cert|altnames/i);
    expect(f.statements).toEqual([]);
  } finally {
    await f.close();
  }
});

it('ASE without network deadlines retains native TLS configuration', () => {
  const config = {
    ...connectionSchema.parse({
      name: 'ASE',
      engine: 'sybase',
      tls: true,
      aseTrustedFile: 'roots.pem',
    }),
    id: 'ase',
  };
  expect(aseConnectionString(config)).toContain('Encryption=ssl;TrustedFile={roots.pem};');
  expect(aseConnectionString(config)).not.toContain('RetryCount');
});

it('ASE TLS rejects an untrusted issuer before sending login credentials', async () => {
  const f = await fixture(true, false, 'localhost', false);
  try {
    await expect(f.adapter.connect()).rejects.toThrow(/self.signed|certificate/i);
    expect(f.statements).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(['cancel', 'timeout'])(
  'ASE cleans the relay and late native login after %s',
  async (action) => {
    let complete: Parameters<AseDriver['open']>[1] | undefined;
    let closed = false;
    let port = 0;
    const config = {
      ...connectionSchema.parse({
        name: 'cancel ASE',
        engine: 'sybase',
        readTimeout: 100,
        connectionTimeout: action === 'timeout' ? 100 : 1000,
      }),
      id: 'cancel-ase',
    };
    const adapter = new SybaseAdapter(
      config,
      undefined,
      async () => ({
        open(_options, cb) {
          complete = cb;
        },
      }),
      async (...args) => {
        const relay = await nativeRelay(...args);
        port = relay.port;
        return relay;
      },
    );
    try {
      const result = expect(adapter.connect()).rejects.toThrow(
        action === 'cancel' ? /cancelled/i : /timed out/i,
      );
      await expect.poll(() => !!complete).toBe(true);
      if (action === 'cancel') await adapter.disconnect();
      await result;
      complete!(null, {
        setUseNumericString() {},
        close(cb) {
          closed = true;
          cb();
        },
        queryRaw() {
          throw new Error('Late session must not run queries.');
        },
      });
      await expect.poll(() => closed).toBe(true);
      const probe = createConnection({ host: '127.0.0.1', port });
      expect((await once(probe, 'error'))[0]).toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      await adapter.disconnect();
    }
  },
);
