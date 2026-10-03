import { release } from 'node:os';

// This source module is also imported directly by the isolated Electron probe.
// Keep it independent of Electron imports and of built files; Vite bundles it
// into the main entry for development and packaged/ASAR execution.
const selections = new WeakMap();
const nativeDesktop = /^(gnome(?:[-_].*)?|kde(?:[3456]|[-_].*)?|plasma(?:[456]|wayland|[-_].*)?|x-cinnamon|cinnamon|deepin|pantheon|xfce(?:4)?|xubuntu|ukui|unity|ubuntu|mate|lxqt|cosmic)$/i;

/** @param {import('./storage-bootstrap.mjs').StorageBootstrapEnvironment} environment */
export function selectStorageBackend(environment) {
  const { platform, env, osRelease, explicitPasswordStore } = environment;
  if (explicitPasswordStore !== undefined) {
    return Object.freeze({ selectionSource: 'explicit', passwordStore: explicitPasswordStore, restartRequired: false });
  }
  const native = { selectionSource: 'native', passwordStore: null, restartRequired: false };
  if (platform !== 'linux') return Object.freeze(native);

  // Recognized desktops retain Electron's own choice (including KDE versions).
  // Consider both modern XDG names and legacy session hints. Never rewrite env.
  const desktops = [env.XDG_CURRENT_DESKTOP, env.DESKTOP_SESSION, env.GDMSESSION]
    .filter(Boolean).flatMap((value) => value.split(/[:;\s]+/));
  if (desktops.some((desktop) => nativeDesktop.test(desktop)) ||
      env.GNOME_DESKTOP_SESSION_ID !== undefined || env.KDE_FULL_SESSION !== undefined) {
    return Object.freeze(native);
  }

  const wsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft|\bwsl\b/i.test(osRelease);
  return Object.freeze(wsl
    ? { selectionSource: 'wsl-libsecret', passwordStore: 'gnome-libsecret', restartRequired: false }
    : native);
}

/**
 * Run synchronously before app ready and before any safeStorage access.
 * Electron's parsed commandLine is authoritative, including duplicate switches,
 * switches appended by a launcher, and an explicitly empty switch value.
 * This only selects a candidate: it never asserts availability or enables basic.
 * @param {import('./storage-bootstrap.mjs').StorageBootstrapApp} app
 * @param {import('./storage-bootstrap.mjs').StorageBootstrapOptions} [options]
 */
export function bootstrapSecureStorage(app, options = {}) {
  const previous = selections.get(app);
  if (previous) return previous;
  const selection = selectStorageBackend({
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    osRelease: options.osRelease ?? release(),
    explicitPasswordStore: app.commandLine.hasSwitch('password-store')
      ? app.commandLine.getSwitchValue('password-store')
      : undefined,
  });
  let result = selection;
  if (selection.selectionSource === 'wsl-libsecret') {
    if (app.isReady()) {
      // Do not misreport a candidate as applied when it is already too late.
      result = Object.freeze({ selectionSource: 'native', passwordStore: null, restartRequired: true });
    } else {
      app.commandLine.appendSwitch('password-store', selection.passwordStore);
    }
  }
  selections.set(app, result);
  return result;
}
