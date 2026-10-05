import { Alert } from './ui/alert';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Fieldset } from './ui/fieldset';
import { confirmAction } from './ConfirmDialog';
import { Button } from './ui/button';
import { TableFilters } from './TableFilters';
import { InsertRowDialog } from './InsertRowDialog';
import { StructureEditor } from './StructureEditor';
import { useI18n } from '../i18n';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ListFilter, LoaderCircle, X } from 'lucide-react';
import type { Column, Filter, QueryResult, Settings, WorkspaceTab } from '../../../shared/types';
import { command } from '../api';
import { ResultGrid } from './ResultGrid';
export function TableView({
  tab,
  settings,
  readOnly = false,
  onError,
  viewRequest,
}: {
  tab: WorkspaceTab;
  settings: Settings;
  readOnly?: boolean;
  onError: (error: unknown) => void;
  viewRequest?: { structure: boolean; revision: number };
}) {
  const t = useI18n();
  const [result, setResult] = useState<QueryResult>();
  const [columns, setColumns] = useState<Column[]>([]);
  const [structure, setStructure] = useState(!!tab.objectVersion);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' }[]>([]);
  const [applied, setApplied] = useState<Filter[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanelId = useId();
  const filterToggle = useRef<HTMLButtonElement>(null);
  const [edits, setEdits] = useState<Record<number, Record<string, unknown>>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [insert, setInsert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [revision, setRevision] = useState(0);
  const loadSequence = useRef(0);
  const editVersion = useRef(0);
  const editsRef = useRef(edits);
  const originalRows = useRef<Record<number, Record<string, unknown>>>({});
  const container = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const args = {
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
    table: tab.table,
  };
  const dirty = Object.keys(edits).length > 0;
  // Rebuilding every row on each render re-runs the whole grid; only do it when data or edits change.
  const shownResult = useMemo(
    () =>
      result && {
        ...result,
        rows: result.rows.map((row, index) => ({ ...row, ...edits[index] })),
      },
    [result, edits],
  );
  useEffect(() => {
    if (!viewRequest) return;
    if (viewRequest.structure && dirty) {
      onError(new Error(t('Save or revert row edits before editing structure.')));
      return;
    }
    if (!viewRequest.structure && tab.objectVersion) {
      onError(
        new Error(t('Apply or revert the pending structure change before switching to data.')),
      );
      return;
    }
    setStructure(viewRequest.structure);
  }, [viewRequest]);
  const load = async () => {
    // CellEditor commits on blur. An external refresh can arrive while the
    // user is still typing, before workspace.dirty has been updated.
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      container.current?.contains(active) &&
      active.matches('.cell-input')
    )
      active.blur();
    if (Object.keys(editsRef.current).length) {
      setExternalChange(true);
      return;
    }
    const sequence = ++loadSequence.current;
    const version = editVersion.current;
    setLoading(true);
    try {
      const data = await command<QueryResult>('data.select', {
        ...args,
        limit: settings.pageSize,
        offset,
        sort,
        filters: applied,
      });
      if (sequence !== loadSequence.current) return;
      if (version !== editVersion.current || Object.keys(editsRef.current).length) {
        setExternalChange(true);
        return;
      }
      setResult(data);
      setSelected([]);
      setRevision((current) => current + 1);
      setExternalChange(false);
      // The tab may have been closed while the select was in flight; that is not an error.
      await command('workspace.update', { id: tab.id, patch: { selectedRows: [] } }).catch(
        () => undefined,
      );
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  };
  const describeSequence = useRef(0);
  const describe = () => {
    const sequence = ++describeSequence.current;
    return command<Column[]>('table.describe', args)
      .then((columns) => sequence === describeSequence.current && setColumns(columns))
      .catch((error) => sequence === describeSequence.current && onError(error));
  };
  useEffect(() => {
    void describe();
    return () => {
      describeSequence.current++;
    };
  }, [tab.id]);
  useEffect(() => {
    if (!dirty && !busy) void load().catch(onError);
  }, [tab.id, offset, sort, applied, settings.pageSize, dirty, busy]);
  useEffect(
    () =>
      window.desktop.subscribe((event) => {
        const structure = event.type === 'TableStructureChanged';
        if (!structure && !['RowInserted', 'RowUpdated', 'RowDeleted'].includes(event.type)) return;
        const changed = event.payload as {
          connectionId: string;
          database?: string;
          schema?: string;
          table: string;
        };
        if (
          changed.connectionId !== tab.connectionId ||
          changed.database !== tab.database ||
          changed.table !== tab.table ||
          (changed.schema && changed.schema !== tab.schema)
        )
          return;
        // Columns and the primary key may have changed; row predicates depend on them.
        if (structure) void describe();
        if (busy) return;
        if (dirty) setExternalChange(true);
        else void load().catch(onError);
      }),
    [tab.id, dirty, busy, offset, sort, applied, settings.pageSize],
  );
  const mark = (next: typeof edits) => {
    editVersion.current++;
    editsRef.current = next;
    for (const index of Object.keys(originalRows.current))
      if (!next[Number(index)]) delete originalRows.current[Number(index)];
    setEdits(next);
    void command('workspace.update', {
      id: tab.id,
      patch: { dirty: Object.keys(next).length > 0 },
    }).catch(onError);
  };
  const predicate = (row: Record<string, unknown>) => {
    const keys = columns.filter((column) => column.primaryKey);
    if (!keys.length) throw new Error(t('Row editing requires a primary key.'));
    return keys.map((column) => ({
      column: column.name,
      operator: row[column.name] === null ? 'IS NULL' : '=',
      value: row[column.name],
    }));
  };
  const save = async () => {
    if (busy || readOnly) return;
    setBusy(true);
    const remaining = { ...edits };
    try {
      for (const [index, values] of Object.entries(edits)) {
        const saved = await command<QueryResult>('data.update', {
          ...args,
          values,
          filters: predicate(originalRows.current[Number(index)]),
        });
        if (saved.affectedRows === 0)
          throw new Error(
            t(
              'The original row no longer exists. Your edits were kept; revert and refresh to continue.',
            ),
          );
        setResult(
          (current) =>
            current && {
              ...current,
              rows: current.rows.map((row, rowIndex) =>
                rowIndex === Number(index) ? { ...row, ...values } : row,
              ),
            },
        );
        delete remaining[Number(index)];
        mark({ ...remaining });
      }
      mark({});
      await load();
    } catch (error) {
      throw new Error(
        t('Saved {saved} rows; {pending} rows remain. {message}', {
          saved: Object.keys(edits).length - Object.keys(remaining).length,
          pending: Object.keys(remaining).length,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tabs
      value={structure ? 'structure' : 'data'}
      onValueChange={(value) => setStructure(value === 'structure')}
      className="table-view"
      ref={container}
    >
      {!structure && loading && (
        <Alert role="status" aria-live="polite" className="table-loading-status shrink-0">
          <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          <span>{t('Loading data…')}</span>
        </Alert>
      )}
      <Fieldset className="table-operation" disabled={busy || loading} aria-busy={busy || loading}>
        {externalChange && (
          <Alert role="status" className="notice">
            {t('Data changed elsewhere. Save or revert your edits, then refresh.')}
          </Alert>
        )}
        <div className="toolbar">
          <TabsList aria-label={t('Table sections')}>
            <TabsTrigger
              disabled={!!tab.objectVersion}
              title={
                tab.objectVersion
                  ? t('Apply or revert the pending structure change before switching to data.')
                  : undefined
              }
              className={!structure ? 'active' : ''}
              value="data"
            >
              {t('Data')}
            </TabsTrigger>
            <TabsTrigger
              disabled={dirty}
              title={dirty ? t('Save or revert row edits before editing structure.') : undefined}
              className={structure ? 'active' : ''}
              value="structure"
            >
              {t('Structure')}
            </TabsTrigger>
          </TabsList>
          <span className="spacer" />
          <Button
            variant="outline"
            disabled={dirty}
            hidden={structure}
            onClick={() => void load().catch(onError)}
          >
            {t('Refresh')}
          </Button>
          <Button
            ref={filterToggle}
            size="default"
            variant="outline"
            hidden={structure}
            aria-label={t('Filters')}
            aria-expanded={filtersOpen}
            aria-controls={filterPanelId}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <ListFilter />
            {t('Filters')}
            {applied.length > 0 && ` (${applied.length})`}
          </Button>
        </div>
        {structure ? (
          <TabsContent value="structure" className="table-mode">
            <StructureEditor
              tab={tab}
              onBusy={setBusy}
              onApplied={(value) => {
                setColumns(value.columns);
                setOffset(0);
                setSort([]);
                setApplied([]);
                setResult(undefined);
              }}
            />
          </TabsContent>
        ) : (
          <TabsContent value="data" className="table-mode">
            <div className="table-data-layout">
              <div className="table-data-main">
                <div className="toolbar">
                  <span className="spacer" />
                  <Button
                    variant="outline"
                    disabled={readOnly || dirty || !columns.length}
                    onClick={() => setInsert(true)}
                  >
                    {t('+ Row')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={readOnly || !selected.length || dirty}
                    onClick={async () => {
                      if (
                        await confirmAction(
                          t('Delete {count} selected rows?', { count: selected.length }),
                        )
                      )
                        void (async () => {
                          setBusy(true);
                          try {
                            for (const index of selected)
                              await command('data.delete', {
                                ...args,
                                filters: predicate(result!.rows[index]),
                              });
                            await load();
                          } finally {
                            setBusy(false);
                          }
                        })().catch(onError);
                    }}
                  >
                    {t('Delete')}
                  </Button>
                </div>

                {!readOnly && result && !columns.some((column) => column.primaryKey) && (
                  <Alert role="status" className="notice">
                    {t('Row editing requires a primary key.')}
                  </Alert>
                )}
                {result && (
                  <ResultGrid
                    sort={sort[0]}
                    editedCells={edits}
                    columnMetadata={columns}
                    key={`${revision}-${offset}-${JSON.stringify(applied)}-${JSON.stringify(sort)}`}
                    result={shownResult!}
                    onEdit={
                      !readOnly && columns.some((column) => column.primaryKey)
                        ? (row, column, value) => {
                            originalRows.current[row] ??= { ...result.rows[row] };
                            const next = { ...edits, [row]: { ...edits[row], [column]: value } };
                            if (Object.is(value, result.rows[row][column]))
                              delete next[row][column];
                            if (!Object.keys(next[row]).length) delete next[row];
                            mark(next);
                          }
                        : undefined
                    }
                    onSelect={(rows) => {
                      setSelected(rows);
                      void command('workspace.update', {
                        id: tab.id,
                        patch: { selectedRows: rows.map((index) => result.rows[index]) },
                      }).catch(onError);
                    }}
                    onSort={(column) => {
                      if (!dirty) {
                        setOffset(0);
                        setSort([
                          {
                            column,
                            direction:
                              sort[0]?.column === column && sort[0].direction === 'asc'
                                ? 'desc'
                                : 'asc',
                          },
                        ]);
                      }
                    }}
                  />
                )}
                <div className="toolbar bottom">
                  <Button
                    variant="outline"
                    disabled={dirty || !offset}
                    onClick={() => setOffset(Math.max(0, offset - settings.pageSize))}
                  >
                    {t('← Previous')}
                  </Button>
                  <span>
                    {t('Page {page} · {count} rows / page', {
                      page: Math.floor(offset / settings.pageSize) + 1,
                      count: settings.pageSize,
                    })}
                  </span>
                  <Button
                    variant="outline"
                    disabled={dirty || !result?.hasMore}
                    onClick={() => setOffset(offset + settings.pageSize)}
                  >
                    {t('Next →')}
                  </Button>
                  <span className="spacer" />
                  {dirty && (
                    <>
                      <span className="dirty">
                        {t('Unsaved changes')} ·{' '}
                        {t('{count} modified rows', { count: Object.keys(edits).length })}
                      </span>
                      <Button variant="outline" onClick={() => mark({})}>
                        {t('Revert')}
                      </Button>
                      <Button
                        variant="default"
                        className="primary"
                        onClick={() => void save().catch(onError)}
                      >
                        {t('Save changes')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <aside
                id={filterPanelId}
                className="table-filter-panel"
                hidden={!filtersOpen}
                aria-label={t('Filters')}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !event.defaultPrevented) {
                    event.preventDefault();
                    setFiltersOpen(false);
                    filterToggle.current?.focus();
                  }
                }}
              >
                <div className="toolbar">
                  <strong>{t('Filters')}</strong>
                  <span className="spacer" />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('Close filters')}
                    onClick={() => {
                      setFiltersOpen(false);
                      filterToggle.current?.focus();
                    }}
                  >
                    <X />
                  </Button>
                </div>
                <TableFilters
                  key={columns.map((column) => column.name).join('|')}
                  columns={columns}
                  applied={applied}
                  disabled={dirty}
                  onApply={(filters) => {
                    setApplied(filters);
                    setOffset(0);
                  }}
                />
              </aside>
            </div>
          </TabsContent>
        )}
        {insert && (
          <InsertRowDialog
            columns={columns}
            onClose={() => setInsert(false)}
            onInsert={async (values) => {
              await command('data.insert', { ...args, values });
              await load().catch(onError);
            }}
          />
        )}
      </Fieldset>
    </Tabs>
  );
}
