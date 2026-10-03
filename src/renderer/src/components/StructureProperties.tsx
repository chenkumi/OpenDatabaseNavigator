import { useEffect, useState } from 'react';
import type { StructureChange, TableStructure } from '../../../shared/types';
import type {
  ColumnProperties,
  TableProperties,
  StructurePropertyOptions,
} from '../../../shared/structure-properties';
import { command } from '../api';
import { useI18n } from '../i18n';
import { SelectField } from './SelectField';
import { Alert } from './ui/alert';
import { Fieldset } from './ui/fieldset';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Textarea } from './ui/textarea';

export function StructureProperties({
  detail,
  columnName,
  change,
  disabled,
  connectionId,
  database,
  onChange,
}: {
  detail: TableStructure;
  columnName?: string;
  change?: StructureChange;
  disabled: boolean;
  connectionId: string;
  database?: string;
  onChange: (change?: StructureChange) => void;
}) {
  const t = useI18n();
  const [options, setOptions] = useState<StructurePropertyOptions>();
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    let active = true;
    setOptions(undefined);
    setError('');
    void command<StructurePropertyOptions>('structure.options', { connectionId, database })
      .then((value) => {
        if (active) setOptions(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [connectionId, database, detail.version]);
  const column =
    columnName === undefined ? undefined : detail.columns.find((c) => c.name === columnName);
  const original: ColumnProperties & TableProperties =
    column?.properties ?? detail.properties ?? {};
  const drafting = column
    ? change?.action === 'column-properties' && change.column === column.name
    : change?.action === 'table-properties';
  const patch: ColumnProperties & TableProperties =
    drafting && change && 'properties' in change ? change.properties : {};
  const value = { ...original, ...patch };
  const locked = disabled || !!(change && !drafting);
  const capability = column ? options?.column : options?.table;
  const character = !column || !!column.properties?.collation;
  const update = (key: keyof (ColumnProperties & TableProperties), next: string | boolean) => {
    const result: ColumnProperties & TableProperties = { ...patch, [key]: next };
    if (key === 'charset') {
      delete result.collation;
      delete result.binary;
    }
    if (key === 'collation') delete result.binary;
    if (key === 'binary') delete result.collation;
    for (const field of Object.keys(result) as (keyof typeof result)[])
      if (
        result[field] === original[field] &&
        !(
          ['collation', 'binary'].includes(field) &&
          result.charset &&
          result.charset !== original.charset
        )
      )
        delete result[field];
    onChange(
      Object.keys(result).length
        ? column
          ? { action: 'column-properties', column: column.name, properties: result }
          : { action: 'table-properties', properties: result }
        : undefined,
    );
  };
  const effectiveCollation =
    patch.binary !== undefined
      ? patch.binary
        ? `${value.charset}_bin`
        : (options?.defaultCollations[value.charset ?? ''] ?? '')
      : (patch.collation ??
        (patch.charset
          ? (options?.defaultCollations[value.charset ?? ''] ?? '')
          : (value.collation ?? '')));
  const allCollations = (options?.collations ?? []).filter(
    (item) => !item.charset || item.charset === value.charset,
  );
  const filtered = allCollations.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()),
  );
  const visible = filtered.slice(0, 200);
  if (effectiveCollation && !visible.some((item) => item.name === effectiveCollation))
    visible.unshift({ name: effectiveCollation });
  return (
    <div className="structure-properties">
      {error && <Alert role="alert">{error}</Alert>}
      {!options && !error && <p>{t('Loading…')}</p>}
      {options && capability && !Object.values(capability).some(Boolean) && (
        <p>{t('This engine has no editable properties in this section.')}</p>
      )}
      {options && capability && (
        <Fieldset disabled={locked}>
          <legend>
            {t(column ? 'Column options' : 'Table options')}
            {column ? ` · ${column.name}` : ''}
          </legend>
          <div className="column-property-grid">
            {'storageEngine' in capability && capability.storageEngine && (
              <Label>
                {t('Storage engine')}
                <SelectField
                  aria-label={t('Storage engine')}
                  value={value.storageEngine ?? ''}
                  onValueChange={(v) => update('storageEngine', v)}
                >
                  {options.storageEngines.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </SelectField>
              </Label>
            )}
            {capability.charset && character && (
              <Label>
                {t('Character set')}
                <SelectField
                  aria-label={t('Character set')}
                  value={value.charset ?? ''}
                  onValueChange={(v) => update('charset', v)}
                >
                  {options.charsets.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </SelectField>
              </Label>
            )}
            {capability.collation && character && (
              <Label>
                {t('Collation')}
                <Input
                  aria-label={t('Search collations')}
                  placeholder={t('Search collations')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <SelectField
                  aria-label={t('Collation')}
                  value={effectiveCollation}
                  onValueChange={(v) => update('collation', v)}
                >
                  {visible.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name}
                    </option>
                  ))}
                </SelectField>
                {filtered.length > 200 && (
                  <small>{t('Showing first 200 matches. Refine your search.')}</small>
                )}
              </Label>
            )}
            {'binary' in capability && capability.binary && character && (
              <Label className="inline">
                <Checkbox
                  aria-label={t('Binary comparison')}
                  checked={patch.binary ?? /_bin$/i.test(effectiveCollation)}
                  onCheckedChange={(v) => update('binary', v)}
                />
                {t('Binary comparison')}
              </Label>
            )}
            {capability.comment && (
              <Label className="property-default">
                {t('Comment')}
                <Textarea
                  aria-label={t('Comment')}
                  value={value.comment ?? ''}
                  onChange={(e) => update('comment', e.target.value)}
                />
              </Label>
            )}
          </div>
        </Fieldset>
      )}
      {!column && options?.table.charset && (
        <p>
          {t(
            'Table character defaults apply to newly added columns. Change each existing column explicitly to convert its data.',
          )}
        </p>
      )}
      {change && !drafting && (
        <p>{t('Apply or discard the pending change before editing these properties.')}</p>
      )}
    </div>
  );
}
