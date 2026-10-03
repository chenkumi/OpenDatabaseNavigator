import type { ViewCapabilities, ViewOptions } from '../../../shared/view-options';
import { Fieldset } from './ui/fieldset';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { SelectField } from './SelectField';
import { useI18n } from '../i18n';

export function ViewOptionsForm({
  value,
  capabilities,
  disabled,
  onChange,
}: {
  value: ViewOptions;
  capabilities: ViewCapabilities;
  disabled?: boolean;
  onChange: (value: ViewOptions) => void;
}) {
  const t = useI18n();
  if (!capabilities.checkOptions.length && !capabilities.algorithms.length) return null;
  return (
    <Fieldset disabled={disabled} className="column-properties">
      <legend>{t('View options')}</legend>
      <div className="column-property-grid">
        {!!capabilities.algorithms.length && (
          <Label>
            {t('View algorithm')}
            <SelectField
              aria-label={t('View algorithm')}
              value={value.algorithm ?? 'UNDEFINED'}
              onValueChange={(algorithm) =>
                onChange({ ...value, algorithm: algorithm as ViewOptions['algorithm'] })
              }
            >
              {capabilities.algorithms.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </SelectField>
          </Label>
        )}
        {!!capabilities.securityModes.length && (
          <Label>
            {t('View security')}
            <SelectField
              aria-label={t('View security')}
              value={value.security ?? 'DEFINER'}
              onValueChange={(security) =>
                onChange({ ...value, security: security as ViewOptions['security'] })
              }
            >
              {capabilities.securityModes.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </SelectField>
          </Label>
        )}
        {!!capabilities.checkOptions.length && (
          <Label>
            {t('Check option')}
            <SelectField
              aria-label={t('Check option')}
              value={value.checkOption ?? 'NONE'}
              onValueChange={(checkOption) =>
                onChange({ ...value, checkOption: checkOption as ViewOptions['checkOption'] })
              }
            >
              {capabilities.checkOptions.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </SelectField>
          </Label>
        )}
      </div>
      {capabilities.definer && (
        <div className="column-property-grid">
          <Label className="inline property-wide">
            <Checkbox
              aria-label={t('Use current account as definer')}
              checked={value.definer == null}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  definer: checked
                    ? null
                    : (capabilities.currentDefiner ?? { user: '', host: '%' }),
                })
              }
            />
            {t('Use current account as definer')}
          </Label>
          {value.definer != null && (
            <>
              <Label>
                {t('Definer user')}
                <Input
                  aria-label={t('Definer user')}
                  value={value.definer.user}
                  onChange={(e) =>
                    onChange({ ...value, definer: { ...value.definer!, user: e.target.value } })
                  }
                />
              </Label>
              <Label>
                {t('Definer host')}
                <Input
                  aria-label={t('Definer host')}
                  value={value.definer.host}
                  onChange={(e) =>
                    onChange({ ...value, definer: { ...value.definer!, host: e.target.value } })
                  }
                />
              </Label>
            </>
          )}
        </div>
      )}
      <small>
        {t('CHECK OPTION rejects writes through the view that do not match its condition.')}
      </small>
    </Fieldset>
  );
}
