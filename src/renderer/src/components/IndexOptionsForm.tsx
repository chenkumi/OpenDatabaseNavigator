import type { IndexOptions, IndexCapabilities } from '../../../shared/index-options';
import { Fieldset } from './ui/fieldset';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { SelectField } from './SelectField';
import { useI18n } from '../i18n';
export function IndexOptionsForm({
  value,
  capabilities,
  disabled,
  onChange,
}: {
  value: IndexOptions;
  capabilities: IndexCapabilities;
  disabled?: boolean;
  onChange: (value: IndexOptions) => void;
}) {
  const t = useI18n();
  const type = value.type ?? 'NORMAL';
  const special = ['FULLTEXT', 'SPATIAL'].includes(type);
  const methods = capabilities.methods.filter((m) => type !== 'UNIQUE' || m.unique);
  return (
    <Fieldset className="column-properties" disabled={disabled}>
      <legend>{t('Index options')}</legend>
      <div className="column-property-grid">
        <Label>
          {t('Index type')}
          <SelectField
            aria-label={t('Index type')}
            value={type}
            onValueChange={(v) => {
              const nextType = v as IndexOptions['type'];
              const available = capabilities.methods.filter((m) => v !== 'UNIQUE' || m.unique);
              const method = ['FULLTEXT', 'SPATIAL'].includes(v)
                ? ''
                : available.some((m) => m.name === value.method)
                  ? value.method
                  : '';
              onChange({ ...value, type: nextType, method });
            }}
          >
            {capabilities.types.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </SelectField>
        </Label>
        {!special && (
          <Label>
            {t('Index method')}
            <SelectField
              aria-label={t('Index method')}
              value={value.method ?? ''}
              onValueChange={(method) => onChange({ ...value, method })}
            >
              <option value="">{t('Database default')}</option>
              {methods.map((m) => (
                <option key={m.name}>{m.name}</option>
              ))}
            </SelectField>
          </Label>
        )}
      </div>
      {capabilities.comment && (
        <Label className="mt-3 flex-col items-stretch">
          {t('Index comment')}
          <Textarea
            aria-label={t('Index comment')}
            rows={3}
            value={value.comment ?? ''}
            onChange={(e) => onChange({ ...value, comment: e.target.value })}
          />
        </Label>
      )}
    </Fieldset>
  );
}
