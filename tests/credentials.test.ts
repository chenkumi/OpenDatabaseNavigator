import { expect, it, vi } from 'vitest';
import { CredentialService } from '../src/main/credentials/credential-service';
import { MemoryStore } from '../src/main/application/services/store';

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
