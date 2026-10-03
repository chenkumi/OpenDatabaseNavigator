import { it, expect } from 'vitest';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { connect as tlsConnect, createServer as tlsServer } from 'node:tls';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeRelay } from '../src/main/database/adapters/network/native-relay';

async function listen(server: Server) {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as { port: number }).port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const target = (port: number) => ({ host: '127.0.0.1', port, connectionTimeout: 1000 });

it('shares read progress across native sessions without an idle sibling timing out', async () => {
  const server = createServer();
  const remote = await listen(server);
  const peers: Socket[] = [];
  server.on('connection', (socket) => peers.push(socket));
  const errors: Error[] = [];
  const relay = await nativeRelay(target(remote.port), { readTimeout: 180 }, (e) => errors.push(e));
  const clients = [0, 1].map(() => createConnection({ host: '127.0.0.1', port: relay.port }));
  clients.forEach((socket) => {
    socket.on('error', () => {});
    socket.resume();
  });
  try {
    await expect.poll(() => peers.length).toBe(2);
    for (let i = 0; i < 8; i++) {
      peers[1].write('one session is active');
      await delay(40);
    }
    expect(errors).toEqual([]);
    expect(clients.every((client) => !client.destroyed)).toBe(true);
    await expect.poll(() => errors[0]?.message).toContain('Network read timed out');
  } finally {
    clients.forEach((socket) => socket.destroy());
    await relay.close();
    await remote.close();
  }
});

it('forwards progressive native traffic and suspends read deadlines during output processing', async () => {
  const server = createServer();
  const remote = await listen(server);
  let fail!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => (fail = resolve));
  const relay = await nativeRelay(target(remote.port), { readTimeout: 180 }, fail);
  const accepted = once(server, 'connection');
  const client = createConnection({ host: '127.0.0.1', port: relay.port });
  client.on('error', () => {});
  try {
    const [peer] = (await accepted) as [Socket];
    for (let index = 0; index < 6; index++) {
      const received = once(client, 'data');
      peer.write('progress');
      expect((await received)[0].toString()).toBe('progress');
      await delay(40);
    }
    relay.pauseRead(true);
    await delay(220);
    expect(client.destroyed).toBe(false);
    relay.pauseRead(false);
    expect(await failed).toMatchObject({ code: 'EREADTIMEOUT' });
  } finally {
    client.destroy();
    await relay.close();
    await remote.close();
  }
});

it('applies write deadlines to the actual upstream socket, not the loopback sender', async () => {
  const remote = await listen(createServer());
  let fail!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => (fail = resolve));
  const connector = ((...args: any[]) => {
    const socket = (createConnection as any)(...args) as Socket;
    socket.once('connect', () => socket.cork());
    return socket;
  }) as typeof createConnection;
  const relay = await nativeRelay(target(remote.port), { writeTimeout: 100 }, fail, connector);
  const client = createConnection({ host: '127.0.0.1', port: relay.port });
  client.on('error', () => {});
  try {
    await once(client, 'connect');
    client.write('native query bytes');
    expect(await failed).toMatchObject({ code: 'EWRITETIMEOUT' });
  } finally {
    client.destroy();
    await relay.close();
    await remote.close();
  }
});

it('preserves half-close output and removes its listener when the export ends', async () => {
  const payload = Buffer.alloc(256 * 1024, 0xa5);
  const server = createServer({ allowHalfOpen: true }, (peer) => {
    peer.resume();
    peer.on('end', () => peer.end(payload));
  });
  const remote = await listen(server);
  const errors: Error[] = [];
  const relay = await nativeRelay(target(remote.port), { readTimeout: 500 }, (e) => errors.push(e));
  const client = createConnection({ host: '127.0.0.1', port: relay.port });
  client.on('error', () => {});
  try {
    const received: Buffer[] = [];
    client.on('data', (chunk) => received.push(Buffer.from(chunk)));
    const ended = once(client, 'end');
    client.end('request');
    await ended;
    expect(Buffer.concat(received)).toEqual(payload);
    expect(errors).toEqual([]);
    await relay.close();
    const probe = createConnection({ host: '127.0.0.1', port: relay.port });
    expect((await once(probe, 'error'))[0]).toMatchObject({ code: 'ECONNREFUSED' });
  } finally {
    client.destroy();
    await relay.close();
    await remote.close();
  }
});

it('passes TLS end to end with certificate validation and monitors encrypted transport', async () => {
  const cert = readFileSync(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));
  const key = readFileSync(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
  const server = tlsServer({ cert, key }, (socket) =>
    socket.on('data', (data) => socket.write(data)),
  );
  const remote = await listen(server);
  let fail!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => (fail = resolve));
  const relay = await nativeRelay(target(remote.port), { readTimeout: 250 }, fail);
  const client = tlsConnect({
    host: '127.0.0.1',
    port: relay.port,
    servername: 'localhost',
    ca: cert,
  });
  client.on('error', () => {});
  try {
    await once(client, 'secureConnect');
    expect(client.authorized).toBe(true);
    const received = once(client, 'data');
    client.write('encrypted payload');
    expect((await received)[0].toString()).toBe('encrypted payload');
    expect(await failed).toMatchObject({ code: 'EREADTIMEOUT' });
  } finally {
    client.destroy();
    await relay.close();
    await remote.close();
  }
});
