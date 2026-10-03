// Shared runtime for the desktop application and isolated Electron diagnostic.
// No Electron imports, environment overrides, backend switching, or secret logging.
import { z } from 'zod';

/** Desktop-only diagnostics: no credential lookup, backend mutation, or secrets. */
export function registerSecureStorageCommands(commands, storage) {
  commands.register('credentials.status', {
    schema: z.object({}).strict(),
    humanOnly: true,
    risk: 'read',
    description: 'Check OS secure credential storage health without reading credentials.',
    execute: () => storage.status(),
  });
}

const PROBE = 'Database Workspace secure storage health check';
const BACKENDS = new Set(['basic_text', 'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'unknown']);

export class SecureStorageService {
  constructor(encryption, selection = { selectionSource: 'native', restartRequired: false }, platform = process.platform) {
    this.encryption = encryption;
    this.platform = platform;
    this.selection = Object.freeze({ selectionSource: selection.selectionSource, restartRequired: selection.restartRequired });
    this.current = this.result('unknown', false, 'not-checked');
  }

  result(backend, available, reason) {
    return Object.freeze({
      platform: this.platform, backend, available,
      selectionSource: this.selection.selectionSource, reason,
      restartRequired: this.selection.restartRequired,
    });
  }

  // Snapshot does not initialize safeStorage. status/recheck intentionally measure
  // again so unlocking an existing keyring can recover without switching backends.
  getStatus() { return this.current; }
  status() { return this.recheck(); }
  recheck() {
    let backend = this.platform === 'linux' ? 'unknown' : this.platform;
    let available = false;
    let reason = 'unavailable';
    try {
      // Measure first so Electron initializes its native choice before reporting
      // the selected backend. Even basic_text may report true; never trust that.
      const reportedAvailable = this.encryption.isEncryptionAvailable();
      if (this.platform === 'linux' && this.encryption.getSelectedStorageBackend) {
        const selected = this.encryption.getSelectedStorageBackend();
        backend = BACKENDS.has(selected) ? selected : 'unknown';
      }
      if (backend === 'basic_text') reason = 'basic-text';
      else if (reportedAvailable && !this.selection.restartRequired) {
        available = this.encryption.decryptString(this.encryption.encryptString(PROBE)) === PROBE;
        if (available) reason = 'available';
      }
    } catch {
      // Missing, locked, failed probes and driver exceptions are intentionally
      // indistinguishable. Never relay OS messages or probe ciphertext.
      available = false;
      reason = backend === 'basic_text' ? 'basic-text' : 'unavailable';
    }
    if (this.selection.restartRequired) {
      available = false;
      reason = 'restart-required';
    }
    this.current = this.result(backend, available, reason);
    return this.current;
  }

  unavailableError() {
    const hint = this.platform === 'linux'
      ? ' Install and unlock a Secret Service keyring, then restart the app. Run npm run check:secure-storage; see docs/USER_GUIDE.md. Plaintext fallback is not allowed.'
      : '';
    return new Error(`OS secure credential storage is unavailable.${hint}`);
  }
  requireEncryption() {
    if (!this.recheck().available) throw this.unavailableError();
  }
  isEncryptionAvailable() { return this.recheck().available; }
  encryptString(value) {
    this.requireEncryption();
    try { return this.encryption.encryptString(value); }
    catch { this.current = this.result(this.current.backend, false, 'unavailable'); throw this.unavailableError(); }
  }
  decryptString(value) {
    this.requireEncryption();
    try { return this.encryption.decryptString(value); }
    catch { this.current = this.result(this.current.backend, false, 'unavailable'); throw this.unavailableError(); }
  }
}
