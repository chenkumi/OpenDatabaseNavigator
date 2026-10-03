import { useId } from 'react';
import type { DatabaseOptions, DatabaseCreateOptions } from '../../../shared/database-options';
import { useI18n } from '../i18n';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { SelectField } from './SelectField';

export function PostgresDatabaseOptions({
  options,
  value,
  onChange,
  disabled,
}: {
  options?: DatabaseOptions['postgres'];
  value: DatabaseCreateOptions;
  onChange: (value: DatabaseCreateOptions) => void;
  disabled: boolean;
}) {
  const t = useI18n(),
    id = useId();
  const provider = value.localeProvider || 'libc';
  return (
    <div className="grid gap-3">
      {!!options?.providers.length && (
        <Label className="flex-col items-stretch">
          {t('Locale provider')}
          <SelectField
            aria-label={t('Locale provider')}
            disabled={disabled}
            value={value.localeProvider || ''}
            onValueChange={(next) =>
              onChange({ localeProvider: next ? (next as 'libc' | 'icu' | 'builtin') : undefined })
            }
          >
            <option value="">{t('Server default')}</option>
            {options.providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </SelectField>
        </Label>
      )}
      <Label className="flex-col items-stretch">
        {t('Locale')}
        <Input
          aria-label={t('Locale')}
          list={id}
          disabled={disabled}
          maxLength={256}
          placeholder={provider === 'icu' ? 'zh-Hant-TW' : 'C'}
          value={value.locale || ''}
          onChange={(event) => onChange({ ...value, locale: event.target.value || undefined })}
        />
        <datalist id={id}>
          {options?.locales
            .filter((l) => l.provider === provider)
            .map((l) => (
              <option key={l.name} value={l.name} />
            ))}
        </datalist>
      </Label>
      {provider === 'libc' && (
        <Label className="flex-col items-stretch">
          {t('Character classification (LC_CTYPE)')}
          <Input
            aria-label={t('Character classification (LC_CTYPE)')}
            disabled={disabled}
            maxLength={256}
            placeholder={t('Same as locale')}
            value={value.lcCtype || ''}
            onChange={(event) => onChange({ ...value, lcCtype: event.target.value || undefined })}
          />
        </Label>
      )}
      <p className="muted">
        {t(
          'PostgreSQL encoding and locale cannot be changed after creation. Locale names must be supported by the server; ICU requires UTF8.',
        )}
      </p>
    </div>
  );
}
