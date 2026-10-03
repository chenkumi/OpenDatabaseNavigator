import { SelectField } from './SelectField';
import { Input } from './ui/input';
import { Button } from './ui/button';
import type { Column } from '../../../shared/types';
import { useI18n } from '../i18n';

export function CellEditor({
  value,
  column,
  label,
  onChange,
}: {
  value: unknown;
  column?: Column;
  label: string;
  onChange: (value: string | number | boolean | null) => void;
}) {
  const t = useI18n();
  const boolean = typeof value === 'boolean' || /^(boolean|bool)$/i.test(column?.type ?? '');
  // Drivers deliberately return BIGINT/DECIMAL as strings to preserve precision.
  const number = typeof value === 'number';
  return (
    <div className="cell-editor">
      {boolean ? (
        <SelectField
          className="cell-input"
          aria-label={label}
          value={
            value == null
              ? ''
              : String(value === true || value === 1 || value === '1' || value === 'true')
          }
          onValueChange={(event) => onChange(event === '' ? null : event === 'true')}
        >
          {value == null && <option value="">NULL</option>}
          <option value="true">true</option>
          <option value="false">false</option>
        </SelectField>
      ) : (
        <Input
          aria-label={label}
          className="cell-input"
          key={`${typeof value}:${String(value)}`}
          type={number ? 'number' : 'text'}
          step={number ? 'any' : undefined}
          defaultValue={value == null ? '' : String(value)}
          placeholder={value === null ? 'NULL' : ''}
          onBlur={(event) => {
            const text = event.target.value;
            if (text === (value == null ? '' : String(value))) return;
            if (number && (!text.trim() || !Number.isFinite(Number(text)))) {
              event.target.value = String(value);
              return;
            }
            onChange(number ? Number(text) : text);
          }}
        />
      )}
      {column?.nullable && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="cell-null"
          aria-label={t('Set {label} to {value}', {
            label,
            value: value === null ? (boolean ? 'false' : 'empty string') : 'NULL',
          })}
          title={t(value === null ? (boolean ? 'Set false' : 'Set empty string') : 'Set NULL')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChange(value === null ? (boolean ? false : '') : null)}
        >
          ∅
        </Button>
      )}
    </div>
  );
}
