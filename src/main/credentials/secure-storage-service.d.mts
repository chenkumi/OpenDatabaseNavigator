import type { SecureStorageStatus } from '../../shared/types';
import type { CommandBus } from '../application/commands/command-bus';

export function registerSecureStorageCommands(
  commands: Pick<CommandBus, 'register'>,
  storage: Pick<SecureStorageService, 'status'>,
): void;

export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface SecureStorageSelection {
  readonly selectionSource: SecureStorageStatus['selectionSource'];
  readonly restartRequired: boolean;
}
export class SecureStorageService implements EncryptionProvider {
  constructor(encryption: EncryptionProvider, selection?: SecureStorageSelection, platform?: string);
  /** Last measurement, initially not-checked; never initializes safeStorage. */
  getStatus(): Readonly<SecureStorageStatus>;
  /** Perform a fresh nonsecret encryption/decryption health measurement. */
  status(): Readonly<SecureStorageStatus>;
  recheck(): Readonly<SecureStorageStatus>;
  requireEncryption(): void;
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
