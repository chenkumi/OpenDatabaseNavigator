import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SybaseAdapter, type AseDriver } from '../src/main/database/adapters/sybase/sybase-adapter';
import { connectionSchema } from '../src/shared/schemas';

function fixture(
  mode: 'rows' | 'hang' | 'missing-free' | 'missing-close' | 'missing-free-close' = 'rows',
  relay = false,
  closeBehavior?: 'free-success' | 'free-error' | 'free-hang' | 'idle-success',
) {
  const queries: string[] = [];
  const pending = new Set<EventEmitter>();
  let closed = 0;
  let cancels = 0;
  const releaseClose: (() => void)[] = [];
  const sessions: { closed: boolean; complete: boolean }[] = [];
  const relays: { closed: boolean; fail: (error: Error) => void }[] = [];
  const driver: AseDriver = {
    open(_options, callback) {
      const record = { closed: false, complete: false };
      const index = sessions.push(record) - 1;
      const jobs: EventEmitter[] = [];
      callback(null, {
        setUseNumericString() {},
        close(cb) {
          closed++;
          record.closed = true;
          if (
            closeBehavior &&
            ((index > 0 && closeBehavior.startsWith('free-')) ||
              (index === 0 && closeBehavior === 'idle-success'))
          ) {
            for (const job of jobs) {
              pending.delete(job);
              job.emit('free');
            }
            if (closeBehavior !== 'free-hang')
              releaseClose.push(() => {
                const error =
                  closeBehavior === 'free-error' ? new Error('Native close failed.') : undefined;
                record.complete = !error;
                cb(error);
              });
            return;
          }
          if (mode !== 'missing-close' && mode !== 'missing-free-close') {
            record.complete = true;
            cb();
          }
        },
        queryRaw({ query_str }) {
          queries.push(query_str);
          const events = new EventEmitter();
          pending.add(events);
          jobs.push(events);
          let paused = false;
          let cancelled = false;
          let freed = false;
          let dispatching = false;
          const free = () => {
            if (!freed) {
              freed = true;
              pending.delete(events);
              events.emit('free');
            }
          };
          const job = Object.assign(events, {
            pauseQuery() {
              paused = true;
            },
            resumeQuery() {
              paused = false;
              if (cancelled) queueMicrotask(free);
            },
            cancelQuery(cb?: (error?: Error) => void) {
              cancels++;
              cancelled = true;
              // Handle release is unsafe until the current row/batch callback unwinds.
              if (!dispatching && mode !== 'missing-free' && mode !== 'missing-free-close')
                queueMicrotask(() => {
                  cb?.(new Error('Operation canceled.'));
                  free();
                });
            },
          });
          queueMicrotask(() => {
            dispatching = true;
            queueMicrotask(() => {
              dispatching = false;
            });
            if (query_str.includes('@@version')) {
              events.emit('meta', [{ name: 'version', sqlType: 'varchar' }]);
              events.emit('row');
              events.emit('column', 0, 'Adaptive Server Enterprise/11.5.1');
              free();
            } else if (mode !== 'hang') {
              events.emit('meta', [{ name: 'n', sqlType: 'numeric' }]);
              for (let n = 1; n <= 8 && !paused && !cancelled; n++) {
                events.emit('row');
                events.emit('column', 0, String(n));
              }
              if (!paused && !cancelled) free();
            }
          });
          return job;
        },
      });
    },
  };
  const config = {
    ...connectionSchema.parse({
      name: 'cancel test',
      engine: 'sybase',
      tls: !relay,
      aseTrustedFile: 'test.pem',
    }),
    id: 'cancel-test',
  };
  const adapter = new SybaseAdapter(
    config,
    undefined,
    async () => driver,
    async (_target, _timeouts, fail) => {
      const record = { closed: false, fail };
      relays.push(record);
      return {
        port: 12345,
        pauseRead() {},
        async close() {
          record.closed = true;
        },
      };
    },
  );
  const options = { limit: 2, timeout: 1000, readOnly: true };
  return {
    adapter,
    options,
    queries,
    sessions,
    relays,
    releaseClose,
    get closed() {
      return closed;
    },
    get cancels() {
      return cancels;
    },
    async cleanup() {
      for (const q of pending) q.emit('free');
      pending.clear();
      await adapter.disconnect();
    },
  };
}

async function within<T>(task: Promise<T>, ms = 200): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Operation remained pending')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

it('native full pages and offsets cancel after the row callback unwinds without replaying SELECT', async () => {
  const f = fixture();
  try {
    for (const offset of [0, 2]) {
      const result = await within(
        f.adapter.query('SELECT n FROM dbo.example', [], { ...f.options, offset }),
      );
      expect(result.rows).toEqual([{ n: String(offset + 1) }, { n: String(offset + 2) }]);
      expect(result.hasMore).toBe(true);
    }
    expect(f.queries.filter((sql) => sql === 'SELECT n FROM dbo.example')).toHaveLength(2);
    expect(f.cancels).toBe(2);
    expect(f.closed).toBe(2);
    await within(f.adapter.disconnect());
    expect(f.closed).toBe(3);
  } finally {
    await f.cleanup();
  }
});

it.each(['abort', 'timeout', 'disconnect'] as const)(
  'native %s releases a non-completing query and settles its caller',
  async (action) => {
    const f = fixture('hang');
    try {
      const controller = new AbortController();
      const task = f.adapter.query('SELECT n FROM dbo.example', [], {
        ...f.options,
        timeout: action === 'timeout' ? 30 : 1000,
        signal: controller.signal,
      });
      const settled = expect(within(task)).rejects.toThrow(
        action === 'timeout' ? /timed out/ : /cancelled/,
      );
      while (!f.queries.includes('SELECT n FROM dbo.example')) await delay(1);
      if (action === 'abort') controller.abort();
      if (action === 'disconnect') await within(f.adapter.disconnect());
      await settled;
      expect(f.cancels).toBe(1);
      expect(f.closed).toBeGreaterThanOrEqual(1);
    } finally {
      await f.cleanup();
    }
  },
);

it('a driver without free returns its captured page only after native session closure is confirmed', async () => {
  const f = fixture('missing-free');
  try {
    const result = await within(
      f.adapter.query('SELECT n FROM dbo.example', [], { ...f.options, timeout: 5000 }),
      3500,
    );
    expect(result.rows).toEqual([{ n: '1' }, { n: '2' }]);
    expect(result.hasMore).toBe(true);
    expect(f.sessions.map((s) => s.complete)).toEqual([false, true]);
    expect(f.cancels).toBe(1);
  } finally {
    await f.cleanup();
  }
});

it('missing free and close callbacks fail within a bound instead of returning unconfirmed data', async () => {
  const f = fixture('missing-free-close');
  try {
    await expect(
      within(
        f.adapter.query('SELECT n FROM dbo.example', [], { ...f.options, timeout: 5000 }),
        3500,
      ),
    ).rejects.toThrow(/release|cleanup/i);
    expect(f.cancels).toBe(1);
    expect(f.closed).toBe(1);
    expect(f.sessions.every((s) => !s.complete)).toBe(true);
  } finally {
    await f.cleanup().catch(() => undefined);
  }
});

it('disconnect cancels a query suspended at connect before it opens a private session', async () => {
  const f = fixture();
  try {
    await f.adapter.connect();
    const task = f.adapter.query('SELECT n FROM dbo.example', [], f.options);
    const cancelled = expect(task).rejects.toThrow(/cancelled/);
    await within(f.adapter.disconnect());
    await cancelled;
    expect(f.queries).toEqual(['SELECT @@version AS version']);
    expect(f.sessions.map((s) => s.closed)).toEqual([true]);
  } finally {
    await f.cleanup();
  }
});

it('disconnect waits for the missing-free private session and relay cleanup, excluding new queries', async () => {
  const f = fixture('missing-free', true);
  try {
    const task = f.adapter.query('SELECT n FROM dbo.example', [], { ...f.options, timeout: 5000 });
    const cancelled = expect(task).rejects.toThrow(/cancelled/);
    while (f.cancels === 0) await delay(1);
    const closing = f.adapter.disconnect();
    await expect(f.adapter.query('SELECT n FROM dbo.example', [], f.options)).rejects.toThrow(
      /disconnecting/,
    );
    await within(closing, 3500);
    await cancelled;
    expect(f.sessions.map((s) => s.closed)).toEqual([true, true]);
    expect(f.relays.map((s) => s.closed)).toEqual([true, true]);
    expect(f.queries.filter((sql) => sql === 'SELECT n FROM dbo.example')).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

it('an idle transport failure closes the anchor and a later explicit query creates a fresh one', async () => {
  const f = fixture('rows', true);
  try {
    await f.adapter.connect();
    f.relays[0].fail(new Error('Idle transport failed.'));
    await expect.poll(() => f.sessions[0].closed).toBe(true);
    expect(f.relays[0].closed).toBe(true);
    await within(f.adapter.query('SELECT n FROM dbo.example', [], f.options));
    expect(f.queries.filter((sql) => sql.includes('@@version'))).toHaveLength(2);
    expect(f.queries.filter((sql) => sql === 'SELECT n FROM dbo.example')).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

it.each(['free-success', 'free-error', 'free-hang'] as const)(
  'free during forced close waits for its %s callback outcome',
  async (behavior) => {
    const f = fixture('missing-free', true, behavior);
    try {
      let settled = false;
      const task = f.adapter.query('SELECT n FROM dbo.example', [], {
        ...f.options,
        timeout: 5000,
      });
      void task.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const outcome = task.then(
        (data) => ({ data, error: undefined }),
        (error) => ({ data: undefined, error }),
      );
      await expect.poll(() => f.sessions[1]?.closed, { timeout: 1800, interval: 10 }).toBe(true);
      await delay(0);
      expect(settled).toBe(false);
      f.releaseClose.shift()?.();
      const result = await within(outcome, 3500);
      if (behavior === 'free-success') {
        expect(result.error).toBeUndefined();
        expect(result.data).toMatchObject({ rows: [{ n: '1' }, { n: '2' }], hasMore: true });
      } else
        expect(result.error?.message).toMatch(
          behavior === 'free-error' ? /Native close failed/ : /cleanup timed out/,
        );
    } finally {
      f.releaseClose.shift()?.();
      await f.cleanup();
    }
  },
);

it('disconnect waits for background idle-anchor close even after the anchor was detached', async () => {
  const f = fixture('rows', true, 'idle-success');
  try {
    await f.adapter.connect();
    f.relays[0].fail(new Error('Idle socket failed.'));
    await expect.poll(() => f.sessions[0].closed).toBe(true);
    let disconnected = false;
    const closing = f.adapter.disconnect().then(() => {
      disconnected = true;
    });
    await delay(0);
    expect(disconnected).toBe(false);
    f.releaseClose.shift()!();
    await within(closing);
    expect(f.sessions[0].complete).toBe(true);
  } finally {
    f.releaseClose.shift()?.();
    await f.cleanup();
  }
});

it('missing close callbacks cannot permanently block successful queries or disconnect', async () => {
  const f = fixture('missing-close');
  try {
    expect(
      (await within(f.adapter.query('SELECT n FROM dbo.example', [], f.options), 3500)).rows,
    ).toHaveLength(2);
    await expect(within(f.adapter.disconnect(), 3500)).rejects.toThrow(/close|cleanup/i);
  } finally {
    await f.cleanup().catch(() => undefined);
  }
});
