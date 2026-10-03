import type { Store } from '../application/services/store';
export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface Credentials {
  get(id: string): string | undefined;
  set(id: string, secret: string): void;
  delete(id: string): void;
}
export class CredentialService implements Credentials {
  constructor(
    private store: Store<Record<string, string>>,
    private encryption: EncryptionProvider,
  ) {}
  get(id: string) {
    const encrypted = this.store.read()[id];
    if (!encrypted) return undefined;
    this.requireEncryption();
    return this.encryption.decryptString(Buffer.from(encrypted, 'base64'));
  }
  set(id: string, secret: string) {
    this.requireEncryption();
    const data = this.store.read();
    data[id] = this.encryption.encryptString(secret).toString('base64');
    this.store.write(data);
  }
  delete(id: string) {
    const data = this.store.read();
    delete data[id];
    this.store.write(data);
  }
  private requireEncryption() {
    if (!this.encryption.isEncryptionAvailable()) {
      const hint = process.platform === 'linux'
        ? ' Install and unlock a Secret Service keyring, then restart the app. Run npm run check:secure-storage; see docs/USER_GUIDE.md. Plaintext fallback is not allowed.'
        : '';
      throw new Error(`OS secure credential storage is unavailable.${hint}`);
    }
  }
}
