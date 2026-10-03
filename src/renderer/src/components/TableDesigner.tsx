import { Alert } from './ui/alert';
import { Fieldset } from './ui/fieldset';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Button } from './ui/button';
import { Table } from './ui/table';
import { TableHeader } from './ui/table';
import { TableRow } from './ui/table';
import { TableHead } from './ui/table';
import { TableBody } from './ui/table';
import { TableCell } from './ui/table';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { useEffect, useRef, useState } from 'react';
import type {
  ColumnPropertyChange,
  StructureChange,
  StructureColumn,
  TableStructure,
} from '../../../shared/types';
import { useI18n } from '../i18n';
import { ColumnTypeEditor } from './ColumnTypeEditor';
import { ConstraintDesigner } from './ConstraintDesigner';
import { StructureProperties } from './StructureProperties';
import { SelectField } from './SelectField';
import { GeneratedColumnDesigner } from './GeneratedColumnDesigner';

export function TableDesigner({
  detail,
  change,
  disabled,
  onChange,
  connectionId,
  database,
}: {
  detail: TableStructure;
  change?: StructureChange;
  disabled: boolean;
  onChange: (change?: StructureChange) => void;
  connectionId: string;
  database?: string;
}) {
  const t = useI18n();
  const [section, setSection] = useState<
    'fields' | 'keys' | 'foreign-key' | 'check' | 'column-options' | 'options' | 'generated'
  >(
    change?.action === 'generated-add' || change?.action === 'generated-edit'
      ? 'generated'
      : change?.action === 'table-properties'
        ? 'options'
        : change?.action === 'column-properties'
          ? 'column-options'
          : change?.action === 'constraint-upsert'
            ? change.constraint.kind
            : change?.action === 'constraint-drop'
              ? (detail.constraints?.find((item) => item.id === change.id)?.definition.kind ??
                'check')
              : change?.action === 'primary-key'
                ? 'keys'
                : 'fields',
  );
  const [selected, setSelected] = useState(
    change?.action === 'edit-columns'
      ? change.changes[0]?.column
      : change && 'column' in change
        ? change.column
        : detail.columns[0]?.name,
  );
  const previousChange = useRef(change);
  useEffect(() => {
    const previous = previousChange.current;
    if (!change && previous?.action === 'edit-columns') {
      const rename = previous.changes.find(
        (item) => item.action === 'rename' && item.column === selected,
      );
      if (rename?.action === 'rename' && detail.columns.some((item) => item.name === rename.name))
        setSelected(rename.name);
    }
    if (
      !change &&
      previous &&
      (previous.action === 'add' || previous.action === 'rename') &&
      detail.columns.some((item) => item.name === previous.name)
    )
      setSelected(previous.name);
    previousChange.current = change;
  }, [change, detail, selected]);
  const column = detail.columns.find((item) => item.name === selected) ?? detail.columns[0];
  const adding = change?.action === 'add';
  const properties: ColumnPropertyChange[] =
    change?.action === 'edit-columns'
      ? change.changes
      : change && ['rename', 'type', 'nullable', 'default'].includes(change.action)
        ? [change as ColumnPropertyChange]
        : [];
  const originalKeys = detail.columns.filter((item) => item.primaryKey).map((item) => item.name);
  const keyDraft =
    change?.action === 'edit-columns'
      ? change.primaryKey
      : change?.action === 'primary-key'
        ? change.columns
        : undefined;
  const keys = change?.action === 'primary-key' ? change.columns : (keyDraft ?? originalKeys);
  const editable =
    !change ||
    properties.length > 0 ||
    change.action === 'edit-columns' ||
    change.action === 'primary-key';
  const draftColumn = (source: StructureColumn): StructureColumn => {
    const value = properties
      .filter((item) => item.column === source.name)
      .reduce((value, item) => {
        switch (item.action) {
          case 'rename':
            return { ...value, name: item.name };
          case 'type':
            return { ...value, type: item.type };
          case 'nullable':
            return { ...value, nullable: item.nullable };
          case 'default':
            return { ...value, defaultSql: item.defaultSql };
        }
      }, source);
    return keyDraft?.includes(source.name) ? { ...value, nullable: false } : value;
  };
  const shown = adding ? change : column ? draftColumn(column) : undefined;
  const locked = () => disabled || (!adding && (!column || !editable));
  const saveProperties = (changes: ColumnPropertyChange[], primaryKey = keyDraft) =>
    onChange(
      changes.length || primaryKey !== undefined
        ? { action: 'edit-columns', changes, ...(primaryKey !== undefined ? { primaryKey } : {}) }
        : undefined,
    );
  const update = (next: StructureChange, unchanged: boolean) => {
    if (['rename', 'type', 'nullable', 'default'].includes(next.action)) {
      const property = next as ColumnPropertyChange;
      const remaining = properties.filter(
        (item) => item.column !== property.column || item.action !== property.action,
      );
      if (!unchanged) remaining.push(property);
      saveProperties(remaining);
    } else onChange(unchanged ? undefined : next);
  };
  const toggleKey = (name: string, checked: boolean) => {
    const next = checked
      ? [...keys.filter((key) => key !== name), name]
      : keys.filter((key) => key !== name);
    const primaryKey = JSON.stringify(next) === JSON.stringify(originalKeys) ? undefined : next;
    // Explicit NULL edits cannot conflict with a newly selected key.
    const remaining = checked
      ? properties.filter(
          (item) => !(item.column === name && item.action === 'nullable' && item.nullable),
        )
      : properties;
    onChange(
      remaining.length || primaryKey !== undefined
        ? {
            action: 'edit-columns',
            changes: remaining,
            ...(primaryKey !== undefined ? { primaryKey } : {}),
          }
        : undefined,
    );
  };
  const selectColumn = (name: string) => {
    setSelected(name);
    setSection('fields');
  };
  return (
    <Tabs
      value={section}
      onValueChange={(value) => setSection(value as typeof section)}
      className="table-designer"
    >
      <TabsList className="designer-tabs" aria-label={t('Table design sections')}>
        <TabsTrigger value="fields">{t('Fields')}</TabsTrigger>
        <TabsTrigger value="keys">{t('Primary key')}</TabsTrigger>
        <TabsTrigger value="foreign-key">{t('Foreign keys')}</TabsTrigger>
        <TabsTrigger value="check">{t('Checks')}</TabsTrigger>
        <TabsTrigger value="generated">{t('Generated columns')}</TabsTrigger>
        <TabsTrigger value="column-options">{t('Column options')}</TabsTrigger>
        <TabsTrigger value="options">{t('Table options')}</TabsTrigger>
      </TabsList>
      {(section === 'fields' || section === 'keys') && (
        <div className="toolbar designer-actions">
          <Button
            variant="outline"
            disabled={disabled || !!change}
            onClick={() => {
              setSection('fields');
              onChange({
                action: 'add',
                name: '',
                type:
                  detail.engine === 'sybase'
                    ? 'varchar(255)'
                    : detail.engine === 'sqlserver'
                      ? 'nvarchar(255)'
                      : 'TEXT',
                nullable: true,
                defaultSql: '',
              });
            }}
          >
            {t('Add column')}
          </Button>
          <Button
            variant="outline"
            disabled={disabled || !!change || !column}
            onClick={() => {
              setSection('fields');
              onChange({ action: 'drop', column: column!.name });
            }}
          >
            {t('Drop column')}
          </Button>
          <span className="spacer" />
          <small>{t('{count} columns', { count: detail.columns.length })}</small>
        </div>
      )}
      {section === 'fields' ? (
        <TabsContent value="fields" className="designer-fields" aria-label={t('Fields')}>
          <div className="designer-grid-scroll">
            <Table
              containerClassName="contents"
              className="designer-grid"
              aria-label={t('Table columns')}
            >
              <TableHeader>
                <TableRow>
                  {[
                    'Column',
                    'Type',
                    'Length / precision',
                    'Decimal places',
                    'Allow NULL',
                    'Primary key',
                    'Default',
                  ].map((label) => (
                    <TableHead key={label}>{t(label)}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.columns.map((source) => {
                  const value = draftColumn(source);
                  const changed =
                    keys.includes(source.name) !== source.primaryKey ||
                    properties.some((item) => item.column === source.name) ||
                    (change && 'column' in change && change.column === source.name);
                  return (
                    <TableRow
                      key={source.name}
                      className={`${!adding && source.name === column?.name ? 'column-selected' : ''} ${changed ? 'column-pending' : ''} ${changed && change?.action === 'drop' ? 'column-deleted' : ''}`}
                      onClick={() => selectColumn(source.name)}
                      onFocusCapture={() => selectColumn(source.name)}
                    >
                      <TableCell className="designer-name">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('Select column {name}', { name: source.name })}
                          aria-pressed={!adding && source.name === column?.name}
                          onClick={() => selectColumn(source.name)}
                          onKeyDown={(event) => {
                            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
                              return;
                            event.preventDefault();
                            const index = detail.columns.indexOf(source);
                            const target =
                              event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? detail.columns.length - 1
                                  : Math.max(
                                      0,
                                      Math.min(
                                        detail.columns.length - 1,
                                        index + (event.key === 'ArrowDown' ? 1 : -1),
                                      ),
                                    );
                            selectColumn(detail.columns[target].name);
                            event.currentTarget
                              .closest('tbody')
                              ?.querySelectorAll<HTMLButtonElement>('.designer-name > button')
                              [target]?.focus();
                          }}
                        >
                          {changed ? '•' : '›'}
                        </Button>
                        <Input
                          aria-label={`${t('Column name')} · ${source.name}`}
                          value={value.name}
                          disabled={disabled || !editable}
                          onChange={(event) =>
                            update(
                              { action: 'rename', column: source.name, name: event.target.value },
                              event.target.value === source.name,
                            )
                          }
                        />
                      </TableCell>
                      <ColumnTypeEditor
                        engine={detail.engine}
                        value={value.type}
                        column={source.name}
                        strict={/\bSTRICT\s*;?$/i.test(detail.definition)}
                        disabled={disabled || !editable || !!source.generated}
                        onChange={(type) =>
                          update(
                            { action: 'type', column: source.name, type },
                            type === source.type,
                          )
                        }
                      />
                      <TableCell className="designer-check">
                        <Checkbox
                          aria-label={t('Allow NULL for {name}', { name: source.name })}
                          checked={value.nullable}
                          disabled={
                            disabled ||
                            !editable ||
                            !!source.generated ||
                            keys.includes(source.name)
                          }
                          onCheckedChange={(event) =>
                            update(
                              {
                                action: 'nullable',
                                column: source.name,
                                nullable: event,
                              },
                              event === source.nullable,
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="designer-check">
                        <Label className="inline">
                          <Checkbox
                            aria-label={t('Primary key column {name}', { name: source.name })}
                            checked={keys.includes(source.name)}
                            disabled={disabled || !editable}
                            onCheckedChange={(event) => toggleKey(source.name, event)}
                          />
                          {keys.includes(source.name) && (
                            <span title={t('Primary key')}>
                              ◆{keyDraft !== undefined ? keys.indexOf(source.name) + 1 : ''}
                            </span>
                          )}
                        </Label>
                      </TableCell>
                      <TableCell className="column-default" title={value.defaultSql}>
                        {value.defaultSql || '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {adding && (
                  <TableRow className="column-selected column-pending">
                    <TableCell>{change.name || t('Unnamed column')} •</TableCell>
                    <TableCell>{change.type}</TableCell>
                    <TableCell colSpan={2}>—</TableCell>
                    <TableCell>{t(change.nullable ? 'Yes' : 'No')}</TableCell>
                    <TableCell>{change.primaryKey ? '◆' : '—'}</TableCell>
                    <TableCell>{change.defaultSql || '—'}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {shown && (
            <Fieldset className="column-properties" disabled={disabled}>
              <legend>
                {adding ? t('New column') : t('Column properties')} ·{' '}
                {adding ? change.name || t('Unnamed column') : column?.name}
              </legend>
              {column?.generated && !adding && (
                <Alert role="status" className="notice">
                  {t(
                    column?.generation
                      ? 'Edit the expression in the Generated columns tab.'
                      : 'Generated columns can only be renamed or dropped here.',
                  )}
                </Alert>
              )}
              {change?.action === 'drop' && (
                <Alert role="status" className="notice">
                  {t('Dropping this column permanently removes its data.')}
                </Alert>
              )}
              <div className="column-property-grid">
                <Label>
                  {t('Column name')}
                  <Input
                    aria-label={t('Column name')}
                    disabled={locked()}
                    value={shown.name}
                    onChange={(event) =>
                      adding
                        ? onChange({ ...change, name: event.target.value })
                        : update(
                            { action: 'rename', column: column.name, name: event.target.value },
                            event.target.value === column.name,
                          )
                    }
                  />
                </Label>
                <ColumnTypeEditor
                  engine={detail.engine}
                  value={shown.type}
                  strict={/\bSTRICT\s*;?$/i.test(detail.definition)}
                  disabled={locked() || (!adding && !!column?.generated)}
                  onChange={(type) =>
                    adding
                      ? onChange({ ...change, type })
                      : update({ action: 'type', column: column.name, type }, type === column.type)
                  }
                />
                <Label className="property-default">
                  {t('Default SQL expression')}
                  <Input
                    aria-label={t('Default SQL expression')}
                    placeholder={t('Empty means no default')}
                    disabled={locked() || (!adding && !!column?.generated)}
                    value={shown.defaultSql}
                    onChange={(event) =>
                      adding
                        ? onChange({ ...change, defaultSql: event.target.value })
                        : update(
                            {
                              action: 'default',
                              column: column.name,
                              defaultSql: event.target.value,
                            },
                            event.target.value === column.defaultSql,
                          )
                    }
                  />
                  <small>{t("Use SQL expressions; quote text values, for example 'guest'.")}</small>
                </Label>
                <Label className="inline">
                  <Checkbox
                    checked={shown.nullable}
                    disabled={
                      locked() ||
                      (adding
                        ? !!change.primaryKey
                        : !!column?.generated || keys.includes(column.name))
                    }
                    onCheckedChange={(event) =>
                      adding
                        ? onChange({ ...change, nullable: event })
                        : update(
                            {
                              action: 'nullable',
                              column: column.name,
                              nullable: event,
                            },
                            event === column.nullable,
                          )
                    }
                  />
                  {t('Allow NULL')}
                </Label>
                <Label className="inline">
                  <Checkbox
                    aria-label={t('Column is primary key')}
                    checked={adding ? !!change.primaryKey : keys.includes(column.name)}
                    disabled={locked()}
                    onCheckedChange={(event) =>
                      adding
                        ? onChange({
                            ...change,
                            primaryKey: event,
                            nullable: event ? false : change.nullable,
                          })
                        : toggleKey(column.name, event)
                    }
                  />
                  {t('Primary key')}
                </Label>
              </div>
            </Fieldset>
          )}
        </TabsContent>
      ) : section === 'keys' ? (
        <TabsContent value="keys" className="designer-keys" aria-label={t('Primary key')}>
          <h3>{t('Edit primary key')}</h3>
          <p>{t('Select primary key columns. Clear all to remove the primary key.')}</p>
          <p>
            {t(
              'Primary key order follows selection order. Existing columns are listed in table order.',
            )}
          </p>
          <Fieldset disabled={disabled || !editable}>
            <legend>{t('Primary key columns')}</legend>
            {detail.columns.map((item) => (
              <Label className="inline" key={item.name}>
                <Checkbox
                  aria-label={t('Primary key column {name}', { name: item.name })}
                  checked={keys.includes(item.name)}
                  onCheckedChange={(event) => toggleKey(item.name, event)}
                />
                {item.name}
                <small>{item.type}</small>
              </Label>
            ))}
          </Fieldset>
          <p>
            <strong>{t('Primary key')}: </strong>
            {keys.length ? keys.join(keyDraft !== undefined ? ' → ' : ', ') : t('None')}
          </p>
        </TabsContent>
      ) : section === 'generated' ? (
        <TabsContent value="generated" className="designer-constraints">
          <GeneratedColumnDesigner
            detail={detail}
            change={change}
            disabled={disabled}
            onChange={onChange}
          />
        </TabsContent>
      ) : section === 'options' || section === 'column-options' ? (
        <TabsContent value={section} className="designer-constraints">
          {section === 'column-options' && (
            <Label>
              {t('Column')}
              <SelectField
                aria-label={t('Property column')}
                value={column?.name ?? ''}
                disabled={disabled || !!change}
                onValueChange={setSelected}
              >
                {detail.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </SelectField>
            </Label>
          )}
          <StructureProperties
            key={section + column?.name}
            detail={detail}
            columnName={section === 'column-options' ? column?.name : undefined}
            change={change}
            disabled={disabled}
            connectionId={connectionId}
            database={database}
            onChange={onChange}
          />
        </TabsContent>
      ) : (
        <TabsContent value={section} className="designer-constraints">
          <ConstraintDesigner
            key={section}
            detail={detail}
            kind={section}
            change={change}
            disabled={disabled}
            connectionId={connectionId}
            database={database}
            onChange={onChange}
          />
        </TabsContent>
      )}
    </Tabs>
  );
}
