import type pg from 'pg';
import type { Socket } from 'node:net';
import type { EventEmitter } from 'node:events';
import { SocketTimeouts, type IoTimeouts } from '../network/socket-timeouts';

type Protocol = EventEmitter & {
  stream: Socket;
  query: (...args: any[]) => any;
  parse: (...args: any[]) => any;
  bind: (...args: any[]) => any;
};
const installed = new WeakSet<pg.Client>();

/** Install after authentication, when pg has selected its final TLS stream. */
export function postgresSocketTimeouts(client: pg.Client, options: IoTimeouts) {
  if ((!options.readTimeout && !options.writeTimeout) || installed.has(client)) return;
  installed.add(client);
  const protocol = (client as unknown as { connection: Protocol }).connection;
  const guard = new SocketTimeouts(protocol.stream, options);
  let release: (() => void) | undefined;
  const done = () => {
    release?.();
    release = undefined;
  };
  // Observe actual protocol dispatch rather than client.query(): queued queries
  // have no network deadline until pg issues them. A cached prepared statement
  // starts with Bind, while a new extended query starts with Parse.
  for (const method of ['query', 'parse', 'bind'] as const) {
    const original = protocol[method];
    protocol[method] = function (...args: any[]) {
      release ??= guard.begin();
      return original.apply(this, args);
    };
  }
  // pg's own ReadyForQuery handler can immediately dispatch the next queued
  // query, so release the preceding deadline before that handler runs.
  protocol.prependListener('readyForQuery', done);
  protocol.once('end', done);
  // pg forwards transport errors to active/queued queries and also emits an
  // error on Client. Checked-out clients have no pool idle-error listener.
  client.on('error', done);
}
