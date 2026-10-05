import { Alert } from './ui/alert';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { DropObjectDialog } from './DropObjectDialog';
import { RenameObjectDialog } from './RenameObjectDialog';
import { useEffect, useRef, useState } from 'react';
import type { Connection, TableInfo, DatabaseObject } from '../../../shared/types';
import { command } from '../api';
import { useI18n } from '../i18n';
import { ActionMenu } from './ActionMenu';
import { ExplorerTable } from './ExplorerTable';
import { SelectField } from './SelectField';
import type { DatabaseOptions, DatabaseCreateOptions } from '../../../shared/database-options';
import { PostgresDatabaseOptions } from './PostgresDatabaseOptions';
import { DatabasePropertiesDialog } from './DatabasePropertiesDialog';
import { SqlScriptDialog } from './SqlScriptDialog';
import { SqlExportDialog } from './SqlExportDialog';

export function DatabaseExplorer({
  connection,
  scope,
  onScope,
  onOpen,
  onError,
  onNewFile,
  onQuery,
  onObject,
  refresh = 0,
}: {
  refresh?: number;
  connection: Connection;
  scope?: { database: string; schema: string };
  onScope: (database: string, schema?: string) => Promise<void>;
  onOpen: (database: string, table: TableInfo, structure?: boolean) => void;
  onError: (error: unknown) => void;
  onNewFile: () => void;
  onQuery: (database: string) => void;
  onObject: (database: string, object: DatabaseObject) => void;
}) {
  const t = useI18n();
  const [databases, setDatabases] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [charset, setCharset] = useState('');
  const [postgresOptions, setPostgresOptions] = useState<DatabaseCreateOptions>({});
  const [collation, setCollation] = useState('');
  const [options, setOptions] = useState<DatabaseOptions>({ charsets: [], collations: [] });
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  const [collationSearch, setCollationSearch] = useState('');
  const matchingCollations = options.collations.filter(
    (item) =>
      (!charset || item.charset === charset) &&
      item.name.toLowerCase().includes(collationSearch.toLowerCase()),
  );
  const visibleCollations = matchingCollations.slice(0, 200);
  const selectedCollation = options.collations.find((item) => item.name === collation);
  if (selectedCollation && !visibleCollations.includes(selectedCollation))
    visibleCollations.unshift(selectedCollation);
  useEffect(() => {
    if (!creating) return;
    let current = true;
    setCharset('');
    setPostgresOptions({});
    setCollation('');
    setCollationSearch('');
    setOptions({ charsets: [], collations: [] });
    setOptionsError('');
    setOptionsLoading(false);
    if (!['mysql', 'sqlserver', 'postgres'].includes(connection.engine)) return;
    setOptionsLoading(true);
    void command<DatabaseOptions>('database.options', { connectionId: connection.id })
      .then((value) => {
        if (current) setOptions(value);
      })
      .catch((error: Error) => {
        if (current) setOptionsError(error.message);
      })
      .finally(() => {
        if (current) setOptionsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [creating, connection.id, connection.engine]);
  const loadSeq = useRef(0);
  const load = async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const list =
        connection.engine === 'sqlite'
          ? [connection.database]
          : await command<string[]>('database.list', { connectionId: connection.id });
      if (seq !== loadSeq.current) return;
      setDatabases(list);
      setRevision((value) => value + 1);
    } catch (error) {
      if (seq === loadSeq.current) setError((error as Error).message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [connection.id]);
  return (
    <>
      <div className="navigation-heading">
        <span>▤ {t('Database Explorer')}</span>
        <div className="inline">
          <Button
            size="icon-sm"
            variant="ghost"
            title={t('Refresh databases')}
            aria-label={t('Refresh databases')}
            disabled={loading}
            onClick={() => void load()}
          >
            ↻
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t('Create database')}
            aria-label={t('Create database')}
            disabled={connection.engine === 'sybase'}
            onClick={() => {
              if (connection.engine === 'sqlite') onNewFile();
              else {
                setName('');
                setCreateError('');
                setCreating(true);
              }
            }}
          >
            ＋
          </Button>
        </div>
      </div>
      <Input
        className="search"
        aria-label={t('Search tables…')}
        placeholder={t('Search tables…')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="database-tree">
        {loading && <p className="muted">{t('Loading…')}</p>}
        {error && (
          <Alert className="notice" role="alert">
            {error}
          </Alert>
        )}
        {databases.map((database) => (
          <DatabaseNode
            key={`${database}:${revision}`}
            refresh={refresh}
            connection={connection}
            database={database}
            selected={scope}
            search={search}
            onQuery={onQuery}
            onObject={onObject}
            onScope={onScope}
            onOpen={onOpen}
            onError={onError}
          />
        ))}
      </div>
      {creating && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) (() => setCreating(false))();
          }}
        >
          <DialogContent
            showCloseButton={false}
            render={<form />}
            className="modal database-create"

            aria-labelledby="create-database-title"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setCreateError('');
              try {
                await command('database.create', {
                  connectionId: connection.id,
                  database: name,
                  ...(charset ? { charset } : {}),
                  ...(collation ? { collation } : {}),
                  ...(connection.engine === 'postgres' ? postgresOptions : {}),
                });
              } catch (error) {
                setCreateError((error as Error).message);
                setBusy(false);
                return;
              }
              setCreating(false);
              setBusy(false);
              await load();
              await onScope(name).catch(onError);
            }}
          >
            <header>
              <DialogTitle id="create-database-title">{t('Create database')}</DialogTitle>
              <Button
                size="icon"
                variant="ghost"
                type="button"
                disabled={busy}
                aria-label={t('Close')}
                onClick={() => setCreating(false)}
              >
                ✕
              </Button>
            </header>
            <p className="muted">
              {connection.name} · {connection.engine}
            </p>
            <Label className="database-name-field">
              {t('Database name')}
              <Input
                autoFocus
                required
                disabled={busy}
                maxLength={128}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Label>
            {['mysql', 'postgres'].includes(connection.engine) && (
              <Label>
                {t('Character set')}
                <SelectField
                  aria-label={t('Character set')}
                  value={charset}
                  disabled={busy || optionsLoading || !!optionsError}
                  onValueChange={(value) => {
                    setCharset(value);
                    setCollation('');
                    setCollationSearch('');
                  }}
                >
                  <option value="">{t('Server default')}</option>
                  {options.charsets.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </SelectField>
              </Label>
            )}
            {connection.engine === 'postgres' && (
              <PostgresDatabaseOptions
                options={options.postgres}
                value={postgresOptions}
                onChange={setPostgresOptions}
                disabled={busy || optionsLoading || !!optionsError}
              />
            )}
            {['mysql', 'sqlserver'].includes(connection.engine) && (
              <>
                <Label>
                  {t('Search collations')}
                  <Input
                    aria-label={t('Search collations')}
                    value={collationSearch}
                    disabled={busy || optionsLoading || !!optionsError}
                    onChange={(event) => setCollationSearch(event.target.value)}
                  />
                </Label>
                <Label>
                  {t('Collation')}
                  <SelectField
                    aria-label={t('Collation')}
                    value={collation}
                    disabled={busy || optionsLoading || !!optionsError}
                    onValueChange={setCollation}
                  >
                    <option value="">{t('Default collation')}</option>
                    {visibleCollations.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                  </SelectField>
                </Label>
                {matchingCollations.length > 200 && (
                  <small>{t('Showing the first 200 matches. Search to narrow the list.')}</small>
                )}
              </>
            )}
            {optionsLoading && <p className="muted">{t('Loading…')}</p>}
            {optionsError && (
              <Alert role="alert">
                {t(
                  'Could not load server options. You can still create a database using defaults.',
                )}{' '}
                {optionsError}
              </Alert>
            )}
            <p className="muted">
              {t(
                'Unspecified options use defaults. Your account needs permission to create databases.',
              )}
            </p>
            {createError && (
              <Alert className="notice" role="alert">
                {createError}
              </Alert>
            )}
            <footer>
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                variant="default"
                className="primary"
                disabled={busy || !name.trim()}
              >
                {busy ? t('Creating…') : t('Create database')}
              </Button>
            </footer>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function DatabaseNode({
  connection,
  database,
  selected,
  search,
  onScope,
  onQuery,
  onObject,
  onOpen,
  onError,
  refresh = 0,
}: {
  refresh?: number;
  connection: Connection;
  database: string;
  selected?: { database: string; schema: string };
  search: string;
  onQuery: (database: string) => void;
  onObject: (database: string, object: DatabaseObject) => void;
  onScope: (database: string, schema?: string) => Promise<void>;
  onOpen: (database: string, table: TableInfo, structure?: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const t = useI18n();
  const [open, setOpen] = useState(database === selected?.database);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [scriptRevision, setScriptRevision] = useState(0);
  useEffect(
    () =>
      window.desktop.subscribe((event) => {
        const target = event.payload as { connectionId?: string; database?: string };
        if (
          event.type === 'SqlScriptFinished' &&
          target.connectionId === connection.id &&
          target.database === database
        )
          setScriptRevision((value) => value + 1);
      }),
    [connection.id, database],
  );
  const [tables, setTables] = useState<TableInfo[]>();
  const [owners, setOwners] = useState<string[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (selected?.database === database) setOpen(true);
  }, [selected?.database, database]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError('');
    command<string[]>('schema.list', { connectionId: connection.id, database })
      .then(async (schemas) => {
        if (connection.engine === 'sybase') {
          if (!cancelled) setOwners([...new Set(schemas)].sort((a, b) => a.localeCompare(b)));
          return;
        }
        const objects: TableInfo[] = [];
        for (const schema of schemas) {
          if (cancelled) return;
          objects.push(
            ...(await command<TableInfo[]>('table.list', {
              connectionId: connection.id,
              database,
              schema,
            })),
          );
        }
        if (!cancelled)
          setTables(
            objects.sort(
              (a, b) => a.name.localeCompare(b.name) || a.schema.localeCompare(b.schema),
            ),
          );
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, connection.id, connection.engine, database, scriptRevision, refresh]);
  const label =
    connection.engine === 'sqlite' ? database.split(/[\\/]/).at(-1) || database : database;
  return (
    <div className="database-node">
      {exportOpen && (
        <SqlExportDialog
          connectionId={connection.id}
          database={database}
          engine={connection.engine}
          onClose={() => setExportOpen(false)}
        />
      )}
      {scriptOpen && (
        <SqlScriptDialog
          connectionId={connection.id}
          database={database}
          onClose={() => setScriptOpen(false)}
        />
      )}
      {propertiesOpen && (
        <DatabasePropertiesDialog
          connectionId={connection.id}
          database={database}
          onClose={() => setPropertiesOpen(false)}
        />
      )}
      <ActionMenu
        label={t('Database actions for {name}', { name: database })}
        actions={[
          { label: t('Database properties'), run: () => setPropertiesOpen(true) },
          { label: t('Query'), run: () => onQuery(database) },
          {
            label: t('Execute SQL file'),
            disabled: connection.engine === 'sybase',
            run: () => setScriptOpen(true),
          },
          ...(['sqlite', 'mysql', 'postgres', 'sqlserver'].includes(connection.engine)
            ? [{ label: t('Export SQL file'), run: () => setExportOpen(true) }]
            : []),
        ]}
      >
        <Button
          variant="outline"
          className={`tree-branch ${selected?.database === database ? 'selected' : ''}`}
          title={database}
          aria-label={`${t('Database')} ${database}`}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            if (!open || selected?.database !== database) void onScope(database).catch(onError);
          }}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'} ▤</span>
          <span>{label}</span>
        </Button>
      </ActionMenu>
      {open && (
        <div className="tree-children">
          {error ? (
            <Alert className="notice" role="alert">
              {error}
            </Alert>
          ) : connection.engine === 'sybase' ? (
            !owners ? (
              <p className="muted">{t('Loading…')}</p>
            ) : owners.length === 0 ? (
              <p className="navigation-empty">{t('No objects found.')}</p>
            ) : (
              owners.map((owner) => (
                <OwnerNode
                  key={owner}
                  owner={owner}
                  connection={connection}
                  database={database}
                  selected={selected}
                  search={search}
                  refresh={refresh}
                  onScope={onScope}
                  onOpen={onOpen}
                  onObject={onObject}
                  onError={onError}
                />
              ))
            )
          ) : !tables ? (
            <p className="muted">{t('Loading…')}</p>
          ) : (
            (['table', 'view'] as const).map((kind) => (
              <ObjectGroup
                key={kind}
                schema={selected?.database === database ? selected.schema : undefined}
                kind={kind}
                connection={connection}
                database={database}
                tables={tables.filter((table) => table.kind === kind)}
                showSchema={new Set(tables.map((table) => table.schema)).size > 1}
                search={search}
                onError={onError}
                onOpen={(table, structure) => {
                  void onScope(database, table.schema).catch(onError);
                  onOpen(database, table, structure);
                }}
              />
            ))
          )}
          {connection.engine !== 'sybase' && (
            <>
              <MetadataGroup
                key={`index:${scriptRevision}`}
                kind="index"
                refresh={refresh}
                schema={selected?.database === database ? selected.schema : undefined}
                connectionId={connection.id}
                database={database}
                search={search}
                onOpen={(object) => onObject(database, object)}
              />
              <MetadataGroup
                key={`trigger:${scriptRevision}`}
                kind="trigger"
                refresh={refresh}
                schema={selected?.database === database ? selected.schema : undefined}
                connectionId={connection.id}
                database={database}
                search={search}
                onOpen={(object) => onObject(database, object)}
              />
            </>
          )}
          <Button
            variant="outline"
            className="tree-branch"
            aria-label={`${t('Query')} ${database}`}
            onClick={() => onQuery(database)}
          >
            <span aria-hidden="true">⌘</span>
            <span>{t('Query')}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
// ASE 11.x uses object owners; keep their identity separate from the table name.
function OwnerNode({
  owner,
  connection,
  database,
  selected,
  search,
  refresh,
  onScope,
  onOpen,
  onObject,
  onError,
}: {
  owner: string;
  connection: Connection;
  database: string;
  selected?: { database: string; schema: string };
  search: string;
  refresh: number;
  onScope: (database: string, schema?: string) => Promise<void>;
  onOpen: (database: string, table: TableInfo, structure?: boolean) => void;
  onObject: (database: string, object: DatabaseObject) => void;
  onError: (error: unknown) => void;
}) {
  const t = useI18n();
  const active = selected?.database === database && selected.schema === owner;
  const [open, setOpen] = useState(active);
  const [tables, setTables] = useState<TableInfo[]>();
  const [error, setError] = useState('');
  const expanded = open || !!search;
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    setError('');
    command<TableInfo[]>('table.list', { connectionId: connection.id, database, schema: owner })
      .then((value) => {
        if (current) setTables(value.filter((table) => table.schema === owner));
      })
      .catch((error: Error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
  }, [expanded, connection.id, database, owner, refresh]);
  return (
    <div className="owner-node" data-owner={owner}>
      <Button
        size="default"
        variant="outline"
        className={`tree-branch ${active ? 'selected' : ''}`}
        title={t('Owner {name}', { name: owner })}
        aria-label={t('Owner {name}', { name: owner })}
        aria-expanded={expanded}
        onClick={() => {
          setOpen(!open);
          if (!expanded || !active) void onScope(database, owner).catch(onError);
        }}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'} ◇</span>
        <span>{owner}</span>
      </Button>
      {expanded && (
        <div className="tree-children">
          {error ? (
            <Alert className="notice" role="alert">
              {error}
            </Alert>
          ) : !tables ? (
            <p className="muted">{t('Loading…')}</p>
          ) : (
            (['table', 'view'] as const).map((kind) => (
              <ObjectGroup
                key={kind}
                schema={owner}
                kind={kind}
                connection={connection}
                database={database}
                tables={tables.filter((table) => table.kind === kind)}
                showSchema={false}
                search={search}
                onError={onError}
                onOpen={(table, structure) => {
                  void onScope(database, owner).catch(onError);
                  onOpen(database, table, structure);
                }}
              />
            ))
          )}
          {(['index', 'trigger'] as const).map((kind) => (
            <MetadataGroup
              key={kind}
              readOnly
              kind={kind}
              schema={owner}
              owner={owner}
              refresh={refresh}
              connectionId={connection.id}
              database={database}
              search={search}
              onOpen={(object) => {
                void onScope(database, owner).catch(onError);
                onObject(database, object);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ObjectGroup({
  kind,
  schema,
  connection,
  database,
  tables,
  showSchema,
  search,
  onOpen,
  onError,
}: {
  kind: 'table' | 'view';
  schema?: string;
  connection: Connection;
  database: string;
  tables: TableInfo[];
  showSchema: boolean;
  search: string;
  onOpen: (table: TableInfo, structure?: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const t = useI18n();
  const [open, setOpen] = useState(kind === 'table');
  const label = kind === 'table' ? 'Table' : 'View';
  const visible = tables.filter((table) =>
    `${table.schema}.${table.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  const expanded = open || !!search;
  return (
    <div className="object-group" data-kind={kind}>
      <div className="object-group-heading">
        <ActionMenu
          label={t('Object group actions')}
          actions={[
            {
              label: t(`Create ${kind}`),
              disabled: connection.engine === 'sybase',
              run: () => {
                void command('app.open_create_object', {
                  connectionId: connection.id,
                  database,
                  schema,
                  kind,
                }).catch((e) => onError(e));
              },
            },
          ]}
        >
          <Button
            variant="outline"
            className="tree-branch"
            aria-label={t(label)}
            aria-expanded={expanded}
            onClick={() => setOpen(!open)}
          >
            <span aria-hidden="true">
              {expanded ? '▾' : '▸'} {kind === 'table' ? '▤' : '◈'}
            </span>
            <span>{t(label)}</span>
            <small className="muted">{visible.length}</small>
          </Button>
        </ActionMenu>
        <Button
          size="icon-sm"
          variant="ghost"
          className="create-object-entry"
          aria-label={t(`Create ${kind}`)}
          title={t(`Create ${kind}`)}
          disabled={connection.engine === 'sybase'}
          onClick={() =>
            void command('app.open_create_object', {
              connectionId: connection.id,
              database,
              schema,
              kind,
            }).catch((e) => onError(e))
          }
        >
          ＋
        </Button>
      </div>
      {expanded && (
        <div className="tree-children">
          {!visible.length && <p className="navigation-empty">{t('No objects found.')}</p>}
          {visible.map((table) => (
            <ExplorerTable
              key={`${table.schema}.${table.name}`}
              connectionId={connection.id}
              readOnly={connection.engine === 'sybase'}
              database={database}
              table={table}
              displayName={
                showSchema && table.schema ? `${table.schema}.${table.name}` : table.name
              }
              onError={onError}
              onOpen={(structure) => onOpen(table, structure)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MetadataGroup({
  owner,
  readOnly = false,
  kind,
  schema,
  connectionId,
  database,
  search,
  onOpen,
  refresh = 0,
}: {
  refresh?: number;
  readOnly?: boolean;
  owner?: string;
  kind: 'index' | 'trigger';
  schema?: string;
  connectionId: string;
  database: string;
  search: string;
  onOpen: (object: DatabaseObject) => void;
}) {
  const t = useI18n();
  const [deleting, setDeleting] = useState<DatabaseObject>();
  const [renaming, setRenaming] = useState<DatabaseObject>();
  const [open, setOpen] = useState(false);
  const [objects, setObjects] = useState<DatabaseObject[]>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const expanded = open || !!search;
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setError('');
    command<DatabaseObject[]>(`${kind}.list`, { connectionId, database })
      .then((value) => {
        if (!cancelled) setObjects(value);
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, kind, connectionId, database, revision, refresh]);
  const label = kind === 'index' ? 'Index' : 'Trigger';
  const visible = objects?.filter(
    (item) =>
      (owner === undefined || item.schema === owner) &&
      `${item.schema}.${item.table}.${item.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="object-group" data-kind={kind}>
      {renaming && (
        <RenameObjectDialog
          target={{
            connectionId,
            database,
            schema: renaming.schema,
            table: renaming.table,
            objectName: renaming.name,
            kind,
          }}
          onClose={() => setRenaming(undefined)}
        />
      )}
      {deleting && (
        <DropObjectDialog
          target={{
            connectionId,
            database,
            schema: deleting.schema,
            table: deleting.table,
            objectName: deleting.name,
            kind,
          }}
          onClose={() => setDeleting(undefined)}
        />
      )}
      <div className="object-group-heading">
        <ActionMenu
          label={t('Object group actions')}
          actions={[
            {
              label: t(`Create ${kind}`),
              disabled: readOnly,
              run: () => {
                void command('app.open_create_object', {
                  connectionId: connectionId,
                  database,
                  schema,
                  kind,
                }).catch((e) => setError(e.message));
              },
            },
          ]}
        >
          <Button
            variant="outline"
            className="tree-branch"
            aria-label={t(label)}
            aria-expanded={expanded}
            onClick={() => setOpen(!open)}
          >
            <span aria-hidden="true">
              {expanded ? '▾' : '▸'} {kind === 'index' ? '⋕' : 'ϟ'}
            </span>
            <span>{t(label)}</span>
            <small className="muted">{visible?.length ?? ''}</small>
          </Button>
        </ActionMenu>
        <Button
          size="icon-sm"
          variant="ghost"
          className="create-object-entry"
          aria-label={t(`Create ${kind}`)}
          title={t(`Create ${kind}`)}
          disabled={readOnly}
          onClick={() =>
            void command('app.open_create_object', {
              connectionId: connectionId,
              database,
              schema,
              kind,
            }).catch((e) => setError(e.message))
          }
        >
          ＋
        </Button>
      </div>
      {expanded && (
        <div className="tree-children">
          {error ? (
            <Alert className="notice" role="alert">
              {error}
            </Alert>
          ) : !visible ? (
            <p className="muted">{t('Loading…')}</p>
          ) : !visible.length ? (
            <p className="navigation-empty">{t('No objects found.')}</p>
          ) : (
            visible.map((item) => (
              <ActionMenu
                key={`${item.schema}.${item.table}.${item.name}`}
                label={t('Object actions for {name}', { name: item.name })}
                actions={[
                  { label: t('Edit definition'), run: () => onOpen(item) },
                  { label: t(`Rename ${kind}`), disabled: readOnly, run: () => setRenaming(item) },
                  { label: t(`Delete ${kind}`), disabled: readOnly, run: () => setDeleting(item) },
                  {
                    label: t('Copy full name'),
                    run: () =>
                      void navigator.clipboard
                        .writeText([item.schema, item.name].filter(Boolean).join('.'))
                        .catch((e) => setError(e.message)),
                  },
                  { label: t('Refresh objects'), run: () => setRevision((value) => value + 1) },
                ]}
              >
                <Button
                  variant="outline"
                  className="table-node metadata-object"
                  title={`${item.schema}.${item.table}.${item.name}`}
                  onDoubleClick={() => onOpen(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onOpen(item);
                    }
                  }}
                >
                  <span aria-hidden="true">{kind === 'index' ? '⋕' : 'ϟ'}</span>
                  <span className="object-name">{item.name}</span>
                </Button>
              </ActionMenu>
            ))
          )}
        </div>
      )}
    </div>
  );
}
