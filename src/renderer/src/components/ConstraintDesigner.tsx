import { useEffect, useState } from 'react';
import type { ConstraintDefinition } from '../../../shared/constraints';
import type { Column, StructureChange, TableInfo, TableStructure } from '../../../shared/types';
import { command } from '../api';
import { useI18n } from '../i18n';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Fieldset } from './ui/fieldset';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { SelectField } from './SelectField';

export function ConstraintDesigner({
  detail,
  kind,
  change,
  disabled,
  connectionId,
  database,
  onChange,
}: {
  detail: TableStructure;
  kind: ConstraintDefinition['kind'];
  change?: StructureChange;
  disabled: boolean;
  connectionId: string;
  database?: string;
  onChange: (change?: StructureChange) => void;
}) {
  const t = useI18n();
  const items = (detail.constraints ?? []).filter((item) => item.definition.kind === kind);
  const [selected, setSelected] = useState(change && 'id' in change ? change.id : items[0]?.id);
  const current = items.find((item) => item.id === selected);
  const drafting = change?.action === 'constraint-upsert' && change.constraint.kind === kind;
  const value = drafting ? change.constraint : current?.definition;
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [error, setError] = useState('');
  const foreignKey = value?.kind === 'foreign-key' ? value : undefined;
  useEffect(() => {
    if (change) return;
    if (!items.some((item) => item.id === selected)) setSelected(items[0]?.id);
  }, [detail.version, change]);
  useEffect(() => {
    if (kind !== 'foreign-key') return;
    let active = true;
    void command<string[]>(
      detail.engine === 'mysql' ? 'database.list' : 'schema.list',
      detail.engine === 'mysql' ? { connectionId } : { connectionId, database },
    )
      .then((data) => {
        if (active) setSchemas(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [connectionId, database, kind]);
  useEffect(() => {
    let active = true;
    setTables([]);
    setError('');
    if (foreignKey?.referencedSchema)
      void command<TableInfo[]>('table.list', {
        connectionId,
        database,
        schema: foreignKey.referencedSchema,
      })
        .then((data) => {
          if (active) setTables(data.filter((item) => item.kind === 'table'));
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [connectionId, database, foreignKey?.referencedSchema]);
  useEffect(() => {
    let active = true;
    setColumns([]);
    if (foreignKey?.referencedTable)
      void command<Column[]>('table.describe', {
        connectionId,
        database,
        schema: foreignKey.referencedSchema,
        table: foreignKey.referencedTable,
      })
        .then((data) => {
          if (active) setColumns(data);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [connectionId, database, foreignKey?.referencedSchema, foreignKey?.referencedTable]);
  const locked = disabled || (!!change && !drafting) || (!drafting && !!current?.readOnlyReason);
  const edit = (constraint: ConstraintDefinition) =>
    onChange({
      action: 'constraint-upsert',
      ...(drafting ? (change.id ? { id: change.id } : {}) : current ? { id: current.id } : {}),
      constraint,
    });
  const capability = detail.constraintCapabilities?.[kind === 'check' ? 'check' : 'foreignKey'];
  const options = (values: string[], selected = '') =>
    [...new Set([...(selected ? [selected] : []), ...values])].map((name) => (
      <option key={name} value={name}>
        {name}
      </option>
    ));
  return (
    <div className="constraint-designer">
      <div className="toolbar">
        <Label>
          {t(kind === 'foreign-key' ? 'Foreign keys' : 'Checks')}
          <SelectField
            aria-label={t('Existing constraints')}
            disabled={disabled || !!change}
            value={selected ?? ''}
            onValueChange={setSelected}
          >
            <option value="">{t('None')}</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.definition.name || t('Unnamed constraint')}
              </option>
            ))}
          </SelectField>
        </Label>
        <Button
          variant="ghost"
          disabled={disabled || !!change || !capability}
          onClick={() => {
            setSelected(undefined);
            onChange({
              action: 'constraint-upsert',
              constraint:
                kind === 'foreign-key'
                  ? {
                      kind,
                      name: '',
                      columns: [detail.columns[0]?.name ?? ''],
                      referencedSchema: detail.schema,
                      referencedTable: '',
                      referencedColumns: [''],
                      onDelete: 'NO ACTION',
                      onUpdate: 'NO ACTION',
                    }
                  : { kind, name: '', expression: '', notEnforced: false },
            });
          }}
        >
          {t('Add constraint')}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || !!change || !current}
          onClick={() => onChange({ action: 'constraint-drop', id: current!.id })}
        >
          {t('Drop constraint')}
        </Button>
      </div>
      {!capability && <Alert>{t('This server does not support this constraint operation.')}</Alert>}
      {error && <Alert role="alert">{error}</Alert>}
      {current?.readOnlyReason && !drafting && <Alert>{t(current.readOnlyReason)}</Alert>}
      {value && (
        <Fieldset disabled={locked} className="constraint-fields">
          <legend>
            {t(kind === 'foreign-key' ? 'Foreign key definition' : 'Check definition')}
          </legend>
          <Label>
            {t('Constraint name')}
            <Input
              aria-label={t('Constraint name')}
              value={value.name}
              onChange={(event) => edit({ ...value, name: event.target.value })}
            />
          </Label>
          {value.kind === 'check' ? (
            <>
              <Label>
                {t('Check expression')}
                <Textarea
                  aria-label={t('Check expression')}
                  rows={5}
                  value={value.expression}
                  onChange={(event) => edit({ ...value, expression: event.target.value })}
                />
              </Label>
              <Label className="inline">
                <Checkbox
                  aria-label={t('Not enforced')}
                  checked={value.notEnforced}
                  disabled={locked || !detail.constraintCapabilities?.notEnforced}
                  onCheckedChange={(checked) => edit({ ...value, notEnforced: checked })}
                />
                {t('Not enforced')}
              </Label>
            </>
          ) : (
            <>
              <div className="form-grid">
                <Label>
                  {t('Referenced schema')}
                  <SelectField
                    aria-label={t('Referenced schema')}
                    disabled={locked}
                    value={value.referencedSchema}
                    onValueChange={(schema) =>
                      edit({
                        ...value,
                        referencedSchema: schema,
                        referencedTable: '',
                        referencedColumns: value.columns.map(() => ''),
                      })
                    }
                  >
                    {options(schemas, value.referencedSchema)}
                  </SelectField>
                </Label>
                <Label>
                  {t('Referenced table')}
                  <SelectField
                    aria-label={t('Referenced table')}
                    disabled={locked}
                    value={value.referencedTable}
                    onValueChange={(table) =>
                      edit({
                        ...value,
                        referencedTable: table,
                        referencedColumns: value.columns.map(() => ''),
                      })
                    }
                  >
                    <option value="">{t('Select a table')}</option>
                    {options(
                      tables.map((table) => table.name),
                      value.referencedTable,
                    )}
                  </SelectField>
                </Label>
              </div>
              <p>{t('Column pairs are matched in the displayed order.')}</p>
              {value.columns.map((name, index) => (
                <div className="constraint-column-pair" key={index}>
                  <SelectField
                    aria-label={t('Local column {number}', { number: index + 1 })}
                    disabled={locked}
                    value={name}
                    onValueChange={(name) =>
                      edit({
                        ...value,
                        columns: value.columns.map((old, i) => (i === index ? name : old)),
                      })
                    }
                  >
                    <option value="">{t('Select a column')}</option>
                    {options(
                      detail.columns.map((column) => column.name),
                      name,
                    )}
                  </SelectField>
                  <span>→</span>
                  <SelectField
                    aria-label={t('Referenced column {number}', { number: index + 1 })}
                    disabled={locked || !value.referencedTable}
                    value={value.referencedColumns[index] ?? ''}
                    onValueChange={(name) =>
                      edit({
                        ...value,
                        referencedColumns: value.columns.map((_, i) =>
                          i === index ? name : (value.referencedColumns[i] ?? ''),
                        ),
                      })
                    }
                  >
                    <option value="">{t('Select a column')}</option>
                    {options(
                      columns.map((column) => column.name),
                      value.referencedColumns[index],
                    )}
                  </SelectField>
                  <Button
                    variant="ghost"
                    disabled={locked || value.columns.length === 1}
                    aria-label={t('Remove column pair {number}', { number: index + 1 })}
                    onClick={() =>
                      edit({
                        ...value,
                        columns: value.columns.filter((_, i) => i !== index),
                        referencedColumns: value.referencedColumns.filter((_, i) => i !== index),
                      })
                    }
                  >
                    −
                  </Button>
                </div>
              ))}
              <Button
                variant="ghost"
                disabled={locked || value.columns.length >= 64}
                onClick={() =>
                  edit({
                    ...value,
                    columns: [...value.columns, ''],
                    referencedColumns: [...value.referencedColumns, ''],
                  })
                }
              >
                {t('Add column pair')}
              </Button>
              <div className="form-grid">
                {(['onDelete', 'onUpdate'] as const).map((key) => (
                  <Label key={key}>
                    {t(key === 'onDelete' ? 'On delete' : 'On update')}
                    <SelectField
                      aria-label={t(key === 'onDelete' ? 'On delete' : 'On update')}
                      disabled={locked}
                      value={value[key]}
                      onValueChange={(action) => edit({ ...value, [key]: action })}
                    >
                      {options(detail.constraintCapabilities?.actions ?? [], value[key])}
                    </SelectField>
                  </Label>
                ))}
              </div>
            </>
          )}
        </Fieldset>
      )}
      {!value && <p className="muted">{t('Select a constraint or add a new one.')}</p>}
    </div>
  );
}
