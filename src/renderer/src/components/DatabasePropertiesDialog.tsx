import { useEffect, useRef, useState } from 'react';
import type {
  DatabaseOptions,
  DatabaseProperties,
  DatabasePropertyChange,
} from '../../../shared/database-options';
import { command } from '../api';
import { useI18n } from '../i18n';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { SelectField } from './SelectField';

export function DatabasePropertiesDialog({
  connectionId,
  database,
  onClose,
}: {
  connectionId: string;
  database: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    running = useRef(false);
  const [properties, setProperties] = useState<DatabaseProperties>();
  const [options, setOptions] = useState<DatabaseOptions>({ charsets: [], collations: [] });
  const [changes, setChanges] = useState<DatabasePropertyChange>({});
  const [search, setSearch] = useState('');
  const [plan, setPlan] = useState<{ sql: string }>();
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const target = { connectionId, database };
  async function perform(action: 'load' | 'preview' | 'apply') {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      if (action === 'load') {
        const value = await command<DatabaseProperties>('database.properties.describe', target);
        const available =
          value.editable.charset || value.editable.collation
            ? await command<DatabaseOptions>('database.options', { connectionId })
            : { charsets: [], collations: [] };
        setProperties(value);
        setOptions(available);
        setChanges({});
        setPlan(undefined);
        setSearch('');
      } else if (action === 'preview')
        setPlan(
          await command('database.properties.preview', {
            ...target,
            changes,
            version: properties!.version,
          }),
        );
      else {
        setProperties(
          await command<DatabaseProperties>('database.properties.apply', {
            ...target,
            changes,
            version: properties!.version,
          }),
        );
        setChanges({});
        setPlan(undefined);
        setSearch('');
      }
    } catch (error) {
      setError((error as Error).message);
      setPlan(undefined);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    void perform('load');
  }, [connectionId, database]);
  const edit = (value: DatabasePropertyChange) => {
    setChanges(value);
    setPlan(undefined);
    setError('');
  };
  const charset = changes.charset ?? properties?.charset ?? '';
  const collation = changes.collation ?? (changes.charset ? '' : (properties?.collation ?? ''));
  const matches = options.collations.filter(
    (c) =>
      (!properties?.editable.charset || c.charset === charset) &&
      c.name.toLowerCase().includes(search.toLowerCase()),
  );
  const visible = matches.slice(0, 200);
  const selected = options.collations.find((c) => c.name === collation);
  if (selected && !visible.includes(selected)) visible.unshift(selected);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="modal database-create"
        aria-label={t('Database properties')}
      >
        <header>
          <DialogTitle>{t('Database properties')}</DialogTitle>
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            aria-label={t('Close')}
            onClick={onClose}
          >
            ✕
          </Button>
        </header>
        <p>
          <strong>{database}</strong>
        </p>
        {properties && (
          <>
            <p className="muted">{t(properties.notice)}</p>
            {properties.charset && (
              <Label className="flex-col items-stretch">
                {t('Character set')}
                {properties.editable.charset ? (
                  <SelectField
                    aria-label={t('Character set')}
                    value={charset}
                    disabled={busy}
                    onValueChange={(value) =>
                      edit(value === properties.charset ? {} : { charset: value })
                    }
                  >
                    {options.charsets.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </SelectField>
                ) : (
                  <Input aria-label={t('Character set')} value={properties.charset} readOnly />
                )}
              </Label>
            )}
            {properties.editable.collation && (
              <Label className="flex-col items-stretch">
                {t('Search collations')}
                <Input
                  aria-label={t('Search collations')}
                  disabled={busy}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </Label>
            )}
            {properties.collation && (
              <Label className="flex-col items-stretch">
                {t('Collation')}
                {properties.editable.collation ? (
                  <SelectField
                    aria-label={t('Collation')}
                    value={collation}
                    disabled={busy}
                    onValueChange={(value) => edit({ ...changes, collation: value || undefined })}
                  >
                    {changes.charset && <option value="">{t('Default collation')}</option>}
                    {visible.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </SelectField>
                ) : (
                  <Input aria-label={t('Collation')} value={properties.collation} readOnly />
                )}
              </Label>
            )}
            {matches.length > 200 && (
              <small>{t('Showing the first 200 matches. Search to narrow the list.')}</small>
            )}
            {(['localeProvider', 'locale', 'lcCtype'] as const).map(
              (key, i) =>
                properties[key] && (
                  <Label key={key} className="flex-col items-stretch">
                    {t(['Locale provider', 'Locale', 'Character classification (LC_CTYPE)'][i])}
                    <Input readOnly value={properties[key]} />
                  </Label>
                ),
            )}
          </>
        )}
        {plan && (
          <pre className="overflow-auto whitespace-pre-wrap break-all max-h-40">{plan.sql};</pre>
        )}
        {error && <Alert role="alert">{error}</Alert>}
        <footer>
          <Button variant="outline" disabled={busy} onClick={() => void perform('load')}>
            {t('Refresh')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('Close')}
          </Button>
          {properties && (properties.editable.charset || properties.editable.collation) && (
            <>
              <Button
                variant="outline"
                disabled={busy || !Object.values(changes).some(Boolean)}
                onClick={() => void perform('preview')}
              >
                {t('Preview SQL')}
              </Button>
              <Button disabled={busy || !plan} onClick={() => void perform('apply')}>
                {t('Apply')}
              </Button>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
