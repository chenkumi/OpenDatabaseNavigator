import { useCallback, useEffect, useRef, useState } from 'react';
import type { SecureStorageStatus } from '../../../shared/types';
import { command } from '../api';
import { useI18n } from '../i18n';
import { Button } from './ui/button';

/** Only nonsecret diagnostics cross the fixed command bridge. */
export function useSecureStorageStatus() {
  const [status, setStatus] = useState<SecureStorageStatus>();
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef<Promise<SecureStorageStatus | undefined> | undefined>(undefined);
  const recheck = useCallback((): Promise<SecureStorageStatus | undefined> => {
    if (inFlight.current) return inFlight.current;
    setChecking(true);
    setFailed(false);
    const request = command<SecureStorageStatus>('credentials.status')
      .then((result) => {
        if (mounted.current) setStatus(result);
        return result;
      })
      .catch(() => {
        if (mounted.current) {
          setStatus(undefined);
          setFailed(true);
        }
        return undefined;
      })
      .finally(() => {
        inFlight.current = undefined;
        if (mounted.current) setChecking(false);
      });
    inFlight.current = request;
    return request;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void recheck();
    return () => {
      mounted.current = false;
    };
  }, [recheck]);
  return { status, checking, failed, recheck };
}

export function SecureStorageNotice({
  status,
  checking,
  failed,
  recheck,
}: ReturnType<typeof useSecureStorageStatus>) {
  const t = useI18n();
  const unavailable = status && !status.available;
  const sources = {
    explicit: 'Explicit backend selection',
    native: 'Native platform default',
    'wsl-libsecret': 'WSL libsecret default',
  };
  const reasons = {
    'not-checked': 'Not checked',
    available: 'Available',
    unavailable: 'Unavailable',
    'basic-text': 'Plaintext backend rejected',
    'restart-required': 'Restart required',
  };
  return (
    <section className="secure-storage-notice" aria-label={t('Secure credential storage')}>
      <div className="secure-storage-heading">
        <h3>{t('Secure credential storage')}</h3>
        <Button
          size="sm"
          variant="outline"
          type="button"
          data-testid="secure-storage-recheck"
          disabled={checking}
          onClick={() => void recheck()}
        >
          {t('Recheck secure storage')}
        </Button>
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-busy={checking}
        data-testid="secure-storage-status"
        data-available={status ? String(status.available) : 'unknown'}
        data-backend={status?.backend}
        data-selection-source={status?.selectionSource}
        data-reason={status?.reason}
      >
        {checking
          ? t('Checking secure storage…')
          : failed
            ? t('Could not check secure storage. Recheck to try again.')
            : status
              ? t(status.available ? 'Available' : 'Unavailable')
              : t('Not checked')}
        {status && (
          <p className="muted secure-storage-metadata">
            {t('Backend: {backend} · Selection: {source}', {
              backend: status.backend,
              source: t(sources[status.selectionSource]),
            })}
          </p>
        )}
      </div>
      {unavailable && (
        <div data-testid="secure-storage-guidance" className="secure-storage-guidance">
          <p>
            {t(reasons[status.reason])}.{' '}
            {t(
              'Passwords cannot be saved until secure storage is available. SQLite and passwordless connections can still be saved.',
            )}
          </p>
          <p>
            {t(
              'This check cannot tell whether a keyring is missing, locked, or unreachable. Plaintext fallback is not allowed.',
            )}
          </p>
          {status.platform === 'linux' ? (
            <>
              <p>
                {t(
                  'Linux: install a Secret Service provider if needed, then unlock its keyring in your desktop session. For GNOME, open Passwords and Keys (Seahorse), right-click the login keyring and choose Unlock.',
                )}
              </p>
              <p>
                {t(
                  'Ubuntu installation example (manual only; the app does not run these commands):',
                )}
              </p>
              <pre>sudo apt update{'\n'}sudo apt install libsecret-1-0 gnome-keyring seahorse</pre>
              <p>
                {t(
                  'Other Linux distributions: use the equivalent packages from your distribution. WSL also needs a running Secret Service and an accessible desktop D-Bus session; installed packages alone do not guarantee availability.',
                )}
              </p>
            </>
          ) : status.platform === 'darwin' ? (
            <p>
              {t(
                'macOS: open Keychain Access, unlock the login keychain if locked, and allow this app access when prompted. Contact your administrator if access is restricted.',
              )}
            </p>
          ) : status.platform === 'win32' ? (
            <p>
              {t(
                'Windows: secure storage uses your Windows account protection. Sign in to your normal Windows account and contact your administrator if account protection is unavailable.',
              )}
            </p>
          ) : (
            <p>
              {t(
                'Check that your operating system credential store is available in your signed-in desktop session. Contact your administrator for setup help.',
              )}
            </p>
          )}
          <p data-testid="secure-storage-restart-hint">
            {t(
              status.restartRequired
                ? 'Restart the app to retry the selected backend, then recheck secure storage.'
                : 'After installing or unlocking the credential store, recheck secure storage. If the selected backend is still unavailable, restart the app and recheck.',
            )}
          </p>
        </div>
      )}
    </section>
  );
}
