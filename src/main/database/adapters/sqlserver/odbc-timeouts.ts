import { AsyncLocalStorage } from 'node:async_hooks';
import type { EventEmitter } from 'node:events';
import type mssql from 'mssql';
import type { Connection } from '../../../../shared/types';
import { nativeRelay } from '../network/native-relay';
import { sqlServerRelayTarget, windowsConnectionString } from './transport';

type NativeRequest = EventEmitter & {
  pauseQuery(): void;
  resumeQuery(): void;
};
type NativeConnection = {
  hasError?: boolean;
  query: (...args: any[]) => NativeRequest;
  queryRaw: (...args: any[]) => NativeRequest;
};
type NativePool = {
  config: { beforeConnect?: (config: { conn_str: string }) => void };
  _poolCreate(): Promise<NativeConnection>;
  _poolDestroy(connection: NativeConnection): Promise<void>;
};

/** Instance hooks for the pinned mssql 12.7 / msnodesqlv8 5.5 bridge.
 * Each physical ODBC session owns its relay, so activity on a sibling cannot
 * mask stalled work. No global socket, driver or prototype is modified. */
export function installOdbcTimeouts(
  connectionPool: mssql.ConnectionPool,
  connection: Connection,
  relayFactory = nativeRelay,
) {
  const target = sqlServerRelayTarget(connection);
  if (!target) return;
  const pool = connectionPool as unknown as NativePool;
  if (typeof pool._poolCreate !== 'function' || typeof pool._poolDestroy !== 'function')
    throw new Error('Unsupported ODBC connection pool lifecycle.');
  const context = new AsyncLocalStorage<number>();
  const relays = new WeakMap<NativeConnection, Awaited<ReturnType<typeof nativeRelay>>>();
  const beforeConnect = pool.config.beforeConnect;
  pool.config.beforeConnect = (config) => {
    beforeConnect?.(config);
    const port = context.getStore();
    if (port === undefined) throw new Error('Missing ODBC transport scope.');
    config.conn_str = windowsConnectionString(connection, port);
  };
  const create = pool._poolCreate;
  pool._poolCreate = async function () {
    let failure: Error | undefined;
    let native: NativeConnection | undefined;
    const requests = new Set<NativeRequest>();
    const relay = await relayFactory(target, connection, (error) => {
      failure ??= error;
      if (native) native.hasError = true;
      // A write can fail even while a consumer has paused. Let the native
      // worker observe the closed socket and finish; never synthesize success.
      for (const request of requests) request.resumeQuery();
    });
    try {
      native = await context.run(relay.port, () => create.call(this));
      if (failure) throw failure;
      relays.set(native, relay);
      relay.pauseRead(true);
      const update = () =>
        relay.pauseRead(requests.size === 0 || [...requests].some((r) => paused.has(r)));
      const paused = new WeakSet<NativeRequest>();
      for (const method of ['query', 'queryRaw'] as const) {
        const original = native[method];
        native[method] = function (...args: any[]) {
          let request: NativeRequest | undefined;
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            if (request) requests.delete(request);
            update();
          };
          const callbackIndex = args.findIndex((value) => typeof value === 'function');
          if (callbackIndex >= 0) {
            const callback = args[callbackIndex];
            args[callbackIndex] = function (
              this: unknown,
              error: unknown,
              rows: unknown,
              more: boolean,
            ) {
              if (!more) finish();
              return callback.call(this, failure ?? error, rows, more);
            };
          }
          relay.pauseRead(false);
          try {
            request = original.apply(this, args);
            if (!finished) requests.add(request);
            request.prependOnceListener('done', finish);
            request.prependOnceListener('free', finish);
            request.prependListener('error', (info) => {
              if (failure && info && typeof info === 'object') {
                info.message = failure.message;
                info.sqlstate = '08S01';
              }
            });
            const pause = request.pauseQuery,
              resume = request.resumeQuery;
            request.pauseQuery = function () {
              paused.add(this);
              update();
              return pause.call(this);
            };
            request.resumeQuery = function () {
              paused.delete(this);
              update();
              return resume.call(this);
            };
            return request;
          } catch (error) {
            finish();
            throw failure ?? error;
          }
        };
      }
      return native;
    } catch (error) {
      await relay.close();
      if (native) await destroy.call(this, native).catch(() => {});
      throw failure ?? error;
    }
  };
  const destroy = pool._poolDestroy;
  pool._poolDestroy = async function (native) {
    const relay = relays.get(native);
    relays.delete(native);
    await relay?.close();
    return destroy.call(this, native);
  };
}
