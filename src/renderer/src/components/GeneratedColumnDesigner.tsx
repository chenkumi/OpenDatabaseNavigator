import { useEffect, useState } from 'react';
import type { Generation, GenerationCapabilities } from '../../../shared/generated-columns';
import type { StructureChange, TableStructure } from '../../../shared/types';
import { useI18n } from '../i18n';
import { SelectField } from './SelectField';
import { ColumnTypeEditor } from './ColumnTypeEditor';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Fieldset } from './ui/fieldset';
import { Textarea } from './ui/textarea';

export function GenerationFields({
  value,
  capabilities,
  onChange,
  storageDisabled = false,
  expressionDisabled = false,
  suffix = '',
}: {
  value: Generation;
  capabilities: GenerationCapabilities;
  onChange: (value: Generation) => void;
  storageDisabled?: boolean;
  expressionDisabled?: boolean;
  suffix?: string;
}) {
  const t = useI18n();
  return (
    <>
      <Label>
        {t('Generation storage')}
        <SelectField
          aria-label={t('Generation storage') + suffix}
          value={value.storage}
          disabled={storageDisabled}
          onValueChange={(storage) =>
            onChange({ ...value, storage: storage as Generation['storage'] })
          }
        >
          {capabilities.modes.map((mode) => (
            <option key={mode} value={mode}>
              {t(mode === 'virtual' ? 'Virtual (computed on read)' : 'Stored (persisted)')}
            </option>
          ))}
        </SelectField>
      </Label>
      <Label className="property-default">
        {t('Generation expression')}
        <Textarea
          aria-label={t('Generation expression') + suffix}
          rows={4}
          value={value.expression}
          disabled={expressionDisabled}
          onChange={(e) => onChange({ ...value, expression: e.target.value })}
        />
        <small>
          {t(
            'Enter a scalar SQL expression, for example quantity * price. Values are maintained by the database.',
          )}
        </small>
      </Label>
    </>
  );
}

export function GeneratedColumnDesigner({
  detail,
  change,
  disabled,
  onChange,
}: {
  detail: TableStructure;
  change?: StructureChange;
  disabled: boolean;
  onChange: (value?: StructureChange) => void;
}) {
  const t = useI18n();
  const columns = detail.columns.filter((c) => c.generation);
  const [selected, setSelected] = useState(
    change?.action === 'generated-edit' ? change.column : (columns[0]?.name ?? ''),
  );
  useEffect(() => {
    if (!change && !columns.some((c) => c.name === selected)) setSelected(columns[0]?.name ?? '');
  }, [detail.version, change]);
  const column = columns.find((c) => c.name === selected);
  const adding = change?.action === 'generated-add';
  const drafting = adding || change?.action === 'generated-edit';
  const value = drafting ? change.generation : column?.generation;
  const caps = detail.generationCapabilities;
  const locked = disabled || !!(change && !drafting);
  if (!caps?.modes.length)
    return <p>{t('Generated column editing is not available for this engine.')}</p>;
  const update = (generation: Generation) => {
    if (adding) onChange({ ...change, generation });
    else if (column)
      onChange(
        JSON.stringify(generation) === JSON.stringify(column.generation)
          ? undefined
          : { action: 'generated-edit', column: column.name, generation },
      );
  };
  return (
    <div className="structure-properties">
      <div className="toolbar">
        <Button
          variant="outline"
          disabled={disabled || !!change}
          onClick={() =>
            onChange({
              action: 'generated-add',
              name: '',
              type: 'int',
              generation: { expression: '', storage: caps.modes[0] },
            })
          }
        >
          {t('Add generated column')}
        </Button>
        <Button
          variant="outline"
          disabled={disabled || !!change || !column}
          onClick={() => onChange({ action: 'drop', column: column!.name })}
        >
          {t('Drop column')}
        </Button>
      </div>
      {!adding && (
        <Label>
          {t('Generated column')}
          <SelectField
            aria-label={t('Generated column')}
            value={selected}
            disabled={disabled || !!change}
            onValueChange={setSelected}
          >
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </SelectField>
        </Label>
      )}
      {value && (
        <Fieldset disabled={locked}>
          <legend>{t(adding ? 'New generated column' : 'Generated column')}</legend>
          <div className="column-property-grid">
            {adding && (
              <Label>
                {t('Column name')}
                <Input
                  aria-label={t('Generated column name')}
                  value={change.name}
                  onChange={(e) => onChange({ ...change, name: e.target.value })}
                />
              </Label>
            )}
            {adding && !caps.inferredType && (
              <ColumnTypeEditor
                engine={detail.engine}
                value={change.type}
                strict={/\bSTRICT\s*;?$/i.test(detail.definition)}
                disabled={disabled}
                onChange={(type) => onChange({ ...change, type })}
              />
            )}
            {caps.inferredType && (
              <p>{t('The database infers the result type from the expression.')}</p>
            )}
            <GenerationFields
              value={value}
              capabilities={caps}
              onChange={update}
              storageDisabled={!adding && !caps.changeStorage}
              expressionDisabled={
                !adding &&
                (!caps.editExpression ||
                  (detail.engine === 'postgres' && column?.generation?.storage === 'virtual'))
              }
            />
          </div>
        </Fieldset>
      )}
      {!adding && !caps.changeStorage && (
        <p>{t('This engine cannot switch existing generated column storage modes.')}</p>
      )}
      {!adding && !caps.editExpression && (
        <p>{t('This server version cannot alter generation expressions.')}</p>
      )}
      {!adding && detail.engine === 'postgres' && column?.generation?.storage === 'virtual' && (
        <p>{t('PostgreSQL cannot alter an existing virtual generation expression.')}</p>
      )}
    </div>
  );
}
