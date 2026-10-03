// Probe the real Electron safeStorage backend without reading existing secrets.
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--password-store=gnome-libsecret') || args.length > 1) {
  console.error('Usage: npm run check:secure-storage -- [--password-store=gnome-libsecret]');
  process.exit(1);
}
const dir = await mkdtemp(join(tmpdir(), 'dw-storage-check-'));
const entry = join(dir, 'check.cjs');
const marker = 'DW_STORAGE_CHECK=';
await writeFile(entry, `
const { app, safeStorage } = require('electron');
app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
app.whenReady().then(() => {
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform;
  const available = safeStorage.isEncryptionAvailable();
  const secure = available && backend !== 'basic_text';
  let roundtrip = false;
  if (secure) {
    const probe = 'Database Workspace secure storage check';
    roundtrip = safeStorage.decryptString(safeStorage.encryptString(probe)) === probe;
  }
  console.log(${JSON.stringify(marker)} + JSON.stringify({ backend, available, roundtrip }));
  app.exit(secure && roundtrip ? 0 : 1);
}).catch(() => app.exit(1));
`, 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let child;
const stop = () => child?.kill('SIGKILL');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const result = await new Promise((resolve, reject) => {
    child = spawn(electronPath, [entry, ...args], {
      env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, 30_000);
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-64 * 1024); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
  const line = result.output.split(/\r?\n/).find((value) => value.startsWith(marker));
  if (line) console.log(JSON.stringify(JSON.parse(line.slice(marker.length)), null, 2));
  if (result.code !== 0 || !line) {
    console.error(result.timedOut
      ? 'Secure storage check timed out; unlock the keyring before retrying.'
      : 'Secure credential storage is unavailable. On Linux/WSL, install and unlock a Secret Service keyring; see docs/USER_GUIDE.md. Plaintext fallback is not allowed.');
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  stop();
  await rm(dir, { recursive: true, force: true });
}
