// Probe the real Electron safeStorage backend without reading existing secrets.
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const policyUrl = new URL('../src/main/credentials/storage-bootstrap.mjs', import.meta.url).href;
const serviceUrl = new URL('../src/main/credentials/secure-storage-service.mjs', import.meta.url).href;
const args = process.argv.slice(2);
if (args.some((arg) => !/^--password-store(?:=[^\s]*)?$/.test(arg))) {
  console.error('Usage: npm run check:secure-storage -- [--password-store=<backend>]');
  process.exit(1);
}
const dir = await mkdtemp(join(tmpdir(), 'dw-storage-check-'));
const entry = join(dir, 'check.mjs');
const marker = 'DW_STORAGE_CHECK=';
await writeFile(entry, `
import { app, safeStorage } from 'electron';
import { bootstrapSecureStorage } from ${JSON.stringify(policyUrl)};
import { SecureStorageService } from ${JSON.stringify(serviceUrl)};
const selection = bootstrapSecureStorage(app);
app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
app.whenReady().then(() => {
  const status = new SecureStorageService(safeStorage, selection).status();
  console.log(${JSON.stringify(marker)} + JSON.stringify(status));
  app.exit(status.available ? 0 : 1);
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
