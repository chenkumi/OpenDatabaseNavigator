import type { Connection } from 'tedious';
import { SocketTimeouts, type IoTimeouts } from '../network/socket-timeouts';

/** Per-instance integration with the pinned Tedious 20 request lifecycle. */
export function sqlServerSocketTimeouts(connection: Connection, options: IoTimeouts) {
  if (!options.readTimeout && !options.writeTimeout) return;
  connection.once('connect', (error) => {
    if (error || !connection.socket) return;
    // Observe the network socket after login. TDS 7.x TLS has an internal
    // duplex pair; its plaintext write callbacks do not measure TCP progress.
    const guard = new SocketTimeouts(connection.socket, options);
    const makeRequest = connection.makeRequest;
    connection.makeRequest = function (request, packetType, payload) {
      if (this.state !== this.STATE.LOGGED_IN || request.canceled)
        return makeRequest.call(this, request, packetType, payload);
      const callback = request.callback;
      const release = guard.begin();
      let resumeRead: (() => void) | undefined;
      const pause = () => {
        resumeRead ??= guard.suspendRead();
      };
      const resume = () => {
        resumeRead?.();
        resumeRead = undefined;
      };
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        release();
        resume();
        request.off('pause', pause);
        request.off('resume', resume);
        connection.off('end', finish);
        request.callback = callback;
      };
      request.on('pause', pause);
      request.on('resume', resume);
      if ('paused' in request && request.paused) pause();
      connection.once('end', finish);
      request.callback = function (...args: Parameters<typeof callback>) {
        // Release before user code can start another request on this socket.
        finish();
        return Reflect.apply(callback, this, args);
      };
      try {
        return makeRequest.call(this, request, packetType, payload);
      } catch (error) {
        finish();
        throw error;
      }
    };
  });
}
