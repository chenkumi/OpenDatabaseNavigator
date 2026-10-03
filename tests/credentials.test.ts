import { expect, it, vi } from 'vitest';
import { CredentialService } from '../src/main/credentials/credential-service';
import { MemoryStore, JsonStore } from '../src/main/application/services/store';
import { SecureStorageService } from '../src/main/credentials/secure-storage-service';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('rejects secret writes without secure storage and never persists plaintext', () => {
  const store = new MemoryStore<Record<string, string>>({});
  const encryptString = vi.fn();
  const credentials = new CredentialService(store, {
    isEncryptionAvailable: () => false,
    encryptString,
    decryptString: vi.fn(),
  });
  expect(() => credentials.set('connection', 'not-a-real-secret')).toThrow(
    'OS secure credential storage is unavailable.',
  );
  expect(encryptString).not.toHaveBeenCalled();
  expect(store.read()).toEqual({});
});

it('does not attempt to decrypt existing secrets while the secure backend is unavailable', () => {
  const store = new MemoryStore({ connection: 'ZW5jcnlwdGVk' });
  const decryptString = vi.fn();
  const credentials = new CredentialService(store, {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString,
  });
  expect(() => credentials.get('connection')).toThrow('OS secure credential storage is unavailable.');
  expect(decryptString).not.toHaveBeenCalled();
  expect(credentials.get('missing')).toBeUndefined();
  expect(store.read()).toEqual({ connection: 'ZW5jcnlwdGVk' });
});

it('provides actionable Linux keyring guidance without exposing the secret', () => {
  if (process.platform !== 'linux') return;
  const credentials = new CredentialService(new MemoryStore({}), {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  });
  let message = '';
  try { credentials.set('connection', 'not-a-real-secret'); }
  catch (error) { message = (error as Error).message; }
  expect(message).toContain('Install and unlock a Secret Service keyring');
  expect(message).toContain('npm run check:secure-storage');
  expect(message).not.toContain('not-a-real-secret');
});

it.each(['unavailable', 'basic', 'probe-throws', 'probe-mismatch', 'restart-required'])
  ('keeps the credential file byte-identical on denied get/set: %s', (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'dw-credential-test-'));
    try {
      const path = join(directory, 'credentials.json');
      const store = new JsonStore<Record<string, string>>(path, {});
      store.write({ connection: Buffer.from('existing-encrypted-test-value').toString('base64') });
      const before = readFileSync(path);
      const provider = {
        isEncryptionAvailable: () => mode !== 'unavailable',
        getSelectedStorageBackend: () => mode === 'basic' ? 'basic_text' : 'gnome_libsecret',
        encryptString: vi.fn((value: string) => {
          if (mode === 'probe-throws') throw new Error('private OS detail and secret');
          return Buffer.from(value);
        }),
        decryptString: vi.fn((value: Buffer) => mode === 'probe-mismatch' ? 'wrong' : value.toString()),
      };
      const storage = new SecureStorageService(provider, {
        selectionSource: 'native', restartRequired: mode === 'restart-required',
      }, 'linux');
      const credentials = new CredentialService(store, storage);
      for (const action of [() => credentials.get('connection'), () => credentials.set('connection', 'new-test-secret')]) {
        let message = '';
        try { action(); } catch (error) { message = (error as Error).message; }
        expect(message).toContain('OS secure credential storage is unavailable.');
        for (const sensitive of ['new-test-secret', 'existing-encrypted-test-value', 'private OS detail']) {
          expect(message).not.toContain(sensitive);
          expect(JSON.stringify(storage.getStatus())).not.toContain(sensitive);
        }
        expect(readFileSync(path).equals(before)).toBe(true);
      }
      expect(provider.encryptString.mock.calls.some(([value]) => value === 'new-test-secret')).toBe(false);
      expect(provider.decryptString.mock.calls.some(([value]) => value.toString() === 'existing-encrypted-test-value')).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

it('supports healthy encrypted roundtrips and deletion without persisting plaintext', () => {
  const store = new MemoryStore<Record<string, string>>({});
  const provider = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
  };
  const credentials = new CredentialService(store, new SecureStorageService(provider, undefined, 'linux'));
  credentials.set('connection', 'synthetic-secret');
  expect(JSON.stringify(store.read())).not.toContain('synthetic-secret');
  expect(credentials.get('connection')).toBe('synthetic-secret');
  credentials.delete('connection');
  expect(store.read()).toEqual({});
});

it.each(['encrypt', 'decrypt'])('sanitizes actual %s errors after a successful health probe', (operation) => {
  const stored = Buffer.from('existing-ciphertext').toString('base64');
  const store = new MemoryStore({ connection: stored });
  const provider = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => {
      if (value === 'synthetic-secret') throw new Error('synthetic-secret private OS error');
      return Buffer.from(value);
    },
    decryptString: (value: Buffer) => {
      if (value.toString() === 'existing-ciphertext') throw new Error('existing-ciphertext private OS error');
      return value.toString();
    },
  };
  const storage = new SecureStorageService(provider, undefined, 'linux');
  const credentials = new CredentialService(store, storage);
  let message = '';
  try {
    if (operation === 'encrypt') credentials.set('connection', 'synthetic-secret');
    else credentials.get('connection');
  } catch (error) { message = (error as Error).message; }
  expect(message).toContain('OS secure credential storage is unavailable.');
  expect(message).not.toMatch(/synthetic-secret|existing-ciphertext|private OS error/);
  expect(store.read()).toEqual({ connection: stored });
  expect(storage.getStatus()).toMatchObject({ available: false, reason: 'unavailable' });
});
