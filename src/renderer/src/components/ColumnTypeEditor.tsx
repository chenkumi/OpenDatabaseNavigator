import { TypeCombobox } from './TypeCombobox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { TableCell } from './ui/table';
import { Fragment, useId } from 'react';
import type { Engine } from '../../../shared/types';
import { formatType, TYPE_SUGGESTIONS, typeOptions, typeParts } from '../column-types';
import { useI18n } from '../i18n';

export function ColumnTypeEditor({
  engine,
  value,
  disabled,
  onChange,
  column,
  strict = false,
}: {
  engine: Engine;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  column?: string;
  strict?: boolean;
}) {
  const t = useI18n(),
    id = useId();
  const parts = typeParts(value),
    options = typeOptions(engine, parts.base);
  const label = (name: string) => (column ? `${t(name)} · ${column}` : t(name));
  const suggestions =
    strict && engine === 'sqlite'
      ? ['INT', 'INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY']
      : TYPE_SUGGESTIONS[engine];
  const fields = [
    <TypeCombobox
      id={`${id}-0`}
      key="type"
      label={label('Data type')}
      items={suggestions}
      value={parts.base}
      disabled={disabled}
      onChange={(base) => {
        // Pasted complete definitions and custom types are accepted without rewriting.
        if (/[()]/.test(base)) return onChange(base);
        const next = typeOptions(engine, base);
        onChange(
          formatType(
            base,
            next.length && (!/^max$/i.test(parts.length) || next.max) ? parts.length : '',
            next.scale ? parts.scale : '',
            parts.suffix,
          ),
        );
      }}
    />,
    <div key="length" className="type-length">
      <Input
        id={`${id}-1`}
        type="number"
        step="1"
        min={options.min}
        aria-label={label('Length / precision')}
        disabled={disabled || !options.length || /^max$/i.test(parts.length)}
        value={/^max$/i.test(parts.length) ? '' : parts.length}
        placeholder={options.length ? '—' : t('Not applicable')}
        onChange={(event) =>
          onChange(
            formatType(
              parts.base,
              event.target.value,
              event.target.value ? parts.scale : '',
              parts.suffix,
            ),
          )
        }
      />
      {options.max && (
        <Label className="inline">
          <Checkbox
            aria-label={label('Use MAX')}
            checked={/^max$/i.test(parts.length)}
            disabled={disabled}
            onCheckedChange={(event) =>
              onChange(formatType(parts.base, event ? 'MAX' : '', '', parts.suffix))
            }
          />
          MAX
        </Label>
      )}
    </div>,
    <Input
      id={`${id}-2`}
      key="scale"
      type="number"
      step="1"
      min={options.scaleMin}
      aria-label={label('Decimal places')}
      disabled={disabled || !options.scale || !parts.length}
      value={parts.scale}
      placeholder={options.scale ? '—' : t('Not applicable')}
      onChange={(event) =>
        onChange(formatType(parts.base, parts.length, event.target.value, parts.suffix))
      }
    />,
  ];

  if (column)
    return (
      <>
        {fields.map((field, index) => (
          <TableCell key={index} className={index === 0 ? 'type-cell' : 'type-number-cell'}>
            {field}
          </TableCell>
        ))}
      </>
    );
  return (
    <div className="type-properties">
      {fields.map((field, index) => (
        <Fragment key={index}>
          <div>
            <Label htmlFor={`${id}-${index}`}>
              {t(['Data type', 'Length / precision', 'Decimal places'][index])}
            </Label>
            <div>{field}</div>
          </div>
        </Fragment>
      ))}
      <small className="type-definition">{value}</small>
      {options.deprecated && (
        <small>
          {t(
            'MySQL display width and FLOAT(M,D) are legacy syntax; they do not change integer range.',
          )}
        </small>
      )}
      {engine === 'sqlite' && (
        <small>{t('SQLite length and precision are declarations, not enforced limits.')}</small>
      )}
    </div>
  );
}
