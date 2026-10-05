import { Alert } from './ui/alert';
import { confirmAction } from './ConfirmDialog';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { SelectField } from './SelectField';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { useI18n } from '../i18n';
import { SecureStorageNotice, useSecureStorageStatus } from './SecureStorageNotice';
import { useRef, useState } from 'react';
import type { Settings } from '../../../shared/types';
import { command } from '../api';
export function SettingsPanel({
  initial,
  onClose,
  onSaved,
}: {
  initial: Settings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useI18n();
  const secureStorage = useSecureStorageStatus();
  const [form, setForm] = useState(initial);
  const initialForm = useRef(JSON.stringify(form));
  const requestClose = async () => {
    // Escape and outside clicks must not silently throw away typed input.
    if (
      JSON.stringify(form) !== initialForm.current &&
      !(await confirmAction(t('Discard unsaved changes?')))
    )
      return;
    onClose();
  };
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const patch = (key: keyof Settings, value: unknown) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const mcp = (key: keyof Settings['mcp'], value: unknown) =>
    setForm((previous) => ({ ...previous, mcp: { ...previous.mcp, [key]: value } }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) void requestClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="modal settings"

        aria-labelledby="settings-title"
      >
        <header>
          <DialogTitle id="settings-title">{t('Settings')}</DialogTitle>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('Close')}
            disabled={saving}
            onClick={() => void requestClose()}
          >
            ✕
          </Button>
        </header>
        <div className="settings-content">
          <h3>{t('General')}</h3>
          <div className="form-grid">
            <Label>
              {t('Theme')}
              <SelectField value={form.theme} onValueChange={(event) => patch('theme', event)}>
                {['dark', 'light', 'system'].map((value) => (
                  <option key={value} value={value}>
                    {t(value)}
                  </option>
                ))}
              </SelectField>
            </Label>
            <Label>
              {t('Language')}
              <SelectField
                value={form.language}
                aria-label={t('Language')}
                onValueChange={(event) => patch('language', event)}
              >
                <option value="zh-TW">繁體中文</option>
                <option value="en">English</option>
              </SelectField>
            </Label>
            <Label>
              {t('Default page size')}
              <Input
                type="number"
                value={form.pageSize}
                onChange={(event) => patch('pageSize', Number(event.target.value))}
              />
            </Label>
          </div>
          <h3>{t('Editor & database')}</h3>
          <div className="form-grid">
            {(['fontSize', 'tabSize', 'queryTimeout', 'maxRows'] as const).map((key) => (
              <Label key={key}>
                {
                  {
                    fontSize: t('Font size'),
                    tabSize: t('Tab size'),
                    queryTimeout: t('Query timeout (ms)'),
                    maxRows: t('Maximum result rows'),
                  }[key]
                }
                <Input
                  type="number"
                  value={form[key]}
                  onChange={(event) => patch(key, Number(event.target.value))}
                />
              </Label>
            ))}
            <Label>
              <Checkbox
                checked={form.wordWrap}
                onCheckedChange={(event) => patch('wordWrap', event)}
              />{' '}
              {t('Word wrap')}
            </Label>
          </div>
          <SecureStorageNotice {...secureStorage} />
          <h3>Agent / MCP</h3>
          <div className="form-grid">
            <Label>
              <Checkbox
                checked={form.mcp.enabled}
                onCheckedChange={(event) => mcp('enabled', event)}
              />{' '}
              {t('Enable MCP server')}
            </Label>
            <Label>
              <Checkbox
                checked={form.mcp.remote}
                onCheckedChange={(event) => mcp('remote', event)}
              />{' '}
              {t('Remote access')}
            </Label>
            <Label>
              {t('Listen address')}
              <Input value={form.mcp.host} onChange={(event) => mcp('host', event.target.value)} />
            </Label>
            <Label>
              {t('Port')}
              <Input
                type="number"
                value={form.mcp.port}
                onChange={(event) => mcp('port', Number(event.target.value))}
              />
            </Label>
            <Label className="wide">
              {t('Allowed hosts (comma separated)')}
              <Input
                value={form.mcp.allowedHosts.join(',')}
                onChange={(event) =>
                  mcp(
                    'allowedHosts',
                    event.target.value.split(',').map((value) => value.trim()),
                  )
                }
              />
            </Label>
            {form.mcp.remote && (
              <>
                <Label>
                  {t('TLS certificate path')}
                  <Input
                    value={form.mcp.tlsCert}
                    onChange={(event) => mcp('tlsCert', event.target.value)}
                  />
                </Label>
                <Label>
                  {t('TLS private key path')}
                  <Input
                    value={form.mcp.tlsKey}
                    onChange={(event) => mcp('tlsKey', event.target.value)}
                  />
                </Label>
              </>
            )}
            <Label>
              {t('Agent permission level')}
              <SelectField
                value={form.agentLevel}
                onValueChange={(event) => patch('agentLevel', event)}
              >
                {['observe', 'assist', 'execute'].map((value) => (
                  <option key={value} value={value}>
                    {t(value)}
                  </option>
                ))}
              </SelectField>
            </Label>
            <div className="inline">
              <Button
                variant="outline"
                onClick={() =>
                  void command<{ token: string }>('mcp.token')
                    .then((result) => setToken(result.token))
                    .catch((error) => setError(error.message))
                }
              >
                {t('Reveal access token')}
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  if (await confirmAction(t('Revoke the current token and disconnect all agents?')))
                    void command<{ token: string }>('mcp.rotate_token')
                      .then((result) => setToken(result.token))
                      .catch((error) => setError(error.message));
                }}
              >
                {t('Rotate')}
              </Button>
            </div>
            {token && (
              <Label className="wide">
                {t('Access token')}
                <Input readOnly value={token} onFocus={(event) => event.target.select()} />
              </Label>
            )}
          </div>
          <h3>{t('Security · Agent write policy')}</h3>
          <div className="form-grid">
            {(Object.keys(form.policy) as Array<keyof Settings['policy']>).map((key) => (
              <Label key={key}>
                {t(key)}
                <SelectField
                  value={form.policy[key]}
                  onValueChange={(event) => patch('policy', { ...form.policy, [key]: event })}
                >
                  {['allow', 'ask', 'deny'].map((value) => (
                    <option key={value} value={value}>
                      {t(value)}
                    </option>
                  ))}
                </SelectField>
              </Label>
            ))}
          </div>
          <p className="muted">
            {t('Destructive operations always require approval, even when set to allow.')}
          </p>
        </div>
        <footer>
          {error && (
            <Alert className="notice" role="alert">
              {error}
            </Alert>
          )}
          <div className="settings-actions">
            <Button variant="outline" disabled={saving} onClick={() => void requestClose()}>
              {t('Cancel')}
            </Button>
            <Button
              variant="default"
              className="primary"
              disabled={saving}
              onClick={async () => {
                if (savingRef.current) return;
                savingRef.current = true;
                setSaving(true);
                setError('');
                try {
                  await command('settings.save', form);
                  onSaved();
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  savingRef.current = false;
                  setSaving(false);
                }
              }}
            >
              {t('Save settings')}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
