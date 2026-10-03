// Test-only native launcher. Never use _electron.launch, extract AppImages, or
// change the desktop/backend selection. Only the explicit negative adds basic.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class NativeLaunchError extends Error {
  constructor(code, blocked = false) {
    super(code);
    this.blocked = blocked;
  }
}
export async function ephemeralPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export function nativeLaunchArguments({
  executable,
  profile,
  debugging = true,
  inspector = debugging,
  debugPort,
  mainPort,
  basic = false,
}) {
  if (!debugging && inspector) throw new NativeLaunchError('invalid-debug-options');
  return [
    ...(!executable ? ['.'] : []),
    `--user-data-dir=${profile}`,
    ...(debugging ? [`--remote-debugging-port=${debugPort}`] : []),
    ...(inspector ? [`--inspect=127.0.0.1:${mainPort}`] : []),
    ...(basic ? ['--password-store=basic'] : []),
  ];
}

// Pure child-environment construction: the real unavailable negative changes
// ONLY the session-bus address relative to a normal isolated launch. It never
// changes process.env, starts/stops D-Bus, locks a keyring, or selects a backend.
export function nativeLaunchEnvironment({
  root,
  unavailable = false,
  base = process.env,
  platform = process.platform,
}) {
  if (!root) throw new NativeLaunchError('isolated-root-required');
  if (unavailable && platform !== 'linux')
    throw new NativeLaunchError('unavailable-dbus-linux-only', true);
  const env = { ...base, DATABASE_WORKSPACE_DATA_DIR: join(resolve(root), 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.DATABASE_WORKSPACE_HEADLESS;
  delete env.NODE_OPTIONS;
  if (unavailable)
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${encodeURIComponent(join(resolve(root), 'unreachable-secret-service.sock'))}`;
  return env;
}

// Scan ALL log bytes, including discarded bytes. Keep only bounded, scrubbed
// text in memory; never write/print subprocess output. Rolling detection handles
// a secret split between arbitrary stdout/stderr chunks (streams stay separate).
export function createLogCapture(secrets = [], limit = 65536) {
  const patterns = secrets.filter((value) => typeof value === 'string' && value.length);
  const overlap = Math.max(1, ...patterns.map((value) => value.length)) - 1;
  let text = '',
    plaintextFound = false,
    bytes = 0;
  const tails = new Map();
  return {
    push(chunk, stream = 'stdout') {
      stream = stream === 'stderr' ? 'stderr' : 'stdout';
      const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      bytes += Buffer.byteLength(value);
      const combined = (tails.get(stream) ?? '') + value;
      if (patterns.some((secret) => combined.includes(secret))) plaintextFound = true;
      // Retained raw tails are detector state only, never returned or logged.
      tails.set(stream, overlap ? combined.slice(-overlap) : '');
      let scrubbed = combined;
      for (const secret of patterns) scrubbed = scrubbed.split(secret).join('[REDACTED]');
      // Preserve no potentially partial secret in the diagnostic buffer.
      for (const secret of patterns) {
        for (let size = Math.min(secret.length - 1, scrubbed.length); size > 0; size--) {
          if (scrubbed.endsWith(secret.slice(0, size))) {
            scrubbed = scrubbed.slice(0, -size) + '[REDACTED-PARTIAL]';
            break;
          }
        }
      }
      text = (text + scrubbed).slice(-limit);
    },
    get plaintextFound() {
      return plaintextFound;
    },
    get bounded() {
      return Buffer.byteLength(text) <= limit * 4;
    },
    get bytes() {
      return bytes;
    },
    get scrubbed() {
      return !patterns.some((secret) => text.includes(secret));
    },
    // Expose classification booleans, never the diagnostic text.
    get runtimeBlocked() {
      return /libfuse\.so\.2|cannot mount AppImage|Missing X server|Missing.*DISPLAY|error while loading shared libraries/i.test(
        text,
      );
    },
  };
}

const processIdentity = (record) => `${record.pid}:${record.startTime}`;
const running = (record) => !['Z', 'X', 'x'].includes(record.state);
export function parseLinuxProcessStat(stat) {
  const pid = Number(stat.slice(0, stat.indexOf('(')).trim());
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  if (!Number.isSafeInteger(pid) || pid < 1 || !/^\d+$/.test(fields[19] ?? ''))
    throw new NativeLaunchError('invalid-process-identity');
  return {
    pid,
    state: fields[0],
    parent: Number(fields[1]),
    group: Number(fields[2]),
    session: Number(fields[3]),
    startTime: fields[19],
  };
}
async function readProcessRecord(pid) {
  try {
    return parseLinuxProcessStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw new NativeLaunchError('process-identity-unreadable');
  }
}

// Ownership is historical, not a fresh PPID search. A reused PID is NOT a seed.
// Only identities actually observed beneath verified current owners (or in their
// still-anchored original session) are added. Reparenting/setsid never removes one.
export function createOwnershipLedger(rootRecord) {
  const known = new Map([[processIdentity(rootRecord), { ...rootRecord }]]);
  const has = (record) => !!record && known.has(processIdentity(record));
  return {
    has,
    get identities() {
      return [...known.values()].map((record) => ({ ...record }));
    },
    observe(records, approvedNew) {
      const byPid = new Map(records.map((record) => [record.pid, record]));
      let changed = true;
      while (changed) {
        changed = false;
        const anchoredSession = records.some(
          (record) => has(record) && record.session === rootRecord.pid,
        );
        for (const record of records) {
          if (has(record) || (approvedNew && !approvedNew.has(processIdentity(record)))) continue;
          const parent = byPid.get(record.parent);
          if (
            (has(parent) && BigInt(record.startTime) >= BigInt(parent.startTime)) ||
            (anchoredSession && record.session === rootRecord.pid)
          ) {
            known.set(processIdentity(record), { ...record });
            changed = true;
          }
        }
      }
      return records.filter((record) => has(record) && running(record));
    },
  };
}

// Pin the exact process with pidfd BEFORE signalling, then recheck birth identity.
// Numeric kill(pid)/kill(-pgid) cannot close the PID/group-reuse race. Original
// group members receive the same signal individually through verified pidfds;
// escaped groups/sessions receive it too. Never broadcast to a recycled PGID.
const signalOwnedPython = String.raw`
import os,sys,json,signal
if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):
 print(json.dumps({'supported':False})); sys.exit(2)
unverified=False
for item in json.load(sys.stdin):
 fd=None
 try:
  fd=os.pidfd_open(int(item['pid']),0)
  stat=open('/proc/'+str(item['pid'])+'/stat').read()
  fields=stat[stat.rfind(')')+2:].split()
  if fields[19]!=str(item['startTime']) or fields[0] in ('Z','X','x'): continue
  signal.pidfd_send_signal(fd,getattr(signal,sys.argv[1]),None,0)
 except (ProcessLookupError,FileNotFoundError): pass
 except Exception: unverified=True
 finally:
  if fd is not None: os.close(fd)
print(json.dumps({'supported':True,'unverified':unverified}))
`;
async function signalOwnedRecords(records, name) {
  if (!records.length) return;
  await new Promise((resolve, reject) => {
    const helper = spawn('python3', ['-c', signalOwnedPython, name], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '',
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      helper.kill('SIGKILL');
      finish(new NativeLaunchError('owned-pidfd-signal-timeout'));
    }, 5000);
    helper.stdout.on('data', (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-4096);
    });
    helper.stdin.on('error', () => {});
    helper.once('error', () =>
      finish(new NativeLaunchError('owned-pidfd-runtime-unavailable', true)),
    );
    helper.once('close', (code) => {
      let result;
      try {
        result = JSON.parse(output.trim());
      } catch {}
      finish(
        code === 0 && result?.supported && !result.unverified
          ? undefined
          : new NativeLaunchError('owned-pidfd-signal-unverified', !result?.supported),
      );
    });
    helper.stdin.end(JSON.stringify(records.map(({ pid, startTime }) => ({ pid, startTime }))));
  });
}
export async function createOwnedProcessTracker(child, { pollInterval = 50 } = {}) {
  if (process.platform !== 'linux')
    throw new NativeLaunchError('process-identity-platform-unsupported', true);
  const rootRecord = await readProcessRecord(child.pid);
  if (
    !rootRecord ||
    rootRecord.parent !== process.pid ||
    rootRecord.session !== child.pid ||
    rootRecord.group !== child.pid
  )
    throw new NativeLaunchError('launcher-birth-identity-unconfirmed');
  const ledger = createOwnershipLedger(rootRecord);
  let inFlight,
    unsafe = false;
  const refresh = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const knownPids = new Set(ledger.identities.map((record) => record.pid));
      // Always re-read EVERY historical PID explicitly, even if /proc directory
      // enumeration omitted it. Only missing/birth-mismatched/dead identities
      // prove termination; unreadable known identities make proof fail closed.
      const pids = new Set([
        ...knownPids,
        ...(await readdir('/proc')).filter((entry) => /^\d+$/.test(entry)).map(Number),
      ]);
      const records = (
        await Promise.all(
          [...pids].map(async (pid) => {
            try {
              return await readProcessRecord(pid);
            } catch (error) {
              if (knownPids.has(pid)) throw error;
              return null;
            }
          }),
        )
      ).filter(Boolean);
      // /proc isn't atomic: validate each NEW child and its current parent/known
      // session anchor again before committing ownership. PID-only ancestry is
      // never used after a known parent's birth identity stops matching.
      const byPid = new Map(records.map((record) => [record.pid, record]));
      let changed = true;
      while (changed) {
        changed = false;
        const anchors = records.filter(
          (record) => ledger.has(record) && record.session === rootRecord.pid,
        );
        const approved = new Set();
        for (const record of records) {
          if (ledger.has(record)) continue;
          const parent = byPid.get(record.parent);
          const anchor = ledger.has(parent)
            ? parent
            : record.session === rootRecord.pid
              ? anchors[0]
              : undefined;
          if (!anchor) continue;
          const current = await readProcessRecord(record.pid);
          const currentAnchor = await readProcessRecord(anchor.pid);
          if (
            current &&
            currentAnchor &&
            processIdentity(current) === processIdentity(record) &&
            processIdentity(currentAnchor) === processIdentity(anchor) &&
            current.parent === record.parent &&
            current.session === record.session
          )
            approved.add(processIdentity(record));
        }
        if (approved.size) {
          const before = ledger.identities.length;
          ledger.observe(records, approved);
          changed = ledger.identities.length > before;
        }
      }
      return ledger.observe(records, new Set());
    })()
      .catch((error) => {
        unsafe = true;
        throw error;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const timer = setInterval(() => {
    void refresh().catch(() => {});
  }, pollInterval);
  timer.unref();
  const tracker = {
    refresh,
    get identities() {
      return ledger.identities;
    },
    async confirmExited() {
      try {
        return !(await refresh()).length && !unsafe;
      } catch {
        return false;
      }
    },
    async waitForExit(milliseconds) {
      const deadline = Date.now() + milliseconds;
      do {
        if (await tracker.confirmExited()) return true;
        await delay(50);
      } while (Date.now() < deadline);
      return false;
    },
    async terminate() {
      // This method is FAILURE CLEANUP ONLY, never evidence of normal closure.
      for (const [name, wait] of [
        ['SIGTERM', 2000],
        ['SIGKILL', 2000],
      ]) {
        await signalOwnedRecords(await refresh(), name);
        if (await tracker.waitForExit(wait)) return true;
      }
      return tracker.confirmExited();
    },
    close() {
      clearInterval(timer);
    },
  };
  try {
    await refresh();
  } catch (error) {
    tracker.close();
    throw error;
  }
  return tracker;
}
export async function removeIsolatedRoot(root, runs, launchCleanupConfirmed = true) {
  if (launchCleanupConfirmed !== true)
    throw new NativeLaunchError('owned-process-cleanup-unconfirmed-root-retained');
  for (const run of runs) {
    if (
      typeof run.confirmOwnedProcessesExited !== 'function' ||
      (await run.confirmOwnedProcessesExited()) !== true
    )
      throw new NativeLaunchError('owned-process-cleanup-unconfirmed-root-retained');
  }
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
async function assertLoopbackListeners(ports, tracker) {
  if (process.platform !== 'linux')
    throw new NativeLaunchError('loopback-ownership-platform-unsupported', true);
  const pids = (await tracker.refresh()).map((record) => record.pid);
  const sockets = new Map();
  for (const pid of pids) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
    for (const fd of fds) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      if (link.startsWith('socket:')) sockets.set(link, pid);
    }
  }
  const tables = await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((p) => readFile(p, 'utf8')),
  );
  const owners = [];
  for (const port of ports) {
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    const listeners = tables
      .flatMap((text) => text.split('\n').slice(1))
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[3] === '0A' && fields[1]?.endsWith(`:${hex}`));
    if (
      !listeners.length ||
      listeners.some(
        (fields) =>
          !['0100007F', '00000000000000000000000001000000'].includes(fields[1].split(':')[0]) ||
          !sockets.has(`socket:[${fields[9]}]`),
      )
    )
      throw new NativeLaunchError('debug-listener-not-owned-loopback');
    owners.push(...listeners.map((fields) => sockets.get(`socket:[${fields[9]}]`)));
  }
  if (new Set(owners).size !== 1)
    throw new NativeLaunchError('debug-listeners-different-processes');
  return owners[0];
}

class Inspector {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.events = new Map();
    this.sequence = 0;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const task = this.pending.get(message.id);
        if (!task) return;
        this.pending.delete(message.id);
        clearTimeout(task.timer);
        if (message.error) task.reject(new NativeLaunchError('inspector-command-failed'));
        else task.resolve(message.result);
      } else for (const listener of this.events.get(message.method) ?? []) listener(message.params);
    });
    socket.addEventListener('close', () => this.close());
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeLaunchError('inspector-timeout'));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) {
    const listeners = this.events.get(method) ?? new Set();
    listeners.add(listener);
    this.events.set(method, listeners);
    return () => listeners.delete(listener);
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new NativeLaunchError('main-probe-failed');
    return response.result.value;
  }
  close() {
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new NativeLaunchError('inspector-closed'));
    }
    this.pending.clear();
    if (this.socket.readyState < 2) this.socket.close();
  }
}
async function endpoint(port, path, child, exited) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (exited() || child.exitCode !== null) throw new NativeLaunchError('native-electron-exited');
    try {
      const result = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(1000),
      });
      if (result.ok) return await result.json();
    } catch {
      /* bounded startup retry, never print network/subprocess errors */
    }
    await delay(100);
  }
  throw new NativeLaunchError('native-electron-startup-timeout');
}

// No new dependencies: use the host X11 client protocol, not a process signal.
// _NET_WM_PID must identify our own session's process, the window must be mapped
// and advertise WM_DELETE_WINDOW. Only that window receives one close request.
const windowClosePython = String.raw`
import ctypes as C, ctypes.util, json, os, sys, time
identities = json.loads(sys.argv[1])
try:
 lib = C.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
except Exception:
 print(json.dumps({'blocked':True,'code':'x11-library-unavailable'})); sys.exit(2)
Display = C.c_void_p; Window = C.c_ulong; Atom = C.c_ulong
lib.XOpenDisplay.argtypes=[C.c_char_p]; lib.XOpenDisplay.restype=Display
lib.XDefaultRootWindow.argtypes=[Display]; lib.XDefaultRootWindow.restype=Window
lib.XInternAtom.argtypes=[Display,C.c_char_p,C.c_int]; lib.XInternAtom.restype=Atom
lib.XQueryTree.argtypes=[Display,Window,C.POINTER(Window),C.POINTER(Window),C.POINTER(C.POINTER(Window)),C.POINTER(C.c_uint)]
lib.XGetWindowProperty.argtypes=[Display,Window,Atom,C.c_long,C.c_long,C.c_int,Atom,C.POINTER(Atom),C.POINTER(C.c_int),C.POINTER(C.c_ulong),C.POINTER(C.c_ulong),C.POINTER(C.POINTER(C.c_ubyte))]
lib.XGetWMProtocols.argtypes=[Display,Window,C.POINTER(C.POINTER(Atom)),C.POINTER(C.c_int)]
lib.XFetchName.argtypes=[Display,Window,C.POINTER(C.c_char_p)]
lib.XFree.argtypes=[C.c_void_p]
lib.XFlush.argtypes=[Display]; lib.XCloseDisplay.argtypes=[Display]
# Asynchronous disappearing-window errors are irrelevant to discovery.
handler=C.CFUNCTYPE(C.c_int,Display,C.c_void_p)(lambda d,e:0)
lib.XSetErrorHandler.argtypes=[C.c_void_p]; lib.XSetErrorHandler(handler)
d=lib.XOpenDisplay(None)
if not d:
 print(json.dumps({'blocked':True,'code':'x11-display-unavailable'})); sys.exit(2)
class Attributes(C.Structure):
 _fields_=[('x',C.c_int),('y',C.c_int),('width',C.c_int),('height',C.c_int),('border_width',C.c_int),('depth',C.c_int),('visual',C.c_void_p),('root',Window),('class_',C.c_int),('bit_gravity',C.c_int),('win_gravity',C.c_int),('backing_store',C.c_int),('backing_planes',C.c_ulong),('backing_pixel',C.c_ulong),('save_under',C.c_int),('colormap',C.c_ulong),('map_installed',C.c_int),('map_state',C.c_int),('all_event_masks',C.c_long),('your_event_mask',C.c_long),('do_not_propagate_mask',C.c_long),('override_redirect',C.c_int),('screen',C.c_void_p)]
class Data(C.Union):
 _fields_=[('b',C.c_char*20),('s',C.c_short*10),('l',C.c_long*5)]
class Message(C.Structure):
 _fields_=[('type',C.c_int),('serial',C.c_ulong),('send_event',C.c_int),('display',Display),('window',Window),('message_type',Atom),('format',C.c_int),('data',Data)]
class Event(C.Union):
 _fields_=[('message',Message),('pad',C.c_long*24)]
lib.XGetWindowAttributes.argtypes=[Display,Window,C.POINTER(Attributes)]
lib.XSendEvent.argtypes=[Display,Window,C.c_int,C.c_long,C.POINTER(Event)]
pidatom=lib.XInternAtom(d,b'_NET_WM_PID',False); protocols=lib.XInternAtom(d,b'WM_PROTOCOLS',False); delete=lib.XInternAtom(d,b'WM_DELETE_WINDOW',False); nameatom=lib.XInternAtom(d,b'_NET_WM_NAME',False)
def owned():
 result=set()
 for item in identities:
  try:
   stat=open('/proc/'+str(item['pid'])+'/stat').read(); fields=stat[stat.rfind(')')+2:].split()
   if fields[19]==str(item['startTime']) and fields[0] not in ('Z','X','x'): result.add(item['pid'])
  except Exception: pass
 return result
def windows(root):
 stack=[root]; seen=set()
 while stack:
  w=stack.pop()
  if w in seen: continue
  seen.add(w); yield w
  r=Window(); p=Window(); children=C.POINTER(Window)(); n=C.c_uint()
  if lib.XQueryTree(d,w,C.byref(r),C.byref(p),C.byref(children),C.byref(n)):
   stack.extend(children[i] for i in range(n.value))
   if children: lib.XFree(children)
deadline=time.monotonic()+30
while time.monotonic()<deadline:
 owners=owned()
 for w in windows(lib.XDefaultRootWindow(d)):
  actual=Atom(); fmt=C.c_int(); count=C.c_ulong(); remain=C.c_ulong(); value=C.POINTER(C.c_ubyte)()
  lib.XGetWindowProperty(d,w,pidatom,0,1,False,0,C.byref(actual),C.byref(fmt),C.byref(count),C.byref(remain),C.byref(value))
  pid=C.cast(value,C.POINTER(C.c_ulong))[0] if value and fmt.value==32 and count.value else None
  if value: lib.XFree(value)
  if pid not in owners: continue
  attr=Attributes()
  if not lib.XGetWindowAttributes(d,w,C.byref(attr)) or attr.map_state!=2 or attr.width<500 or attr.height<300: continue
  title=C.c_char_p()
  named=lib.XFetchName(d,w,C.byref(title)) and title.value==b'Database Workspace'
  if title: lib.XFree(C.cast(title,C.c_void_p))
  # Modern Electron/Xwayland advertises the UTF-8 EWMH title, not necessarily
  # legacy WM_NAME. Accept either property, with the exact product title.
  actual=Atom(); fmt=C.c_int(); count=C.c_ulong(); remain=C.c_ulong(); value=C.POINTER(C.c_ubyte)()
  lib.XGetWindowProperty(d,w,nameatom,0,256,False,0,C.byref(actual),C.byref(fmt),C.byref(count),C.byref(remain),C.byref(value))
  netname=C.string_at(value,count.value) if value and fmt.value==8 else b''
  if value: lib.XFree(value)
  named=named or netname==b'Database Workspace'
  if not named: continue
  values=C.POINTER(Atom)(); n=C.c_int()
  supported=lib.XGetWMProtocols(d,w,C.byref(values),C.byref(n)) and any(values[i]==delete for i in range(n.value))
  if values: lib.XFree(values)
  if not supported: continue
  event=Event(); event.message.type=33; event.message.send_event=True; event.message.display=d; event.message.window=w; event.message.message_type=protocols; event.message.format=32; event.message.data.l[0]=delete; event.message.data.l[1]=0
  sent=bool(lib.XSendEvent(d,w,False,0,C.byref(event))); lib.XFlush(d); lib.XCloseDisplay(d)
  print(json.dumps({'blocked':False,'visible':True,'owned':True,'protocolSent':sent})); sys.exit(0 if sent else 1)
 time.sleep(.1)
lib.XCloseDisplay(d)
print(json.dumps({'blocked':False,'code':'owned-visible-window-not-found'})); sys.exit(1)
`;
async function closeOwnedVisibleWindow(tracker) {
  if (process.platform !== 'linux' || !process.env.DISPLAY)
    throw new NativeLaunchError('x11-normal-close-unavailable', true);
  const identities = (await tracker.refresh()).map(({ pid, startTime }) => ({ pid, startTime }));
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', windowClosePython, JSON.stringify(identities)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '',
      finished = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new NativeLaunchError('window-protocol-timeout'));
    }, 35000);
    child.stdout.on('data', (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-4096);
    });
    child.once('error', () => {
      finished = true;
      clearTimeout(timer);
      reject(new NativeLaunchError('python-window-runtime-unavailable', true));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (finished) return;
      let result;
      try {
        result = JSON.parse(output.trim());
      } catch {
        reject(new NativeLaunchError('window-protocol-failed'));
        return;
      }
      if (code !== 0 || !result.visible || !result.owned || !result.protocolSent)
        reject(
          new NativeLaunchError(
            result.blocked ? 'x11-window-runtime-unavailable' : 'window-protocol-failed',
            !!result.blocked,
          ),
        );
      else resolve(result);
    });
  });
}

export async function launchNativeElectron({
  executable,
  basic = false,
  unavailable = false,
  debugging = true,
  inspector = debugging,
  root: suppliedRoot,
  keepRoot = Boolean(suppliedRoot),
  secrets = [],
} = {}) {
  if (process.platform !== 'linux')
    throw new NativeLaunchError('process-identity-platform-unsupported', true);
  if (basic && process.platform !== 'linux')
    throw new NativeLaunchError('basic-negative-linux-only', true);
  if (basic && unavailable) throw new NativeLaunchError('conflicting-negative-launch-options');
  const root = suppliedRoot
    ? resolve(suppliedRoot)
    : await mkdtemp(join(tmpdir(), 'workspace-credential-smoke-'));
  const dataDir = join(root, 'data'),
    profile = join(root, 'profile');
  const logs = createLogCapture(secrets);
  let child,
    browser,
    main,
    socket,
    mainPid,
    tracker,
    finished = false,
    stopping;
  let normalWindowClose = false;
  const confirmOwnedProcessesExited = async () => {
    if (!child?.pid) return true; // No successfully spawned process.
    return !!tracker && (await tracker.confirmExited());
  };
  const waitOwnedExit = async (milliseconds) => {
    const deadline = Date.now() + milliseconds;
    do {
      if (finished && (await confirmOwnedProcessesExited())) return true;
      await delay(50);
    } while (Date.now() < deadline);
    return false;
  };
  const stop = ({ failure = false } = {}) => {
    if (stopping) return stopping;
    stopping = (async () => {
      let graceful = !child?.pid,
        closeError,
        cleanupError;
      try {
        if (child?.pid && !finished) {
          if (!failure && !debugging) {
            try {
              await closeOwnedVisibleWindow(tracker);
              normalWindowClose = true;
            } catch (error) {
              closeError = error;
            }
          } else if (main)
            await main.evaluate('__credentialSmokeElectron.app.quit(); true').catch(() => {});
          main?.close();
          // On failure without a usable main inspector go straight to identity-
          // verified cleanup. A successful path always waits for NORMAL exit.
          if (!failure || main) graceful = await waitOwnedExit(10000);
        } else if (child?.pid) graceful = await waitOwnedExit(1000);
        if (child?.pid && !graceful) {
          try {
            if (tracker) await tracker.terminate();
            else cleanupError = new NativeLaunchError('launcher-birth-identity-unconfirmed');
          } catch (error) {
            cleanupError = error;
          }
          await waitOwnedExit(2000);
        }
      } finally {
        main?.close();
        if (!main && socket?.readyState < 2) socket.close();
        await browser?.close().catch(() => {});
        tracker?.close();
      }
      const terminated = await confirmOwnedProcessesExited();
      if (!terminated) {
        // Leave scratch intact and release Node handles so a failed harness can
        // exit. The still-unconfirmed owned process is NOT described as exited.
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        const error = new NativeLaunchError('owned-process-cleanup-unconfirmed-root-retained');
        error.cleanupConfirmed = false;
        error.rootRetained = true;
        throw error;
      }
      if (!keepRoot) await removeIsolatedRoot(root, [{ confirmOwnedProcessesExited }]);
      if (!failure) {
        if (closeError) throw closeError;
        if (!graceful) throw new NativeLaunchError('native-electron-graceful-close-failed');
        if (child?.exitCode !== 0 || child?.signalCode)
          throw new NativeLaunchError('native-electron-exit-failed');
        if (!debugging && !normalWindowClose)
          throw new NativeLaunchError('normal-window-close-not-proven');
        if (logs.plaintextFound || !logs.scrubbed)
          throw new NativeLaunchError('plaintext-in-child-logs');
      }
      if (cleanupError) throw cleanupError;
      return {
        exitZero: child?.exitCode === 0,
        normalWindowClose,
        ownedProcessesExited: terminated,
        normalClosure: graceful,
        plaintextAbsent: !logs.plaintextFound,
        logsBounded: logs.bounded,
        logsScrubbed: logs.scrubbed,
      };
    })();
    return stopping;
  };
  try {
    await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(profile, { recursive: true })]);
    const debugPort = debugging ? await ephemeralPort() : undefined;
    let mainPort;
    do {
      mainPort = inspector ? await ephemeralPort() : undefined;
    } while (inspector && mainPort === debugPort);
    const binary = executable ? resolve(executable) : createRequire(import.meta.url)('electron');
    const args = nativeLaunchArguments({
      executable,
      profile,
      debugging,
      inspector,
      debugPort,
      mainPort,
      basic,
    });
    const env = nativeLaunchEnvironment({ root, unavailable });
    if (unavailable) {
      // No socket is ever created here. Reject even a dangling symlink; our
      // missing endpoint must not accidentally resolve to a real host daemon.
      const socketPath = decodeURIComponent(
        env.DBUS_SESSION_BUS_ADDRESS.slice('unix:path='.length),
      );
      try {
        await lstat(socketPath);
        throw new NativeLaunchError('unavailable-dbus-endpoint-already-exists');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    child = spawn(binary, args, {
      cwd: resolve('.'),
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logs.push(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => logs.push(chunk, 'stderr'));
    child.once('close', () => {
      finished = true;
    });
    child.once('error', () => {
      finished = true;
    });
    if (!child.pid) throw new NativeLaunchError('native-electron-spawn-failed');
    tracker = await createOwnedProcessTracker(child);
    if (!debugging) {
      await delay(1000);
      if (finished) throw new NativeLaunchError('normal-launch-exited');
      return {
        root,
        dataDir,
        profile,
        pid: child.pid,
        logs,
        stop,
        confirmOwnedProcessesExited,
        debugging: false,
        args,
        unavailable,
        unavailableBusAddress: unavailable ? env.DBUS_SESSION_BUS_ADDRESS : undefined,
      };
    }
    const version = await endpoint(debugPort, '/json/version', child, () => finished);
    const debugUrl = new URL(version.webSocketDebuggerUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(debugUrl.hostname))
      throw new NativeLaunchError('unsafe-debug-endpoint');
    mainPid = await assertLoopbackListeners([debugPort], tracker);
    browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 15000 });
    if (inspector) {
      const targets = await endpoint(mainPort, '/json/list', child, () => finished);
      const url = new URL(targets[0].webSocketDebuggerUrl);
      if (url.hostname !== '127.0.0.1') throw new NativeLaunchError('unsafe-inspector-endpoint');
      if (mainPid !== (await assertLoopbackListeners([debugPort, mainPort], tracker)))
        throw new NativeLaunchError('main-listener-identity-mismatch');
      socket = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new NativeLaunchError('inspector-connect-timeout')),
          15000,
        );
        socket.addEventListener(
          'open',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          'error',
          () => {
            clearTimeout(timer);
            reject(new NativeLaunchError('inspector-connect-failed'));
          },
          { once: true },
        );
      });
      main = new Inspector(socket);
      await main.send('Runtime.enable');
      await main.evaluate(
        `globalThis.__credentialSmokeElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron'); true`,
      );
      if ((await main.evaluate('process.pid')) !== mainPid)
        throw new NativeLaunchError('main-process-ownership-mismatch');
    }
    const deadline = Date.now() + 15000;
    let page;
    while (Date.now() < deadline) {
      page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((p) => p.url().startsWith('workspace://app/'));
      if (page) break;
      if (finished) throw new NativeLaunchError('native-electron-exited');
      await delay(100);
    }
    if (!page) throw new NativeLaunchError('workspace-window-missing');
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => typeof window.desktop?.command === 'function');
    return {
      page,
      browser,
      main,
      dataDir,
      profile,
      root,
      stop,
      confirmOwnedProcessesExited,
      pid: child.pid,
      mainPid,
      logs,
      debugging: true,
      args,
      unavailable,
      unavailableBusAddress: unavailable ? env.DBUS_SESSION_BUS_ADDRESS : undefined,
    };
  } catch (error) {
    await stop({ failure: true }).catch(() => {});
    const reported = logs.runtimeBlocked
      ? new NativeLaunchError('native-runtime-blocked', true)
      : error instanceof NativeLaunchError
        ? error
        : new NativeLaunchError('native-electron-launch-failed');
    reported.cleanupConfirmed = await confirmOwnedProcessesExited();
    reported.rootRetained = !reported.cleanupConfirmed;
    throw reported;
  }
}
