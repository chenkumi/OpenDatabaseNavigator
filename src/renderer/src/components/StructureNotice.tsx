import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Table } from './ui/table';
import { TableHeader } from './ui/table';
import { TableRow } from './ui/table';
import { TableHead } from './ui/table';
import { TableBody } from './ui/table';
import { TableCell } from './ui/table';
import { useState } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import type { ColumnPropertyChange, StructureChange, TableStructure } from '../../../shared/types';
import { useI18n } from '../i18n';

export function StructureNotice({
  change,
  detail,
  error,
  message,
}: {
  change?: StructureChange;
  detail?: TableStructure;
  error: string;
  message: string;
}) {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const rows: { column: string; property: string; before: string; after: string }[] = [];
  const value = (v: unknown) => (v === undefined || v === '' ? '—' : String(v));
  const property = (item: ColumnPropertyChange) => {
    const original = detail?.columns.find((column) => column.name === item.column);
    const labels = {
      rename: 'Column name',
      type: 'Data type',
      nullable: 'Allow NULL',
      default: 'Default SQL expression',
    };
    const before =
      item.action === 'rename'
        ? original?.name
        : item.action === 'type'
          ? original?.type
          : item.action === 'default'
            ? original?.defaultSql
            : original
              ? t(original.nullable ? 'Yes' : 'No')
              : undefined;
    const after =
      item.action === 'rename'
        ? item.name
        : item.action === 'type'
          ? item.type
          : item.action === 'default'
            ? item.defaultSql
            : t(item.nullable ? 'Yes' : 'No');
    rows.push({
      column: item.column,
      property: t(labels[item.action]),
      before: value(before),
      after: value(after),
    });
  };
  const keys = (names: string[]) => {
    rows.push({
      column: detail?.table ?? '',
      property: t('Primary key'),
      before:
        detail?.columns
          .filter((c) => c.primaryKey)
          .map((c) => c.name)
          .join(', ') || t('None'),
      after: names.join(' → ') || t('None'),
    });
    for (const name of names) {
      if (
        detail?.columns.find((column) => column.name === name)?.nullable &&
        !rows.some((row) => row.column === name && row.property === t('Allow NULL'))
      )
        rows.push({ column: name, property: t('Allow NULL'), before: t('Yes'), after: t('No') });
    }
  };
  if (change?.action === 'edit-columns') {
    change.changes.forEach(property);
    if (change.primaryKey !== undefined) keys(change.primaryKey);
  } else if (change?.action === 'primary-key') keys(change.columns);
  else if (change?.action === 'add') {
    rows.push({
      column: change.name || t('Unnamed column'),
      property: t('Add column'),
      before: '—',
      after: `${change.type} · ${t(change.nullable ? 'Allow NULL' : 'NOT NULL')} · ${t('Default')}: ${value(change.defaultSql)}${change.primaryKey ? ` · ${t('Primary key')}` : ''}`,
    });
  } else if (change?.action === 'drop') {
    rows.push({
      column: change.column,
      property: t('Drop column'),
      before: change.column,
      after: '—',
    });
  } else if (change?.action === 'constraint-upsert' || change?.action === 'constraint-drop') {
    const existing = detail?.constraints?.find((item) => item.id === change.id);
    rows.push({
      column:
        change.action === 'constraint-upsert'
          ? change.constraint.name
          : existing?.definition.name || '',
      property: t(change.action === 'constraint-drop' ? 'Drop constraint' : 'Constraint'),
      before: existing ? JSON.stringify(existing.definition) : '—',
      after: change.action === 'constraint-upsert' ? JSON.stringify(change.constraint) : '—',
    });
  } else if (change?.action === 'table-properties' || change?.action === 'column-properties') {
    const original =
      change.action === 'column-properties'
        ? detail?.columns.find((column) => column.name === change.column)?.properties
        : detail?.properties;
    const labels: Record<string, string> = {
      storageEngine: 'Storage engine',
      charset: 'Character set',
      collation: 'Collation',
      binary: 'Binary comparison',
      comment: 'Comment',
    };
    for (const [key, after] of Object.entries(change.properties))
      rows.push({
        column: change.action === 'column-properties' ? change.column : (detail?.table ?? ''),
        property: t(labels[key]),
        before: value((original as Record<string, unknown> | undefined)?.[key]),
        after: value(after),
      });
  } else if (change?.action === 'generated-add' || change?.action === 'generated-edit') {
    const column = change.action === 'generated-add' ? change.name : change.column;
    rows.push({
      column,
      property: t('Generated column'),
      before: value(detail?.columns.find((c) => c.name === column)?.generation?.expression),
      after: `${change.generation.storage}: ${change.generation.expression}`,
    });
  } else if (change?.action === 'view-options') {
    const labels = {
      algorithm: 'View algorithm',
      definer: 'Definer',
      security: 'View security',
      checkOption: 'Check option',
    };
    for (const [key, after] of Object.entries(change.options)) {
      const before = detail?.viewOptions?.[key as keyof typeof change.options];
      const display = (v: unknown) =>
        v === null ? t('Current account') : typeof v === 'object' ? JSON.stringify(v) : value(v);
      rows.push({
        column: detail?.table ?? '',
        property: t(labels[key as keyof typeof labels]),
        before: display(before),
        after: display(after),
      });
    }
  } else if (change && change.action !== 'view') property(change);
  const readOnly = detail?.readOnlyReason;
  const label = error
    ? t('Structure change failed')
    : change
      ? t('Pending structure change')
      : message
        ? t(message)
        : readOnly
          ? t('Read only')
          : '';
  return (
    <div className="structure-notice-slot">
      {label && (
        <Popover open={open} onOpenChange={setOpen}>
          <span role={error ? 'alert' : 'status'}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className={`structure-notice-trigger ${error ? 'has-error' : ''}`}
                  title={label}
                  aria-label={label}
                />
              }
            >
              ⓘ {label}
            </PopoverTrigger>
            {error && <span className="sr-only">{t(error)}</span>}
          </span>
          <PopoverContent
            align="start"
            aria-label={t('Structure change details')}
            className="structure-notice-content"
          >
            <header>
              <strong>{t('Structure change details')}</strong>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                aria-label={t('Close details')}
              >
                ×
              </Button>
            </header>
            {error && (
              <Alert role="status" className="notice">
                {t(error)}
              </Alert>
            )}
            {message && <p>{t(message)}</p>}
            {readOnly && <p>{t(readOnly)}</p>}
            {rows.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    {['Column', 'Change', 'Before', 'After'].map((label) => (
                      <TableHead key={label}>{t(label)}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => (
                    <TableRow key={index}>
                      <TableCell>{row.column}</TableCell>
                      <TableCell>{row.property}</TableCell>
                      <TableCell>{row.before}</TableCell>
                      <TableCell>{row.after}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {change?.action === 'view' && <pre>{change.sql}</pre>}
            {change && <p>{t('Changes are not applied until you preview and apply them.')}</p>}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
