import type { Store } from '../application/services/store';
import { SecureStorageService, type EncryptionProvider } from './secure-storage-service';
export type { EncryptionProvider } from './secure-storage-service';
export interface Credentials {
  get(id: string): string | undefined;
  set(id: string, secret: string): void;
  delete(id: string): void;
}
export class CredentialService implements Credentials {
  private encryption: SecureStorageService;
  constructor(
    private store: Store<Record<string, string>>,
    encryption: EncryptionProvider,
  ) {
    this.encryption = encryption instanceof SecureStorageService
      ? encryption
      : new SecureStorageService(encryption);
  }
  get(id: string) {
    const encrypted = this.store.read()[id];
    if (!encrypted) return undefined;
    return this.encryption.decryptString(Buffer.from(encrypted, 'base64'));
  }
  set(id: string, secret: string) {
    const data = this.store.read();
    data[id] = this.encryption.encryptString(secret).toString('base64');
    this.store.write(data);
  }
  delete(id: string) {
    const data = this.store.read();
    delete data[id];
    this.store.write(data);
  }
}
