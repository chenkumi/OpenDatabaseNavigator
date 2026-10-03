import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { Socket } from 'node:net';

const scope = new AsyncLocalStorage<symbol>();
const created = channel('net.client.socket');

/** Identify a driver's private socket without replacing Node's global factory.
 * The subscriber exists only during this connection attempt, and filters by
 * async scope so simultaneous connections cannot acquire each other's socket.
 */
export async function captureClientSocket<T>(connect: () => Promise<T>) {
  const identity = Symbol('client connection');
  const sockets = new Set<Socket>();
  const observe = (message: unknown) => {
    if (scope.getStore() !== identity) return;
    const socket = (message as { socket?: unknown } | null)?.socket;
    if (socket instanceof Socket) sockets.add(socket);
  };
  created.subscribe(observe);
  try {
    const result = await scope.run(identity, connect);
    const live = [...sockets].filter((socket) => !socket.destroyed && socket.writable);
    if (live.length !== 1)
      throw new Error('Could not identify the connection socket for network I/O deadlines.');
    return { result, socket: live[0] };
  } finally {
    created.unsubscribe(observe);
  }
}
