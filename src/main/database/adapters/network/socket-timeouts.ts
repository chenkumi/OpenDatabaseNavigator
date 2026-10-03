import type { EventEmitter } from 'node:events';

export type IoTimeouts = { readTimeout?: number; writeTimeout?: number };
export interface TimeoutTransport extends EventEmitter {
  write: (...args: any[]) => boolean;
  isPaused(): boolean;
  destroy(error?: Error): unknown;
}

/** Per-connection I/O deadlines, independent of a statement's total runtime. */
export class SocketTimeouts {
  private readers = 0;
  private writes = 0;
  private readSuspensions = 0;
  private readTimer?: ReturnType<typeof setTimeout>;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly originalWrite: TimeoutTransport['write'];

  constructor(
    private socket: TimeoutTransport,
    private options: IoTimeouts,
  ) {
    this.originalWrite = socket.write;
    const guard = this;
    socket.write = function (this: TimeoutTransport, chunk: any, encoding?: any, callback?: any) {
      const cb = typeof encoding === 'function' ? encoding : callback;
      const enc = typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;
      const tracked = !guard.closed && guard.readers > 0;
      if (tracked) {
        clearTimeout(guard.readTimer);
        if (guard.writes++ === 0) guard.armWrite();
      }
      let completed = false;
      const finish = (error?: Error | null) => {
        if (completed) return;
        completed = true;
        if (tracked) {
          guard.writes--;
          clearTimeout(guard.writeTimer);
          if (guard.writes) guard.armWrite();
          else guard.armRead();
        }
        cb?.(error);
      };
      try {
        return guard.originalWrite.call(this, chunk, enc, finish);
      } catch (error) {
        if (!completed && tracked) {
          completed = true;
          guard.writes--;
          clearTimeout(guard.writeTimer);
          if (guard.writes) guard.armWrite();
        }
        throw error;
      }
    };
    socket.on('data', this.received);
    socket.on('pause', this.paused);
    socket.on('resume', this.resumed);
    socket.once('close', this.dispose);
  }

  /** Call for an issued operation, and release when all of its results finish. */
  begin() {
    this.readers++;
    this.armRead();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.readers--;
      if (!this.readers) clearTimeout(this.readTimer);
    };
  }

  /** Pause consumption above the socket layer without suspending writes. */
  suspendRead() {
    this.readSuspensions++;
    clearTimeout(this.readTimer);
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.readSuspensions--;
      this.armRead();
    };
  }

  private received = () => this.armRead();
  private paused = () => clearTimeout(this.readTimer);
  private resumed = () => this.armRead();
  private armRead() {
    clearTimeout(this.readTimer);
    if (
      !this.closed &&
      this.readers &&
      !this.writes &&
      !this.readSuspensions &&
      !this.socket.isPaused() &&
      this.options.readTimeout
    ) {
      this.readTimer = setTimeout(() => this.fail('read'), this.options.readTimeout);
      this.readTimer.unref();
    }
  }
  private armWrite() {
    if (!this.closed && this.writes && this.options.writeTimeout) {
      this.writeTimer = setTimeout(() => this.fail('write'), this.options.writeTimeout);
      this.writeTimer.unref();
    }
  }
  private fail(direction: 'read' | 'write') {
    const timeout = direction === 'read' ? this.options.readTimeout : this.options.writeTimeout;
    const error = Object.assign(
      new Error(`Network ${direction} timed out after ${timeout} ms without progress.`),
      {
        code: direction === 'read' ? 'EREADTIMEOUT' : 'EWRITETIMEOUT',
      },
    );
    this.dispose();
    this.socket.destroy(error);
  }
  private dispose = () => {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readTimer);
    clearTimeout(this.writeTimer);
    this.socket.off('data', this.received);
    this.socket.off('pause', this.paused);
    this.socket.off('resume', this.resumed);
    this.socket.off('close', this.dispose);
    this.socket.write = this.originalWrite;
  };
}
