export type ScriptExecute = (sql: string, signal: AbortSignal, timeout: number) => Promise<void>;
/** Bound a native operation. A timeout/abort makes the session unusable. */
export async function scriptDeadline<T>(
  signal: AbortSignal,
  timeout: number,
  cancel: () => void,
  run: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new Error('Script cancelled.');
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    const stop = (message: string) => {
      try {
        cancel();
      } finally {
        reject(new Error(message));
      }
    };
    abort = () => stop('Script cancelled.');
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('Script statement timed out.'), timeout);
  });
  try {
    return await Promise.race([run(), cancelled]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', abort);
  }
}
