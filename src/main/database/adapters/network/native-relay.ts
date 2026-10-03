import { createConnection, createServer, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, checkServerIdentity } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { SocketTimeouts, type IoTimeouts } from './socket-timeouts';
import { EventEmitter } from 'node:events';

type Target = {
  host: string;
  port: number;
  path?: string;
  connectionTimeout: number;
  tls?: { ca: Buffer };
};

/** Loopback transport for a native job/session. Normally passes TLS through;
 * an explicit TLS target instead verifies and encrypts the upstream in Node. */
export async function nativeRelay(
  target: Target,
  timeouts: IoTimeouts,
  fail: (error: Error) => void,
  connect = createConnection,
  connectTls = tlsConnect,
) {
  const sockets = new Set<Socket>();
  const connected = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let paused = false;
  let error: Error | undefined;
  const destroySockets = () => {
    activity.emit('close');
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    connected.clear();
  };
  const failed = (reason: Error) => {
    if (closed || error) return;
    error = reason;
    destroySockets();
    fail(reason);
  };
  // Read inactivity belongs to the native job, which may use several sessions
  // (SMO metadata and its data/lock session). An idle sibling must not time out
  // while another session is making progress. Writes remain per real socket.
  const activity = Object.assign(new EventEmitter(), {
    isPaused: () => paused || [...connected].some((socket) => socket.isPaused()),
    write: (
      send: (done: (error?: Error | null) => void) => boolean,
      _encoding: unknown,
      done?: (error?: Error | null) => void,
    ) => send(done ?? (() => {})),
    destroy(reason?: Error) {
      activity.emit('close');
      if (reason) failed(reason);
    },
  });
  const readClock = new SocketTimeouts(activity, { readTimeout: timeouts.readTimeout });
  const server = createServer({ allowHalfOpen: true }, (local) => {
    if (closed || error) {
      local.destroy();
      return;
    }
    sockets.add(local);
    local.pause();
    // A native TLS verifier can reset loopback deliberately (for example when
    // rejecting a certificate). Let the tool report its own precise error.
    local.on('error', () => {});
    const remote = target.tls
      ? connectTls({
          host: target.host,
          port: target.port,
          ca: target.tls.ca,
          servername: isIP(target.host) ? undefined : target.host,
          checkServerIdentity: (_name, certificate) =>
            checkServerIdentity(target.host, certificate),
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        })
      : target.path
        ? connect({ path: target.path, allowHalfOpen: true })
        : connect({ host: target.host, port: target.port, allowHalfOpen: true });
    sockets.add(remote);
    remote.on('error', failed);
    const timer = setTimeout(
      () => failed(new Error('Native connection timed out.')),
      target.connectionTimeout,
    );
    timers.add(timer);
    const clearConnectTimer = () => {
      clearTimeout(timer);
      timers.delete(timer);
    };
    let release: (() => void) | undefined;
    remote.once(target.tls ? 'secureConnect' : 'connect', () => {
      clearConnectTimer();
      if (closed || error || local.destroyed) {
        remote.destroy();
        return;
      }
      const guard = new SocketTimeouts(remote, { writeTimeout: timeouts.writeTimeout });
      // The native export is the active operation. This includes protocol login;
      // output processing and downstream backpressure suspend its read clock.
      guard.begin();
      connected.add(remote);
      release = readClock.begin();
      remote.once('end', () => {
        release?.();
        connected.delete(remote);
        activity.emit('resume');
      });
      remote.on('data', () => activity.emit('data'));
      remote.on('pause', () => activity.emit('pause'));
      remote.on('resume', () => activity.emit('resume'));
      const write = remote.write;
      remote.write = function (this: Socket, chunk: any, encoding?: any, callback?: any) {
        const cb = typeof encoding === 'function' ? encoding : callback;
        const enc = typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;
        return activity.write(
          (done: (error?: Error | null) => void) => write.call(this, chunk, enc, done),
          undefined,
          cb,
        );
      } as Socket['write'];
      remote.pipe(local);
      local.pipe(remote);
      local.resume();
    });
    const close = () => {
      clearConnectTimer();
      release?.();
      connected.delete(remote);
      activity.emit('resume');
      sockets.delete(local);
      sockets.delete(remote);
      local.destroy();
      remote.destroy();
    };
    local.once('close', close);
    remote.once('close', () => {
      clearConnectTimer();
      release?.();
      connected.delete(remote);
      activity.emit('resume');
      if (remote.readableEnded && !local.writableFinished && !local.destroyed)
        local.once('finish', close);
      else close();
    });
    // Half-close is passed through by pipe; keep the opposite direction alive
    // until its buffered output has been delivered.
  });
  server.maxConnections = 4;
  server.on('error', failed);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (reason) {
    closed = true;
    destroySockets();
    throw reason;
  }
  return {
    port: (server.address() as AddressInfo).port,
    pauseRead(value: boolean) {
      if (paused === value || closed) return;
      paused = value;
      activity.emit(value ? 'pause' : 'resume');
    },
    async close() {
      if (closed) return;
      closed = true;
      destroySockets();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
