import { spawn } from 'node:child_process';
import { scriptDeadline, type ScriptExecute } from '../../script-session';

// Terminating a JS worker cannot interrupt SQLite while it is in a native call.
// A script owns this process and file handle, so cancellation can kill the call.
const source = String.raw`
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
process.on('message', message => {
  try {
    if(message.close) { db.close(); process.exit(0); }
    db.exec(message.sql);
    process.send({id:message.id});
  } catch(error) { process.send({id:message.id,error:error.message}); }
});
process.send({ready:true});
`;
export async function sqliteScriptSession<T>(
  file: string,
  task: (execute: ScriptExecute) => Promise<T>,
): Promise<T> {
  if (file === ':memory:') throw new Error('SQL files require a saved SQLite database file.');
  const child = spawn(process.execPath, ['-e', source, file], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  let dead = false,
    sequence = 0;
  child.on('error', () => {
    dead = true;
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      dead = true;
      resolve();
    });
    child.once('error', () => {
      dead = true;
      resolve();
    });
  });
  const kill = () => {
    dead = true;
    child.kill();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        kill();
        reject(new Error('SQLite script session startup timed out.'));
      }, 10000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error('Could not start the SQLite script session.'));
      };
      child.once('error', fail);
      child.once('exit', fail);
      child.once('message', () => {
        clearTimeout(timer);
        child.off('error', fail);
        child.off('exit', fail);
        resolve();
      });
    });
    return await task((sql, signal, timeout) => {
      if (dead) return Promise.reject(new Error('Script session is closed.'));
      return scriptDeadline(
        signal,
        timeout,
        kill,
        () =>
          new Promise<void>((resolve, reject) => {
            const id = ++sequence;
            const clean = () => {
              child.off('message', message);
              child.off('exit', exit);
              child.off('error', exit);
            };
            const exit = () => {
              clean();
              reject(new Error('Script session is closed.'));
            };
            const message = (value: any) => {
              if (value.id !== id) return;
              clean();
              value.error ? reject(new Error(value.error)) : resolve();
            };
            child.on('message', message);
            child.once('exit', exit);
            child.once('error', exit);
            child.send({ id, sql }, (error) => {
              if (error) {
                clean();
                reject(error);
              }
            });
          }),
      );
    });
  } finally {
    if (!dead && child.connected) child.send({ close: true }, () => {});
    else kill();
    const fallback = setTimeout(kill, 1000);
    await exited;
    clearTimeout(fallback);
  }
}
