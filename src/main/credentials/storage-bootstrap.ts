// Typed entry for the app; the source MJS policy is shared with the unbuilt probe.
export { bootstrapSecureStorage, selectStorageBackend } from './storage-bootstrap.mjs';
export type {
  StorageBootstrapApp,
  StorageBootstrapEnvironment,
  StorageBootstrapOptions,
  StorageSelection,
} from './storage-bootstrap.mjs';
