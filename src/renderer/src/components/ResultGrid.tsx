import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from './ui/table';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { Button } from './ui/button';
import { useI18n } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Column, QueryResult } from '../../../shared/types';
import { CellEditor } from './CellEditor';
import { Eye } from 'lucide-react';
import { CellValueDialog } from './CellValueDialog';
import { serializeRows } from '../../../shared/result-format';
import { command } from '../api';
// Cells only need a glimpse; the full value opens in the cell dialog. Rendering
// megabytes of TEXT/JSON per visible cell makes the whole grid slow.
const PREVIEW_LIMIT = 1000;
const preview = (value: unknown) => {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
};
export function ResultGrid({
  result,
  onEdit,
  onSelect,
  onSort,
  columnMetadata,
  sort,
  editedCells,
  pageKey,
}: {
  sort?: { column: string; direction: 'asc' | 'desc' };
  editedCells?: Record<number, Record<string, unknown>>;
  pageKey?: unknown;
  result: QueryResult;
  onEdit?: (row: number, column: string, value: string | number | boolean | null) => void;
  columnMetadata?: Column[];
  onSelect?: (rows: number[]) => void;
  onSort?: (column: string) => void;
}) {
  const t = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  // Keep cell renderers stable while row drafts change. Replacing the column
  // render functions on each blur remounts other inputs and drops their text.
  const editRef = useRef(onEdit);
  editRef.current = onEdit;
  const editable = !!onEdit;
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setSelected({});
    setMessage('');
    setInspected(undefined);
  }, [pageKey]);
  const [inspected, setInspected] = useState<{ column: string; value: unknown }>();
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const copy = (text: string) => {
    void command('clipboard.result.copy', { content: text })
      .then(() => setMessage(t('Copied')))
      .catch(() => setMessage(t('Could not copy. Select the text and copy manually.')));
  };
  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      result.columns.map((name) => ({
        id: name,
        accessorFn: (row) => row[name],
        header: name,
        size: 180,
        minSize: 70,
        cell: (context) => {
          const value = context.getValue();
          return editable && !columnMetadata?.find((column) => column.name === name)?.generated ? (
            <CellEditor
              value={value}
              column={columnMetadata?.find((column) => column.name === name)}
              label={`${name} row ${context.row.index + 1}`}
              onChange={(next) => editRef.current?.(context.row.index, name, next)}
            />
          ) : (
            <span className={value === null ? 'null' : ''}>
              {value === null ? 'NULL' : preview(value)}
            </span>
          );
        },
      })),
    [result.columns, editable, columnMetadata],
  );
  const table = useReactTable({
    data: result.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
    state: { rowSelection: selected },
    onRowSelectionChange: (update) => {
      const next = typeof update === 'function' ? update(selected) : update;
      setSelected(next);
      onSelect?.(
        Object.keys(next)
          .filter((key) => next[key])
          .map(Number),
      );
    },
  });
  const rows = table.getRowModel().rows;
  const selectedRows = rows.filter((row) => row.getIsSelected()).map((row) => row.original);
  const visibleColumns = table.getVisibleLeafColumns().map((column) => column.id);
  const exportPage = async (format: 'csv' | 'json') => {
    setSaving(true);
    setMessage('');
    try {
      const saved = await command('file.result.save', {
        format,
        content: serializeRows(visibleColumns, result.rows, format),
      });
      if (saved) setMessage(t('Current page exported'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 34,
    overscan: 10,
  });
  return (
    <div className="grid-wrap">
      <div className="column-controls">
        <Popover>
          <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
            {t('Columns')}
          </PopoverTrigger>
          <PopoverContent align="start" aria-label={t('Columns')} className="column-picker">
            {table.getAllLeafColumns().map((column) => (
              <Label key={column.id}>
                <Checkbox
                  checked={column.getIsVisible()}
                  onCheckedChange={(checked) => column.toggleVisibility(checked)}
                />
                {column.id}
              </Label>
            ))}
          </PopoverContent>
        </Popover>
        <span>
          {t('This page: {count} rows · {duration} ms', {
            count: result.rowCount.toLocaleString(),
            duration: Math.round(result.duration),
          })}
          {result.hasMore ? t(' · More rows available') : ''}
          {result.affectedRows ? t(' · {count} affected', { count: result.affectedRows }) : ''}
        </span>
        <span className="spacer" />
        <Button
          variant="outline"
          size="sm"
          disabled={!rows.length || !visibleColumns.length}
          onClick={() => copy(serializeRows(visibleColumns, result.rows, 'tsv'))}
        >
          {t('Copy page')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!selectedRows.length || !visibleColumns.length}
          onClick={() => copy(serializeRows(visibleColumns, selectedRows, 'tsv'))}
        >
          {t('Copy selected rows')}
        </Button>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                disabled={saving || !rows.length || !visibleColumns.length}
              />
            }
          >
            {t('Export page')}
          </PopoverTrigger>
          <PopoverContent align="end" className="result-export-options">
            <p>{t('Current page and visible columns only. Unsaved edits are included.')}</p>
            <p className="muted">
              {t('CSV uses blank fields for NULL; JSON preserves types and NULL.')}
            </p>
            <Button variant="outline" disabled={saving} onClick={() => void exportPage('csv')}>
              CSV
            </Button>
            <Button variant="outline" disabled={saving} onClick={() => void exportPage('json')}>
              JSON
            </Button>
          </PopoverContent>
        </Popover>
      </div>
      {message && (
        <div className="result-message" role="status">
          {message}
        </div>
      )}
      <div className="data-scroll" ref={ref}>
        <Table
          containerClassName="contents"
          aria-label={t('Query results')}
          aria-rowcount={result.rows.length + 1}
          className="data-table"
          style={{ width: table.getTotalSize() + 42 }}
        >
          <TableHeader>
            <TableRow className="data-head" aria-rowindex={1}>
              <TableHead style={{ width: 42 }}>
                <span aria-hidden="true">✓</span>
                <span className="sr-only">{t('Select')}</span>
              </TableHead>
              {table.getHeaderGroups()[0]?.headers.map((header) => (
                <TableHead
                  key={header.id}
                  role="columnheader"
                  aria-sort={
                    sort?.column === header.column.id
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  style={{ width: header.getSize() }}
                >
                  <Button
                    variant="outline"
                    aria-label={header.column.id}
                    disabled={!onSort}
                    onClick={() => onSort?.(header.column.id)}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sort?.column === header.column.id && (
                      <span aria-hidden="true"> {sort.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </Button>
                  <span
                    className="resize"
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                  />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <TableRow
                  className={`data-row ${row.getIsSelected() ? 'selected' : ''}`}
                  key={row.id}
                  aria-rowindex={item.index + 2}
                  style={{
                    position: 'absolute',
                    width: '100%',
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <TableCell style={{ width: 42 }}>
                    <Checkbox
                      aria-label={t('Select row {row}', { row: item.index + 1 })}
                      checked={row.getIsSelected()}
                      onCheckedChange={(checked) => row.toggleSelected(checked)}
                    />
                  </TableCell>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      className={
                        editedCells?.[row.index] &&
                        Object.hasOwn(editedCells[row.index], cell.column.id)
                          ? 'cell-modified'
                          : undefined
                      }
                      key={cell.id}
                      style={{ width: cell.column.getSize() }}
                    >
                      <div className="result-cell-content">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="result-cell-view"
                          aria-label={t('View {column} row {row}', {
                            column: cell.column.id,
                            row: row.index + 1,
                          })}
                          onClick={() =>
                            setInspected({ column: cell.column.id, value: cell.getValue() })
                          }
                        >
                          <Eye />
                        </Button>
                      </div>
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
            {!rows.length && (
              <TableRow>
                <TableCell className="empty-small" colSpan={visibleColumns.length + 1}>
                  {t('No rows to display')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {inspected && <CellValueDialog {...inspected} onClose={() => setInspected(undefined)} />}
    </div>
  );
}
