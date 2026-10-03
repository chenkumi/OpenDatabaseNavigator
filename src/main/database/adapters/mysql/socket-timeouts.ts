import type mysql from 'mysql2';
import type { Socket } from 'node:net';
import { SocketTimeouts, type IoTimeouts } from '../network/socket-timeouts';

const installed = new WeakSet<mysql.Connection>();
export function mysqlSocketTimeouts(client: mysql.Connection, options: IoTimeouts) {
  if ((!options.readTimeout && !options.writeTimeout) || installed.has(client)) return;
  installed.add(client);
  const query = client.query;
  let failure: Error | undefined;
  const pending = new Map<mysql.Query, () => void>();
  client.on('error', (error) => {
    failure ??= error;
    // mysql2 reports transport failures on Connection, while event-based
    // Query objects only receive SQL errors. Forward the former as well.
    for (const [result, release] of [...pending]) {
      release();
      if (!(result as unknown as { onResult?: unknown }).onResult) result.emit('error', error);
    }
  });
  let socket: Socket | undefined, guard: SocketTimeouts | undefined;
  client.query = function (this: mysql.Connection, ...args: any[]) {
    if (failure) throw failure;
    // mysql2 replaces stream with TLSSocket after the handshake. Resolve the
    // current transport here, after authentication and before each command.
    const current = (client as unknown as { stream: Socket }).stream;
    if (socket !== current) {
      socket = current;
      guard = new SocketTimeouts(socket, options);
    }
    const stop = guard!.begin();
    let result: mysql.Query | undefined;
    const release = () => {
      stop();
      if (result) {
        pending.delete(result);
        result.off('end', release);
        result.off('error', release);
      }
    };
    try {
      result = (query as (...args: any[]) => mysql.Query).apply(this, args);
      pending.set(result, release);
      result.once('end', release);
      result.once('error', release);
      return result;
    } catch (error) {
      release();
      throw error;
    }
  } as mysql.Connection['query'];
}
