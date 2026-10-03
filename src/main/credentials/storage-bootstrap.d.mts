import type { SecureStorageStatus } from '../../shared/types';

export interface StorageBootstrapOptions {
  platform?: string;
  env?: Readonly<Record<string, string | undefined>>;
  osRelease?: string;
}
export interface StorageBootstrapEnvironment {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  osRelease: string;
  /** Undefined means absent; an empty string still means an explicit switch. */
  explicitPasswordStore?: string;
}
export interface StorageBootstrapApp {
  isReady(): boolean;
  commandLine: {
    hasSwitch(name: string): boolean;
    getSwitchValue(name: string): string;
    appendSwitch(name: string, value?: string): void;
  };
}
export interface StorageSelection {
  readonly selectionSource: SecureStorageStatus['selectionSource'];
  /** Requested switch value, not a claim about the initialized backend. */
  readonly passwordStore: string | null;
  readonly restartRequired: boolean;
}
export function selectStorageBackend(environment: StorageBootstrapEnvironment): StorageSelection;
export function bootstrapSecureStorage(app: StorageBootstrapApp, options?: StorageBootstrapOptions): StorageSelection;
