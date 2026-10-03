import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapSecureStorage,
  selectStorageBackend,
  type StorageBootstrapApp,
  type StorageBootstrapOptions,
} from '../src/main/credentials/storage-bootstrap';
import { bootstrapSecureStorage as sourceBootstrap } from '../src/main/credentials/storage-bootstrap.mjs';
import { SecureStorageService, registerSecureStorageCommands } from '../src/main/credentials/secure-storage-service';
import { SecureStorageService as SourceService } from '../src/main/credentials/secure-storage-service.mjs';
import { CommandBus } from '../src/main/application/commands/command-bus';
import { EventBus } from '../src/main/application/events/event-bus';
import { MemoryStore } from '../src/main/application/services/store';
import { PermissionService } from '../src/main/mcp/permissions/permission-service';
import { AuditService } from '../src/main/mcp/audit/audit-service';
import { DEFAULT_SETTINGS } from '../src/shared/types';

const wsl: StorageBootstrapOptions = {
  platform: 'linux', env: { WSL_DISTRO_NAME: 'Test' }, osRelease: '6.6.0',
};
const native = { selectionSource: 'native', passwordStore: null, restartRequired: false } as const;
const candidate = { selectionSource: 'wsl-libsecret', passwordStore: 'gnome-libsecret', restartRequired: false } as const;

function fakeApp(value?: string, ready = false) {
  const switches = new Map<string, string>();
  if (value !== undefined) switches.set('password-store', value);
  const app: StorageBootstrapApp = {
    isReady: vi.fn(() => ready),
    commandLine: {
      hasSwitch: vi.fn((name) => switches.has(name)),
      getSwitchValue: vi.fn((name) => switches.get(name) ?? ''),
      appendSwitch: vi.fn((name, next = '') => { switches.set(name, next); }),
    },
  };
  return { app, switches };
}

function select(platform: string, env: Record<string, string | undefined>, osRelease = '6.6.0') {
  return selectStorageBackend({ platform, env, osRelease });
}

describe('secure storage bootstrap decision matrix', () => {
  it('uses exactly the same runtime implementation as the unbuilt Electron probe', () => {
    expect(bootstrapSecureStorage).toBe(sourceBootstrap);
  });

  it.each(['win32', 'darwin', 'freebsd'])('leaves %s native even with WSL hints', (platform) => {
    expect(select(platform, { WSL_DISTRO_NAME: 'Test' }, 'microsoft-standard-WSL2')).toEqual(native);
  });

  it.each([
    {}, { XDG_CURRENT_DESKTOP: 'unknown' }, { XDG_CURRENT_DESKTOP: 'mygnome' },
    { XDG_CURRENT_DESKTOP: 'some-KDE-like' }, { DESKTOP_SESSION: 'custom' },
  ])('leaves unidentified non-WSL Linux native: %j', (env) => {
    expect(select('linux', env)).toEqual(native);
  });

  it.each([
    { WSL_DISTRO_NAME: 'Test' }, { WSL_INTEROP: '/run/WSL/test_interop' },
    { WSL_DISTRO_NAME: 'Test', XDG_CURRENT_DESKTOP: 'unknown' },
    { WSL_DISTRO_NAME: 'Test', XDG_CURRENT_DESKTOP: 'mygnome' },
    { WSL_DISTRO_NAME: 'Test', DESKTOP_SESSION: 'custom' },
  ])('selects libsecret only on unidentified WSL: %j', (env) => {
    expect(select('linux', env)).toEqual(candidate);
  });

  it.each(['4.19.0-Microsoft', '6.6.87.2-microsoft-standard-WSL2', 'test-WSL-kernel'])
    ('recognizes WSL kernel release without environment hints: %s', (osRelease) => {
      expect(select('linux', {}, osRelease)).toEqual(candidate);
    });

  it.each([
    { XDG_CURRENT_DESKTOP: 'GNOME' }, { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' },
    { XDG_CURRENT_DESKTOP: 'GNOME-Classic:GNOME' }, { XDG_CURRENT_DESKTOP: 'KDE' },
    { XDG_CURRENT_DESKTOP: 'KDE5' }, { XDG_CURRENT_DESKTOP: 'KDE6' },
    { XDG_CURRENT_DESKTOP: 'unknown:KDE' }, { XDG_CURRENT_DESKTOP: 'Plasma' },
    { DESKTOP_SESSION: 'gnome' }, { DESKTOP_SESSION: 'gnome-xorg' },
    { DESKTOP_SESSION: 'kde4' }, { DESKTOP_SESSION: 'plasmawayland' },
    { GDMSESSION: 'gnome' }, { XDG_CURRENT_DESKTOP: 'X-Cinnamon' },
    { XDG_CURRENT_DESKTOP: 'XFCE' }, { XDG_CURRENT_DESKTOP: 'Unity' },
    { XDG_CURRENT_DESKTOP: 'LXQt' }, { XDG_CURRENT_DESKTOP: 'COSMIC' },
    { DESKTOP_SESSION: 'mate' }, { DESKTOP_SESSION: 'kde-plasma' },
    { GNOME_DESKTOP_SESSION_ID: '' }, { KDE_FULL_SESSION: 'true', KDE_SESSION_VERSION: '6' },
    { XDG_CURRENT_DESKTOP: 'unknown', DESKTOP_SESSION: 'gnome' },
  ])('preserves recognized desktop selection both on WSL and Linux: %j', (env) => {
    expect(select('linux', env)).toEqual(native);
    expect(select('linux', { ...env, WSL_DISTRO_NAME: 'Test' })).toEqual(native);
  });

  it.each(['basic', 'gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6', '', 'future-backend'])
    ('honors explicit %j over WSL and desktop policy without mutating it', (value) => {
      for (const platform of ['linux', 'win32', 'darwin']) {
        for (const desktop of ['unknown', 'GNOME', 'KDE']) {
          const { app } = fakeApp(value);
          expect(bootstrapSecureStorage(app, {
            ...wsl, platform, env: { WSL_DISTRO_NAME: 'Test', XDG_CURRENT_DESKTOP: desktop },
          })).toEqual({ selectionSource: 'explicit', passwordStore: value, restartRequired: false });
          expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
        }
      }
    });

  it('uses Electron parsed switches (including launcher overrides), not process.argv', () => {
    const { app, switches } = fakeApp('gnome-libsecret');
    // Model Electron's effective last switch/launcher override. Bootstrap must
    // query that effective value, not independently re-parse duplicate argv.
    switches.set('password-store', 'basic');
    expect(bootstrapSecureStorage(app, wsl).passwordStore).toBe('basic');
    expect(app.commandLine.getSwitchValue).toHaveBeenCalledWith('password-store');
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});

describe('pre-ready application and idempotence', () => {
  it('appends only the libsecret candidate once and returns its original provenance after ready', () => {
    const { app } = fakeApp();
    const first = bootstrapSecureStorage(app, wsl);
    expect(first).toEqual(candidate);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith('password-store', 'gnome-libsecret');
    vi.mocked(app.isReady).mockReturnValue(true);
    expect(bootstrapSecureStorage(app, { platform: 'darwin', env: {}, osRelease: '' })).toBe(first);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('does not append after ready, reports restart required, and never retries selection', () => {
    const { app } = fakeApp(undefined, true);
    const first = bootstrapSecureStorage(app, wsl);
    expect(first).toEqual({ ...native, restartRequired: true });
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
    vi.mocked(app.isReady).mockReturnValue(false);
    expect(bootstrapSecureStorage(app, wsl)).toBe(first);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32', 'darwin'])('never mutates a ready native %s app', (platform) => {
    const { app } = fakeApp(undefined, true);
    expect(bootstrapSecureStorage(app, { platform, env: {}, osRelease: '' })).toEqual(native);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it('keeps an explicit basic switch intact even after ready (it is not an encryption fallback)', () => {
    const { app } = fakeApp('basic', true);
    expect(bootstrapSecureStorage(app, wsl)).toEqual({
      selectionSource: 'explicit', passwordStore: 'basic', restartRequired: false,
    });
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it('does not change a native selection on later environment changes', () => {
    const { app } = fakeApp();
    const first = bootstrapSecureStorage(app, { platform: 'linux', env: {}, osRelease: '' });
    expect(bootstrapSecureStorage(app, wsl)).toBe(first);
    expect(first).toEqual(native);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it('isolates bootstrap state per app and never rewrites the environment', () => {
    const env = Object.freeze({ WSL_DISTRO_NAME: 'Test', XDG_CURRENT_DESKTOP: 'unknown' });
    const first = fakeApp();
    const second = fakeApp();
    expect(bootstrapSecureStorage(first.app, { ...wsl, env })).toEqual(candidate);
    expect(bootstrapSecureStorage(second.app, { ...wsl, env })).toEqual(candidate);
    expect(first.app.commandLine.appendSwitch).toHaveBeenCalledTimes(1);
    expect(second.app.commandLine.appendSwitch).toHaveBeenCalledTimes(1);
    expect(env).toEqual({ WSL_DISTRO_NAME: 'Test', XDG_CURRENT_DESKTOP: 'unknown' });
  });
});

function healthyProvider() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString()),
  };
}

describe('secure storage health service', () => {
  it('shares the actual health runtime with the CLI and starts without initialization', () => {
    expect(SecureStorageService).toBe(SourceService);
    const provider = healthyProvider();
    const service = new SecureStorageService(provider, candidate, 'linux');
    expect(service.getStatus()).toEqual({
      platform: 'linux', backend: 'unknown', available: false,
      selectionSource: 'wsl-libsecret', reason: 'not-checked', restartRequired: false,
    });
    expect(provider.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(service.status()).toEqual({
      platform: 'linux', backend: 'gnome_libsecret', available: true,
      selectionSource: 'wsl-libsecret', reason: 'available', restartRequired: false,
    });
    expect(provider.encryptString).toHaveBeenCalledExactlyOnceWith('Database Workspace secure storage health check');
    expect(Object.isFrozen(service.getStatus())).toBe(true);
    expect(Object.keys(service.getStatus()).sort()).toEqual([
      'available', 'backend', 'platform', 'reason', 'restartRequired', 'selectionSource',
    ]);
  });

  it.each(['missing', 'locked'])('does not infer %s from availability false', () => {
    const provider = healthyProvider();
    provider.isEncryptionAvailable.mockReturnValue(false);
    const status = new SecureStorageService(provider, native, 'linux').status();
    expect(status).toMatchObject({ available: false, reason: 'unavailable', backend: 'gnome_libsecret' });
    expect(provider.encryptString).not.toHaveBeenCalled();
    expect(provider.decryptString).not.toHaveBeenCalled();
  });

  it('rejects basic_text even when Electron reports available', () => {
    const provider = healthyProvider();
    provider.getSelectedStorageBackend.mockReturnValue('basic_text');
    const service = new SecureStorageService(provider, { ...native, selectionSource: 'explicit' }, 'linux');
    expect(service.status()).toMatchObject({ available: false, reason: 'basic-text', backend: 'basic_text' });
    expect(provider.isEncryptionAvailable).toHaveBeenCalledOnce();
    expect(() => service.encryptString('never-encrypt-this')).toThrow('OS secure credential storage is unavailable.');
    expect(provider.encryptString).not.toHaveBeenCalled();
    expect(provider.decryptString).not.toHaveBeenCalled();
  });

  it.each(['getSelectedStorageBackend', 'isEncryptionAvailable', 'encryptString', 'decryptString'] as const)
    ('sanitizes exceptions from %s', (method) => {
      const provider = healthyProvider();
      provider[method].mockImplementation(() => { throw new Error('secret/ciphertext/OS detail'); });
      const status = new SecureStorageService(provider, candidate, 'linux').status();
      expect(status).toMatchObject({ available: false, reason: 'unavailable' });
      expect(JSON.stringify(status)).not.toContain('secret/ciphertext');
    });

  it('treats a failed roundtrip as unavailable and recovers on a later recheck', () => {
    const provider = healthyProvider();
    provider.decryptString.mockReturnValueOnce('wrong-roundtrip');
    const service = new SecureStorageService(provider, native, 'linux');
    expect(service.status().available).toBe(false);
    expect(service.recheck().available).toBe(true);
    provider.isEncryptionAvailable.mockReturnValue(false);
    expect(service.status().available).toBe(false);
    provider.isEncryptionAvailable.mockReturnValue(true);
    expect(service.recheck().available).toBe(true);
    expect(service.getStatus().selectionSource).toBe('native');
  });

  it('preserves restart-required and never initializes a replacement backend', () => {
    const provider = healthyProvider();
    const service = new SecureStorageService(provider, { ...native, restartRequired: true }, 'linux');
    for (let i = 0; i < 2; i++) {
      expect(service.recheck()).toMatchObject({
        backend: 'gnome_libsecret', available: false, reason: 'restart-required', restartRequired: true,
      });
    }
    expect(provider.isEncryptionAvailable).toHaveBeenCalledTimes(2);
    expect(provider.encryptString).not.toHaveBeenCalled();
  });

  it.each(['win32', 'darwin'])('measures %s without Linux backend access', (platform) => {
    const provider = healthyProvider();
    expect(new SecureStorageService(provider, native, platform).status())
      .toMatchObject({ platform, backend: platform, available: true });
    expect(provider.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it('does not echo unexpected backend text', () => {
    const provider = healthyProvider();
    provider.getSelectedStorageBackend.mockReturnValue('unexpected-secret');
    expect(new SecureStorageService(provider, native, 'linux').status().backend).toBe('unknown');
  });
});

it('registers strict desktop-only status; denies agents and omits their tools', async () => {
  const events = new EventBus();
  const permissions = new PermissionService(() => DEFAULT_SETTINGS, events);
  const audit = new AuditService(new MemoryStore([]), events);
  const commands = new CommandBus(permissions, audit, events, () => { throw new Error('No connection expected'); });
  const service = new SecureStorageService(healthyProvider(), candidate, 'linux');
  const status = vi.spyOn(service, 'status');
  registerSecureStorageCommands(commands, service);
  expect(commands.tools().some((tool) => tool.name === 'credentials.status')).toBe(false);
  expect((await commands.dispatch('credentials.status', {}, { kind: 'agent', id: 'test-agent', name: 'Test agent' })).success).toBe(false);
  expect(status).not.toHaveBeenCalled();
  for (const args of [{ key: 'not-allowed' }, null, undefined, [], '']) {
    expect((await commands.dispatch('credentials.status', args, { kind: 'human', id: 'desktop', name: 'Desktop' })).success).toBe(false);
  }
  expect(status).not.toHaveBeenCalled();
  expect(await commands.dispatch('credentials.status', {}, { kind: 'human', id: 'desktop', name: 'Desktop' }))
    .toEqual({ success: true, data: service.getStatus() });
  expect(status).toHaveBeenCalledOnce();
});
