import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone native .mjs test harness has no application declarations.
import * as nativeHarness from '../scripts/native-electron-launch.mjs';

const {
  nativeLaunchArguments,
  nativeLaunchEnvironment,
  createLogCapture,
  NativeLaunchError,
  parseLinuxProcessStat,
  createOwnershipLedger,
  createOwnedProcessTracker,
  removeIsolatedRoot,
} = nativeHarness;
interface ProcessRecord {
  pid: number;
  parent: number;
  group: number;
  session: number;
  startTime: string;
  state: string;
}
interface ProcessTracker {
  refresh(): Promise<ProcessRecord[]>;
  confirmExited(): Promise<boolean>;
  terminate(): Promise<boolean>;
  close(): void;
}
const record = (
  pid: number,
  parent: number,
  startTime: string,
  session = 100,
  group = session,
  state = 'S',
): ProcessRecord => ({ pid, parent, startTime, session, group, state });

// Never use random secret values as matcher operands or test names: failing
// assertions must reveal only booleans, not expected/received synthetic secrets.
describe('native credential acceptance launch switches', () => {
  it('preserves normal backend selection for a direct packaged artifact', () => {
    const args = nativeLaunchArguments({
      executable: '/scratch/Database Workspace.AppImage',
      profile: '/scratch/profile',
      debugPort: 31001,
      mainPort: 31002,
    });
    expect(
      args.join('|') ===
        '--user-data-dir=/scratch/profile|--remote-debugging-port=31001|--inspect=127.0.0.1:31002',
    ).toBe(true);
    expect(args.some((arg: string) => /password-store|no-sandbox|extract/.test(arg))).toBe(false);
  });
  it('uses electron . only for development', () => {
    const args = nativeLaunchArguments({
      profile: '/scratch/profile',
      debugPort: 31001,
      mainPort: 31002,
    });
    expect(args[0] === '.').toBe(true);
  });
  it('adds basic only for the explicitly requested negative', () => {
    const args = nativeLaunchArguments({
      executable: '/scratch/app',
      profile: '/scratch/profile',
      debugPort: 31001,
      mainPort: 31002,
      basic: true,
    });
    expect(args.filter((arg: string) => arg === '--password-store=basic').length === 1).toBe(true);
  });
  it('normal no-debug launch has ONLY the isolated profile switch', () => {
    const args = nativeLaunchArguments({
      executable: '/scratch/app',
      profile: '/scratch/profile',
      debugging: false,
      inspector: false,
    });
    expect(args.length === 1 && args[0] === '--user-data-dir=/scratch/profile').toBe(true);
  });
  it('rejects an inspector on a claimed no-debug launch', () => {
    let rejected = false;
    try {
      nativeLaunchArguments({ profile: '/scratch/profile', debugging: false, inspector: true });
    } catch (error) {
      rejected = error instanceof NativeLaunchError;
    }
    expect(rejected).toBe(true);
  });
});

describe('real unavailable Secret Service child environment', () => {
  const base = Object.freeze({
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/session-bus',
    DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/host/system-bus',
    XDG_CURRENT_DESKTOP: 'GNOME',
    DESKTOP_SESSION: 'gnome',
    GDMSESSION: 'gnome',
    XDG_RUNTIME_DIR: '/host/runtime',
    DISPLAY: ':1',
    GNOME_DESKTOP_SESSION_ID: 'inherited',
    PASSWORD_STORE: 'inherited-policy',
    DATABASE_WORKSPACE_DATA_DIR: '/host/user-profile',
    NODE_OPTIONS: 'inherited-node-options',
  });
  it('normal isolated launches preserve desktop hints and the inherited real D-Bus address', () => {
    const env = nativeLaunchEnvironment({ root: '/scratch/owned', base, platform: 'linux' });
    expect(env.DBUS_SESSION_BUS_ADDRESS === base.DBUS_SESSION_BUS_ADDRESS).toBe(true);
    expect(env.DBUS_SYSTEM_BUS_ADDRESS === base.DBUS_SYSTEM_BUS_ADDRESS).toBe(true);
    expect(
      env.XDG_CURRENT_DESKTOP === base.XDG_CURRENT_DESKTOP &&
        env.DESKTOP_SESSION === base.DESKTOP_SESSION &&
        env.GDMSESSION === base.GDMSESSION,
    ).toBe(true);
    expect(env.PASSWORD_STORE === base.PASSWORD_STORE).toBe(true);
    expect(env.DATABASE_WORKSPACE_DATA_DIR === '/scratch/owned/data').toBe(true);
  });
  it('the unavailable option changes ONLY DBUS_SESSION_BUS_ADDRESS relative to a normal launch', () => {
    const root = '/scratch/owned';
    const normal = nativeLaunchEnvironment({ root, base, platform: 'linux' });
    const negative = nativeLaunchEnvironment({ root, base, platform: 'linux', unavailable: true });
    const keys = new Set([...Object.keys(normal), ...Object.keys(negative)]);
    const changed = [...keys].filter((key) => normal[key] !== negative[key]);
    expect(changed.length === 1 && changed[0] === 'DBUS_SESSION_BUS_ADDRESS').toBe(true);
    expect(
      decodeURIComponent(negative.DBUS_SESSION_BUS_ADDRESS.slice('unix:path='.length)) ===
        join(resolve(root), 'unreachable-secret-service.sock'),
    ).toBe(true);
    expect(
      base.DBUS_SESSION_BUS_ADDRESS === 'unix:path=/host/session-bus' &&
        base.XDG_CURRENT_DESKTOP === 'GNOME',
    ).toBe(true);
    const args = nativeLaunchArguments({
      executable: '/scratch/app',
      profile: '/scratch/owned/profile',
      debugPort: 31001,
      mainPort: 31002,
      unavailable: true,
    });
    expect(args.some((arg: string) => /password-store|desktop|extract|no-sandbox/.test(arg))).toBe(
      false,
    );
  });
  it('the derived endpoint is truly absent under a NEW owned scratch root and leaves host env untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-launch-env-test-'));
    const hostAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      const env = nativeLaunchEnvironment({ root, platform: 'linux', unavailable: true });
      const path = decodeURIComponent(env.DBUS_SESSION_BUS_ADDRESS.slice('unix:path='.length));
      let missing = false;
      try {
        await lstat(path);
      } catch (error) {
        missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
      expect(path === join(root, 'unreachable-secret-service.sock') && missing).toBe(true);
      expect(process.env.DBUS_SESSION_BUS_ADDRESS === hostAddress).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('escapes D-Bus address punctuation without adding another address or daemon endpoint', () => {
    const root = '/scratch/owned root,with;punctuation';
    const env = nativeLaunchEnvironment({ root, base, platform: 'linux', unavailable: true });
    expect(
      !env.DBUS_SESSION_BUS_ADDRESS.includes(';') && !env.DBUS_SESSION_BUS_ADDRESS.includes(','),
    ).toBe(true);
    expect(
      decodeURIComponent(env.DBUS_SESSION_BUS_ADDRESS.slice('unix:path='.length)) ===
        join(root, 'unreachable-secret-service.sock'),
    ).toBe(true);
  });
  it('fails closed on platforms where a missing session bus cannot demonstrate native unavailability', () => {
    let blocked = false;
    try {
      nativeLaunchEnvironment({
        root: '/scratch/owned',
        base,
        platform: 'darwin',
        unavailable: true,
      });
    } catch (error) {
      blocked = error instanceof NativeLaunchError && (error as { blocked: boolean }).blocked;
    }
    expect(blocked).toBe(true);
  });
});

describe('persistent process ownership and guarded scratch cleanup', () => {
  it('parses exact starttime without rounding or confusing spaces/parentheses in comm', () => {
    const fields = Array(50).fill('0');
    fields[0] = 'S';
    fields[1] = '99';
    fields[2] = '100';
    fields[3] = '100';
    fields[19] = '9007199254740993123';
    const parsed = parseLinuxProcessStat(`100 (worker ) with spaces) ${fields.join(' ')}`);
    expect(
      parsed.pid === 100 && parsed.parent === 99 && parsed.startTime === '9007199254740993123',
    ).toBe(true);
  });
  it('retains an observed child after reparenting and escape from the original group/session', () => {
    const root = record(100, 99, '1');
    const child = record(101, 100, '2', 101, 101);
    const ledger = createOwnershipLedger(root);
    expect(ledger.observe([root, child]).length === 2).toBe(true);
    const alive = ledger.observe([{ ...child, parent: 1 }]);
    expect(alive.length === 1 && alive[0].pid === 101 && ledger.identities.length === 2).toBe(true);
  });
  it('discovers descendants of a retained escaped owner after the original launcher exits', () => {
    const root = record(100, 99, '1');
    const child = record(101, 100, '2', 101, 101);
    const ledger = createOwnershipLedger(root);
    ledger.observe([root, child]);
    const alive = ledger.observe([{ ...child, parent: 1 }, record(102, 101, '3', 102, 102)]);
    expect(alive.length === 2 && alive.some((entry: ProcessRecord) => entry.pid === 102)).toBe(
      true,
    );
  });
  it('does not seed ownership from reused launcher/child PIDs or their replacements descendants', () => {
    const root = record(100, 99, '1');
    const child = record(101, 100, '2', 101, 101);
    const ledger = createOwnershipLedger(root);
    ledger.observe([root, child]);
    const alive = ledger.observe([
      record(100, 1, '90'),
      record(101, 1, '91', 101, 101),
      record(102, 100, '92'),
      record(103, 101, '93', 101, 101),
    ]);
    expect(alive.length === 0 && ledger.identities.length === 2).toBe(true);
  });
  it('includes original group/session members only while a verified original identity anchors that session', () => {
    const root = record(100, 99, '1');
    const ledger = createOwnershipLedger(root);
    const alive = ledger.observe([root, record(102, 1, '2'), record(103, 1, '3', 777, 100)]);
    expect(alive.length === 2 && !alive.some((entry: ProcessRecord) => entry.pid === 103)).toBe(
      true,
    );
    expect(
      createOwnershipLedger(root).observe([record(100, 1, '90'), record(104, 1, '91')]).length ===
        0,
    ).toBe(true);
  });
  it('retains zombie identities but counts them as terminated', () => {
    const root = record(100, 99, '1');
    const ledger = createOwnershipLedger(root);
    expect(
      ledger.observe([{ ...root, state: 'Z' }]).length === 0 && ledger.identities.length === 1,
    ).toBe(true);
  });
  it('retains scratch on false/throwing/missing exit proof and an unconfirmed failed launch', async () => {
    const cases = [
      { runs: [{ confirmOwnedProcessesExited: async () => false }], launch: true },
      {
        runs: [
          {
            confirmOwnedProcessesExited: async () => {
              throw new Error('fixture-only');
            },
          },
        ],
        launch: true,
      },
      { runs: [{}], launch: true },
      { runs: [], launch: false },
    ];
    for (const fixture of cases) {
      const root = await mkdtemp(join(tmpdir(), 'native-root-guard-test-'));
      try {
        let rejected = false;
        try {
          await removeIsolatedRoot(root, fixture.runs, fixture.launch);
        } catch {
          rejected = true;
        }
        expect(rejected && (await lstat(root)).isDirectory()).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      } // No real child in these fixtures.
    }
  });
  it('removes scratch only after every run freshly confirms owned termination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-root-guard-test-'));
    let calls = 0;
    try {
      await removeIsolatedRoot(root, [
        {
          confirmOwnedProcessesExited: async () => {
            calls++;
            return true;
          },
        },
        {
          confirmOwnedProcessesExited: async () => {
            calls++;
            return true;
          },
        },
      ]);
      let missing = false;
      try {
        await lstat(root);
      } catch (error) {
        missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
      expect(calls === 2 && missing).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== 'linux')(
    'terminates its real detached Node child after parent exit, escalating ignored SIGTERM',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'native-escaped-child-test-'));
      const program = String.raw`
      const {spawn}=require('node:child_process');setInterval(()=>{},1000);
      process.stdin.on('data',chunk=>{
        if(String(chunk).trim()==='exit')process.exit(0);
        if(String(chunk).trim()==='spawn'){
          const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','ignore']});
          child.stdout.once('data',()=>process.stdout.write(String(child.pid)+'\n'));child.unref();
        }
      });
    `;
      const parent = spawn(process.execPath, ['-e', program], {
        cwd: root,
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let tracker: ProcessTracker | undefined;
      const bounded = async <T>(promise: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
              timer = setTimeout(() => reject(new Error('owned-runtime-fixture-timeout')), 5000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const waitUntil = async (predicate: () => Promise<boolean>) => {
        const deadline = Date.now() + 5000;
        do {
          if (await predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        throw new Error('owned-runtime-fixture-timeout');
      };
      try {
        const initialized: ProcessTracker = await createOwnedProcessTracker(parent, {
          pollInterval: 20,
        });
        tracker = initialized;
        const ready = once(parent.stdout, 'data');
        parent.stdin.write('spawn\n');
        const [chunk] = await bounded(ready);
        const childPid = Number(String(chunk).trim());
        expect(Number.isSafeInteger(childPid) && childPid > 1).toBe(true);
        await waitUntil(async () =>
          (await tracker!.refresh()).some(
            (entry) =>
              entry.pid === childPid && entry.session === childPid && entry.group === childPid,
          ),
        );
        const closed = once(parent, 'close');
        parent.stdin.write('exit\n');
        await bounded(closed);
        expect(parent.exitCode === 0).toBe(true);
        await waitUntil(async () =>
          (await tracker!.refresh()).some(
            (entry) => entry.pid === childPid && entry.parent !== parent.pid,
          ),
        );
        expect(await tracker.confirmExited()).toBe(false);
        let retained = false;
        try {
          await removeIsolatedRoot(root, [
            { confirmOwnedProcessesExited: () => tracker!.confirmExited() },
          ]);
        } catch {
          retained = true;
        }
        expect(retained && (await lstat(root)).isDirectory()).toBe(true);
        expect(await tracker.terminate()).toBe(true);
        expect(await tracker.confirmExited()).toBe(true);
        await removeIsolatedRoot(root, [
          { confirmOwnedProcessesExited: () => tracker!.confirmExited() },
        ]);
      } finally {
        if (parent.exitCode === null && !parent.stdin.destroyed) parent.stdin.end('exit\n');
        if (tracker) {
          try {
            await tracker.terminate();
            await removeIsolatedRoot(root, [
              { confirmOwnedProcessesExited: () => tracker!.confirmExited() },
            ]);
          } finally {
            tracker.close();
          }
        } else {
          // No descendant is spawned until tracking initialization succeeds.
          if (parent.exitCode === null) await bounded(once(parent, 'close'));
          await rm(root, { recursive: true, force: true });
        }
      }
    },
    20000,
  );
});

describe('bounded subprocess secret detection and scrubbing', () => {
  it('detects and scrubs a random synthetic secret at EVERY two-chunk boundary', () => {
    const secret = randomBytes(32).toString('hex');
    let detected = true,
      scrubbed = true;
    for (let split = 1; split < secret.length; split++) {
      const capture = createLogCapture([secret], 128);
      capture.push(Buffer.from(`prefix ${secret.slice(0, split)}`), 'stderr');
      capture.push(Buffer.from(`${secret.slice(split)} suffix`), 'stderr');
      detected &&= capture.plaintextFound;
      scrubbed &&= capture.scrubbed && capture.bounded;
    }
    expect(detected).toBe(true);
    expect(scrubbed).toBe(true);
  });
  it('scans a one-byte-at-a-time secret even after the diagnostic limit is exceeded', () => {
    const secret = randomBytes(32).toString('hex');
    const capture = createLogCapture([secret], 128);
    capture.push('unrelated log text '.repeat(1000));
    for (const byte of Buffer.from(secret)) capture.push(Buffer.from([byte]));
    expect(capture.plaintextFound).toBe(true);
    expect(capture.scrubbed && capture.bounded).toBe(true);
    expect(capture.bytes > 128).toBe(true);
  });
  it('does not create a cross-stream match from unrelated stdout/stderr fragments', () => {
    const secret = randomBytes(32).toString('hex');
    const capture = createLogCapture([secret]);
    capture.push(secret.slice(0, 32), 'stdout');
    capture.push(secret.slice(32), 'stderr');
    expect(capture.plaintextFound).toBe(false);
    expect(capture.scrubbed && capture.bounded).toBe(true);
  });
  it('does not expose retained log text or detector tails through the public API', () => {
    const capture = createLogCapture([randomBytes(32).toString('hex')]);
    capture.push('benign runtime output');
    expect(
      Object.keys(capture).sort().join(',') ===
        'bounded,bytes,plaintextFound,push,runtimeBlocked,scrubbed',
    ).toBe(true);
    expect(capture.plaintextFound).toBe(false);
    expect(capture.scrubbed).toBe(true);
  });
  it('classifies a missing shared runtime as blocked without returning its log text', () => {
    const capture = createLogCapture();
    capture.push('error while loading shared libraries: unavailable-runtime.so');
    expect(capture.runtimeBlocked).toBe(true);
  });
});
