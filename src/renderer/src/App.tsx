import { Badge } from './components/ui/badge';
import { Alert } from './components/ui/alert';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs';
import { confirmAction, ConfirmDialog } from './components/ConfirmDialog';
import { TAB_DRAG_TYPE, reorderTabs } from './tab-order';
const LOG_PAGE = 100;
import { Button } from './components/ui/button';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from './components/ui/context-menu';
import { Input } from './components/ui/input';
import { CreateObjectView } from './components/CreateObjectView';
import { ConnectionMenu } from './components/ConnectionMenu';
import { DatabaseObjectView } from './components/DatabaseObjectView';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './components/ui/resizable';
import { LanguageContext, translator } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Approval,
  AuditEntry,
  Connection,
  Settings,
  TableInfo,
  Workspace,
  WorkspaceTab,
} from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { command } from './api';
import { ConnectionForm } from './components/ConnectionForm';
import { SettingsPanel } from './components/SettingsPanel';
import { QueryView } from './components/QueryView';
import { WorkspaceScope, scopeLabel } from './components/WorkspaceScope';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { TableView } from './components/TableView';
import { RedisExplorer } from './components/RedisExplorer';
import { RedisView } from './components/RedisView';
import { DatabaseExplorer } from './components/DatabaseExplorer';
export function App() {
  type ConnectionStatus = { connected: boolean; connecting: boolean; disconnecting?: boolean };
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  const statusRevision = useRef(0);
  const openingConnections = useRef(new Set<string>());
  const connectionPanel = useRef<PanelImperativeHandle>(null);
  const [navigationLayout] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem('navigation-layout') ?? 'null');
      return value &&
        ['connections', 'explorer', 'workspace'].every(
          (key) => Number.isFinite(value[key]) && value[key] >= 0,
        ) &&
        value.explorer > 0 &&
        value.workspace > 0
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  });
  const [connectionsCollapsed, setConnectionsCollapsed] = useState(false);
  const [tableRequests, setTableRequests] = useState<
    Record<string, { structure: boolean; revision: number }>
  >({});
  const querySubmissions = useRef(new Set<string>());
  const [connections, setConnections] = useState<Connection[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>({ tabs: [] });
  // A tab that has been connected keeps its view (and unsaved drafts) mounted
  // through a transient connection loss instead of falling back to the prompt.
  const everConnected = useRef(new Set<string>());
  useEffect(() => {
    const tabIds = new Set(workspace.tabs.map((tab) => tab.id));
    for (const id of everConnected.current) if (!tabIds.has(id)) everConnected.current.delete(id);
    for (const tab of workspace.tabs)
      if (statuses[tab.connectionId]?.connected) everConnected.current.add(tab.id);
  }, [statuses, workspace.tabs]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const t = translator(settings.language);
  const [selected, setSelected] = useState('');
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const scopeLoads = useRef<Record<string, number>>({});
  const [scopes, setScopes] = useState<
    Record<string, { database: string; schema: string; databases: string[]; schemas: string[] }>
  >({});
  const [search, setSearch] = useState('');
  const [explorerRevision, setExplorerRevision] = useState(0);
  const [form, setForm] = useState<Connection | 'new'>();
  const [showSettings, setShowSettings] = useState(false);
  const [panel, setPanel] = useState<'workspace' | 'history' | 'activity'>('workspace');
  const [entries, setEntries] = useState<any[]>([]);
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  const [logSearch, setLogSearch] = useState('');
  const [error, setError] = useState('');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [mcp, setMcp] = useState({ running: false, agents: 0 });
  const [running, setRunning] = useState<
    Record<string, { tabId?: string; actor: { name: string } }>
  >({});
  const onError = useCallback(
    (error: unknown) => setError(error instanceof Error ? error.message : String(error)),
    [],
  );
  const refreshConnections = async () => {
    const revision = ++statusRevision.current;
    const [list, state] = await Promise.all([
      command<Connection[]>('connection.list'),
      command<Record<string, ConnectionStatus>>('connection.statuses'),
    ]);
    if (revision !== statusRevision.current) return;
    setConnections(list);
    setStatuses(state);
  };
  const openRedis = async (connectionId: string, database: string) => {
    const existing = workspace.tabs.find(
      (tab) =>
        tab.type === 'redis' &&
        tab.connectionId === connectionId &&
        (tab.database || '0') === database,
    );
    if (existing) await command('workspace.activate', { id: existing.id });
    else await command('app.open_redis', { connectionId, database });
    setPanel('workspace');
  };
  const clearExplorer = (id: string) => {
    scopeLoads.current[id] = (scopeLoads.current[id] ?? 0) + 1;
    setTables((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    setScopes((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  };
  const workspaceRevision = useRef(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const applyWorkspace = (value: Workspace) => {
    workspaceRevision.current++;
    setWorkspace(value);
  };
  /**
   * Change events leave out a result that has not changed. Reuse the previous
   * object (which also keeps its identity stable for the grid); if the version
   * moved but no result came, our copy is stale, so read the full state.
   */
  const applyWorkspaceEvent = (value: Workspace) => {
    let stale = false;
    const previous = new Map(workspaceRef.current.tabs.map((tab) => [tab.id, tab]));
    const tabs = value.tabs.map((tab) => {
      if (tab.result) return tab;
      const old = previous.get(tab.id);
      if (old?.result && (old.resultVersion ?? 0) === (tab.resultVersion ?? 0))
        return { ...tab, result: old.result };
      if (old?.result) stale = true;
      return tab;
    });
    applyWorkspace({ ...value, tabs });
    if (stale) void refreshWorkspace().catch(onError);
  };
  const refreshWorkspace = () => {
    const revision = workspaceRevision.current;
    // A newer event snapshot must not be overwritten by a slower state read.
    return command<Workspace>('app.get_state').then((value) => {
      if (revision === workspaceRevision.current) applyWorkspace(value);
    });
  };
  useEffect(() => {
    if (workspace.activeConnection) setSelected(workspace.activeConnection);
  }, [workspace.activeConnection]);
  useEffect(() => {
    void Promise.all([
      refreshConnections(),
      refreshWorkspace(),
      command<Settings>('settings.get').then(setSettings),
      command('mcp.status').then(setMcp),
      command<Approval[]>('approval.list').then(setApprovals),
    ]).catch(onError);
    return window.desktop.subscribe((event) => {
      if (['WorkspaceChanged', 'TabCreated', 'TableOpened'].includes(event.type))
        applyWorkspaceEvent(event.payload as Workspace);
      if (
        [
          'DatabaseObjectCreated',
          'DatabaseObjectDropped',
          'DatabaseObjectRenamed',
          'DatabaseObjectChanged',
          'TableStructureChanged',
        ].includes(event.type)
      )
        setExplorerRevision((value) => value + 1);
      if (event.type === 'TabCreated') {
        const state = event.payload as Workspace;
        if (state.tabs.find((tab) => tab.id === state.activeTab)?.type === 'create')
          setPanel('workspace');
      }
      if (event.type === 'DesktopAction') {
        if (event.payload === 'create-connection') {
          setShowSettings(false);
          setForm('new');
        }
        if (event.payload === 'settings') {
          setForm(undefined);
          setShowSettings(true);
        }
      }
      if (event.type === 'ConnectionChanged') {
        const payload = event.payload as ConnectionStatus & { connectionId: string };
        if (typeof payload.connected === 'boolean') {
          setStatuses((previous) => ({ ...previous, [payload.connectionId]: payload }));
          if (!payload.connected && !payload.connecting) clearExplorer(payload.connectionId);
        }
        void refreshConnections().catch(onError);
      }
      if (event.type === 'SettingsChanged')
        void command<Settings>('settings.get').then(setSettings).catch(onError);
      if (event.type === 'McpStatusChanged') setMcp(event.payload as typeof mcp);
      if (event.type === 'ApprovalRequested' || event.type === 'ApprovalResolved')
        void command<Approval[]>('approval.list').then(setApprovals).catch(onError);
      if (event.type === 'QueryStarted') {
        const payload = event.payload as any;
        setRunning((previous) => ({ ...previous, [payload.id]: payload }));
      }
      if (event.type === 'QueryFinished')
        setRunning((previous) => {
          const next = { ...previous };
          delete next[(event.payload as any).id];
          return next;
        });
    });
  }, [onError]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () =>
      document.documentElement.classList.toggle(
        'dark',
        settings.theme === 'dark' || (settings.theme === 'system' && media.matches),
      );
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [settings.theme]);
  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);
  useEffect(() => {
    if (panel === 'workspace') return;
    // Debounce typing and drop answers to superseded searches.
    let current = true;
    setLogLimit(LOG_PAGE);
    const timer = setTimeout(() => {
      void command<any[]>(panel === 'history' ? 'history.list' : 'audit.list', {
        search: logSearch,
      })
        .then((value) => {
          if (current) setEntries(value);
        })
        .catch(onError);
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [panel, logSearch, onError]);
  const connect = async (connection: Connection) => {
    setSelected(connection.id);
    if (openingConnections.current.has(connection.id) || statuses[connection.id]?.disconnecting)
      return;
    openingConnections.current.add(connection.id);
    try {
      await command('connection.connect', { connectionId: connection.id });
      if (connection.engine === 'redis') {
        const existing = workspace.tabs.find(
          (tab) => tab.connectionId === connection.id && tab.type === 'redis',
        );
        if (existing) await command('workspace.activate', { id: existing.id });
        else await command('app.open_redis', { connectionId: connection.id });
        setPanel('workspace');
        return;
      }
      await changeScope(
        connection,
        scopes[connection.id]?.database ?? connection.database,
        scopes[connection.id]?.schema,
      );
      setExplorerRevision((value) => value + 1);
    } finally {
      openingConnections.current.delete(connection.id);
    }
  };
  const disconnect = async (connection: Connection, reconnect = false) => {
    const dirty = workspace.tabs.some((tab) => tab.connectionId === connection.id && tab.dirty);
    if (
      dirty &&
      !(await confirmAction(
        t('Disconnect and close all related tabs? Unsaved changes will be discarded.'),
      ))
    )
      return;
    await command('connection.disconnect', { connectionId: connection.id, discard: dirty });
    clearExplorer(connection.id);
    setSelected(connection.id);
    if (reconnect) await connect(connection);
  };
  const changeScope = async (connection: Connection, database: string, schema?: string) => {
    const request = (scopeLoads.current[connection.id] ?? 0) + 1;
    scopeLoads.current[connection.id] = request;
    setScopes((previous) => ({
      ...previous,
      [connection.id]: {
        database,
        schema: schema ?? '',
        databases: previous[connection.id]?.databases ?? [],
        schemas: [],
      },
    }));
    const databases =
      connection.engine === 'sqlite'
        ? [connection.database]
        : await command<string[]>('database.list', { connectionId: connection.id });
    if (scopeLoads.current[connection.id] !== request) return;
    if (!database) {
      if (scopeLoads.current[connection.id] !== request) return;
      setScopes((previous) => ({
        ...previous,
        [connection.id]: { database: '', schema: '', databases, schemas: [] },
      }));
      setTables((previous) => ({ ...previous, [connection.id]: [] }));
      return;
    }
    const schemas = await command<string[]>('schema.list', {
      connectionId: connection.id,
      database,
    });
    if (scopeLoads.current[connection.id] !== request) return;
    const chosenSchema =
      schema && schemas.includes(schema)
        ? schema
        : schemas.includes('public')
          ? 'public'
          : schemas.includes('dbo')
            ? 'dbo'
            : schemas.includes(database)
              ? database
              : (schemas[0] ?? '');
    const metadata = await command<TableInfo[]>('table.list', {
      connectionId: connection.id,
      database,
      schema: chosenSchema,
    });
    if (scopeLoads.current[connection.id] !== request) return;
    setScopes((previous) => ({
      ...previous,
      [connection.id]: { database, schema: chosenSchema, databases, schemas },
    }));
    setTables((previous) => ({ ...previous, [connection.id]: metadata }));
  };
  const openQuery = async (
    connectionId: string,
    sql = '',
    database = scopes[connectionId]?.database,
  ) => {
    await command('app.open_query', {
      connectionId,
      sql,
      database: database || undefined,
      schema: scopes[connectionId]?.schema,
    });
    setPanel('workspace');
  };
  const runQuery = async (tab: WorkspaceTab, sql: string) => {
    if (!statuses[tab.connectionId]?.connected) throw new Error(t('Double-click to connect'));
    if (
      !sql.trim() ||
      querySubmissions.current.has(tab.id) ||
      Object.values(running).some((query) => query.tabId === tab.id)
    )
      return;
    querySubmissions.current.add(tab.id);
    try {
      await command('query.execute', {
        connectionId: tab.connectionId,
        database: tab.database,
        sql,
        tabId: tab.id,
        showInApp: true,
      });
    } finally {
      querySubmissions.current.delete(tab.id);
    }
  };
  const closeTab = async (tab: WorkspaceTab, others = false) => {
    const dirty = others
      ? workspace.tabs.some((item) => item.id !== tab.id && item.dirty)
      : tab.dirty;
    if (!dirty || (await confirmAction(t('Discard unsaved changes?'))))
      await command('workspace.close', { id: tab.id, others, discard: dirty });
  };
  const groups = [...new Set(connections.map((connection) => connection.group))];
  const activeConnection = connections.find(
    (connection) => connection.id === (selected || workspace.activeConnection),
  );
  const pending = approvals.filter((approval) => approval.status === 'pending');
  // Resolving takes a round trip; ignore repeat clicks so one request cannot be resolved twice.
  const [resolving, setResolving] = useState(false);
  const approvalPanel = useRef<HTMLDivElement>(null);
  const resolveApproval = (approve: boolean, mode?: 'session') => {
    const request = pending[0];
    if (!request || resolving) return;
    setResolving(true);
    void command<any>('approval.resolve', { id: request.id, approve, mode })
      .then((result) => {
        if (approve && !result.success) throw new Error(result.error);
      })
      .catch(onError)
      .finally(() => setResolving(false));
  };
  // Move focus to a new request so keyboard and screen reader users notice it.
  useEffect(() => {
    if (pending[0]) approvalPanel.current?.focus();
  }, [pending[0]?.id]);
  return (
    <LanguageContext.Provider value={settings.language}>
      <ConfirmDialog />
      <div className="app-shell">
        <header className="app-header">
          <div className="app-identity">
            <Button
              size="icon"
              variant="ghost"
              aria-label={t(connectionsCollapsed ? 'Show connections' : 'Hide connections')}
              aria-expanded={!connectionsCollapsed}
              onClick={() =>
                connectionsCollapsed
                  ? connectionPanel.current?.expand()
                  : connectionPanel.current?.collapse()
              }
            >
              ☰
            </Button>
            <span className="database-symbol" aria-hidden="true">
              ▤
            </span>
            <strong>Database Workspace</strong>
          </div>
          <div className="header-actions">
            <Button
              variant="outline"
              className={panel === 'history' ? 'active' : ''}
              onClick={() => setPanel('history')}
            >
              {t('◷ History')}
            </Button>
            <Button
              variant="outline"
              className={panel === 'activity' ? 'active' : ''}
              onClick={() => setPanel('activity')}
            >
              {t('◎ Agent activity')}
              {pending.length ? ` (${pending.length})` : ''}
            </Button>
            <Button variant="outline" onClick={() => setShowSettings(true)}>
              {t('⚙ Settings')}
            </Button>
          </div>
        </header>
        <ResizablePanelGroup
          orientation="horizontal"
          className="app-body app-panels"
          defaultLayout={navigationLayout}
          onLayoutChanged={(layout) => {
            setConnectionsCollapsed(layout.connections === 0);
            try {
              localStorage.setItem('navigation-layout', JSON.stringify(layout));
            } catch {
              /* Optional preference. */
            }
          }}
        >
          <ResizablePanel
            id="connections"
            panelRef={connectionPanel}
            collapsible
            collapsedSize={0}
            onResize={() =>
              setConnectionsCollapsed(connectionPanel.current?.isCollapsed() ?? false)
            }
            defaultSize="16%"
            minSize={150}
          >
            <aside className="sidebar">
              <div className="navigation-heading">
                <span>▱ {t('Connections')}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('New connection')}
                  onClick={() => setForm('new')}
                >
                  ＋
                </Button>
              </div>
              <Input
                className="search"
                placeholder={t('Search connections…')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="connection-list">
                {groups.map((group) => (
                  <section key={group}>
                    <h4 title={group || t('Ungrouped')}>{group || t('Ungrouped')}</h4>
                    {connections
                      .filter(
                        (connection) =>
                          connection.group === group &&
                          `${connection.name} ${connection.engine}`
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                      )
                      .sort((a, b) => Number(b.favorite) - Number(a.favorite))
                      .map((connection) => (
                        <div key={connection.id}>
                          <div
                            className={`connection ${selected === connection.id ? 'selected' : ''}`}
                          >
                            <Button
                              variant="outline"
                              className="connection-main"
                              onClick={() => setSelected(connection.id)}
                              onDoubleClick={() => void connect(connection).catch(onError)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  void connect(connection).catch(onError);
                                }
                              }}
                              data-connection-id={connection.id}
                              data-state={
                                statuses[connection.id]?.disconnecting
                                  ? 'disconnecting'
                                  : statuses[connection.id]?.connecting
                                    ? 'connecting'
                                    : statuses[connection.id]?.connected
                                      ? 'connected'
                                      : 'disconnected'
                              }
                            >
                              <span
                                className="connection-dot"
                                role="img"
                                data-state={
                                  statuses[connection.id]?.connected
                                    ? 'connected'
                                    : statuses[connection.id]?.connecting
                                      ? 'connecting'
                                      : 'disconnected'
                                }
                                aria-label={t(
                                  statuses[connection.id]?.connected
                                    ? 'Connected'
                                    : statuses[connection.id]?.connecting
                                      ? 'Connecting…'
                                      : 'Disconnected',
                                )}
                              />
                              <span>
                                <strong title={connection.name}>
                                  {connection.favorite ? '★ ' : ''}
                                  {connection.name}
                                </strong>
                                <small>
                                  {connection.engine} ·{' '}
                                  {connection.engine === 'sybase' && <>{t('Read-only')} · </>}
                                  {t(
                                    statuses[connection.id]?.disconnecting
                                      ? 'Disconnecting…'
                                      : statuses[connection.id]?.connecting
                                        ? 'Connecting…'
                                        : statuses[connection.id]?.connected
                                          ? 'Connected'
                                          : 'Double-click to connect',
                                  )}
                                </small>
                              </span>
                            </Button>
                            <ConnectionMenu
                              name={connection.name}
                              connected={!!statuses[connection.id]?.connected}
                              busy={
                                !!statuses[connection.id]?.connecting ||
                                !!statuses[connection.id]?.disconnecting
                              }
                              onReconnect={() =>
                                void (
                                  statuses[connection.id]?.connected
                                    ? disconnect(connection, true)
                                    : connect(connection)
                                ).catch(onError)
                              }
                              onDisconnect={() => void disconnect(connection).catch(onError)}
                              onDelete={async () => {
                                const dirty = workspace.tabs.some(
                                  (tab) => tab.connectionId === connection.id && tab.dirty,
                                );
                                if (
                                  await confirmAction(
                                    t(
                                      dirty
                                        ? 'Delete connection “{name}” and discard unsaved changes in its tabs?'
                                        : 'Delete connection “{name}”?',
                                      { name: connection.name },
                                    ),
                                  )
                                )
                                  void command('connection.delete', {
                                    connectionId: connection.id,
                                    discard: dirty,
                                  }).catch(onError);
                              }}
                              onSettings={() => setForm(connection)}
                            />
                          </div>
                        </div>
                      ))}
                  </section>
                ))}
              </div>
            </aside>
          </ResizablePanel>
          <ResizableHandle withHandle aria-label={t('Resize connections')} />
          <ResizablePanel id="explorer" defaultSize="20%" minSize={180}>
            <aside className="database-sidebar" aria-label={t('Database Explorer')}>
              {activeConnection &&
              statuses[activeConnection.id]?.connected &&
              activeConnection.engine !== 'redis' ? (
                <DatabaseExplorer
                  key={activeConnection.id}
                  refresh={explorerRevision}
                  connection={activeConnection}
                  scope={
                    scopes[activeConnection.id] ?? {
                      database:
                        workspace.tabs.find(
                          (tab) =>
                            tab.id === workspace.activeTab &&
                            tab.connectionId === activeConnection.id,
                        )?.database ?? activeConnection.database,
                      schema:
                        workspace.tabs.find(
                          (tab) =>
                            tab.id === workspace.activeTab &&
                            tab.connectionId === activeConnection.id,
                        )?.schema ?? '',
                    }
                  }
                  onScope={(database, schema) => changeScope(activeConnection, database, schema)}
                  onError={onError}
                  onNewFile={() => setForm('new')}
                  onObject={(database, object) =>
                    void command('app.open_object', {
                      connectionId: activeConnection.id,
                      database,
                      schema: object.schema,
                      table: object.table,
                      objectName: object.name,
                      type: object.kind,
                    })
                      .then(() => setPanel('workspace'))
                      .catch(onError)
                  }
                  onQuery={(database) =>
                    void command('app.open_query', {
                      connectionId: activeConnection.id,
                      database,
                      sql: '',
                    })
                      .then(() => setPanel('workspace'))
                      .catch(onError)
                  }
                  onOpen={(database, table, structure = false) => {
                    const existing = workspace.tabs.find(
                      (tab) =>
                        tab.type === 'table' &&
                        tab.connectionId === activeConnection.id &&
                        tab.database === database &&
                        tab.schema === table.schema &&
                        tab.table === table.name,
                    );
                    const open = existing
                      ? command('workspace.activate', { id: existing.id }).then(() => existing)
                      : command<WorkspaceTab>('app.open_table', {
                          connectionId: activeConnection.id,
                          database,
                          schema: table.schema,
                          table: table.name,
                        });
                    void open
                      .then((opened) => {
                        setPanel('workspace');
                        setTableRequests((previous) => ({
                          ...previous,
                          [opened.id]: {
                            structure,
                            revision: (previous[opened.id]?.revision ?? 0) + 1,
                          },
                        }));
                      })
                      .catch(onError);
                  }}
                />
              ) : activeConnection?.engine === 'redis' &&
                statuses[activeConnection.id]?.connected ? (
                <RedisExplorer
                  key={activeConnection.id}
                  connectionId={activeConnection.id}
                  selected={
                    workspace.tabs.find(
                      (tab) =>
                        tab.id === workspace.activeTab && tab.connectionId === activeConnection.id,
                    )?.database
                  }
                  onOpen={(database) =>
                    void openRedis(activeConnection.id, database).catch(onError)
                  }
                />
              ) : (
                <>
                  <div className="navigation-heading">▤ {t('Database Explorer')}</div>
                  <p className="navigation-empty">
                    {t('Connect a database to explore its tables.')}
                  </p>
                </>
              )}
            </aside>
          </ResizablePanel>
          <ResizableHandle withHandle aria-label={t('Resize database explorer')} />
          <ResizablePanel id="workspace" defaultSize="64%" minSize={320}>
            <main className="workspace">
              {panel !== 'workspace' && (
                <div className="log-panel">
                  <div className="toolbar">
                    <h1 className="panel-title">
                      {panel === 'history' ? t('Query history') : t('Agent activity')}
                    </h1>
                    <Button variant="outline" onClick={() => setPanel('workspace')}>
                      {t('← Workspace')}
                    </Button>
                    <Input
                      placeholder={t('Search…')}
                      value={logSearch}
                      onChange={(event) => setLogSearch(event.target.value)}
                    />
                    <Button
                      variant="outline"
                      onClick={() =>
                        void command<any[]>(panel === 'history' ? 'history.list' : 'audit.list', {
                          search: logSearch,
                        })
                          .then(setEntries)
                          .catch(onError)
                      }
                    >
                      {t('Refresh')}
                    </Button>
                  </div>
                  {entries.slice(0, logLimit).map((entry) => (
                    <article className="log-entry" key={entry.id}>
                      <div>
                        <Badge className="badge">
                          {entry.command || (entry.success ? t('SUCCESS') : t('ERROR'))}
                        </Badge>
                        <time>
                          {new Date(entry.timestamp || entry.executedAt).toLocaleString()}
                        </time>
                        <span>{entry.actor?.name}</span>
                        <span>{Math.round(entry.duration)} ms</span>
                      </div>
                      <pre>{entry.sql || entry.summary}</pre>
                      {entry.result && <p>{entry.result}</p>}
                      {entry.sql && (
                        <div className="inline">
                          <Button
                            variant="outline"
                            onClick={() =>
                              void navigator.clipboard.writeText(entry.sql).catch(onError)
                            }
                          >
                            {t('Copy')}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() =>
                              void openQuery(entry.connectionId, entry.sql, entry.database).catch(
                                onError,
                              )
                            }
                          >
                            {t('Open in editor')}
                          </Button>
                          <Button
                            variant="outline"
                            disabled={entry.sql.includes('[REDACTED]')}
                            onClick={() =>
                              void (async () => {
                                // Only plain reads re-run without asking; anything else may change data.
                                if (
                                  (!/^\s*(select|show|explain|describe|desc)\b/i.test(entry.sql) ||
                                    // EXPLAIN ANALYZE runs the statement; SELECT ... INTO writes.
                                    /\b(analyze|into)\b/i.test(entry.sql)) &&
                                  !(await confirmAction(
                                    t('Re-run this statement? It may change or delete data.'),
                                  ))
                                )
                                  return;
                                const tab = await command<WorkspaceTab>('app.open_query', {
                                  connectionId: entry.connectionId,
                                  database: entry.database,
                                  sql: entry.sql,
                                  title: t('History query'),
                                });
                                setPanel('workspace');
                                await runQuery(tab, entry.sql);
                              })().catch(onError)
                            }
                          >
                            {t('Re-run')}
                          </Button>
                        </div>
                      )}
                    </article>
                  ))}
                  {entries.length > logLimit && (
                    <Button
                      variant="outline"
                      onClick={() => setLogLimit((value) => value + LOG_PAGE)}
                    >
                      {t('Show more')} ({entries.length - logLimit})
                    </Button>
                  )}
                </div>
              )}
              <Tabs
                value={workspace.activeTab ?? null}
                onValueChange={(id) => {
                  if (id) void command('workspace.activate', { id }).catch(onError);
                }}
                className="workspace-body"
                style={{ display: panel === 'workspace' ? 'flex' : 'none' }}
              >
                <div className="workspace-tabbar">
                  <TabsList variant="line" aria-label={t('Workspace tabs')} className="tab-strip">
                    {workspace.tabs.map((tab) => (
                      <ContextMenu key={tab.id}>
                        <ContextMenuTrigger
                          render={
                            <div
                              draggable
                              onDragStart={(event) =>
                                event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id)
                              }
                              onDragOver={(event) => {
                                // Only accept our own tab drags, never dropped text.
                                if (event.dataTransfer.types.includes(TAB_DRAG_TYPE))
                                  event.preventDefault();
                              }}
                              onDrop={(event) => {
                                const id = event.dataTransfer.getData(TAB_DRAG_TYPE);
                                const ids = reorderTabs(
                                  workspace.tabs.map((item) => item.id),
                                  id,
                                  tab.id,
                                );
                                if (ids) void command('workspace.reorder', { ids }).catch(onError);
                              }}
                              title={scopeLabel(
                                tab,
                                connections.find(
                                  (connection) => connection.id === tab.connectionId,
                                ),
                              )}
                              className={`tab ${workspace.activeTab === tab.id ? 'active' : ''}`}
                            />
                          }
                        >
                          <TabsTrigger value={tab.id}>
                            {tab.type === 'query'
                              ? '⌘'
                              : tab.type === 'index'
                                ? '⋕'
                                : tab.type === 'trigger'
                                  ? 'ϟ'
                                  : '▤'}{' '}
                            {tab.type === 'create' && !tab.objectVersion ? t(tab.title) : tab.title}
                            {workspace.tabs.some(
                              (other) =>
                                other.id !== tab.id &&
                                other.title === tab.title &&
                                (other.connectionId !== tab.connectionId ||
                                  other.database !== tab.database ||
                                  other.schema !== tab.schema),
                            ) && (
                              <small>
                                {' '}
                                ·{' '}
                                {scopeLabel(
                                  { ...tab, table: undefined, objectName: undefined },
                                  connections.find(
                                    (connection) => connection.id === tab.connectionId,
                                  ),
                                  true,
                                )}
                              </small>
                            )}
                            {tab.dirty ? ' •' : ''}
                          </TabsTrigger>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t('Close {name}', { name: tab.title })}
                            onClick={() => void closeTab(tab).catch(onError)}
                          >
                            ×
                          </Button>
                        </ContextMenuTrigger>
                        <ContextMenuContent
                          aria-label={t('Tab actions for {name}', { name: tab.title })}
                        >
                          <ContextMenuItem onClick={() => void closeTab(tab).catch(onError)}>
                            {t('Close')}
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => void closeTab(tab, true).catch(onError)}>
                            {t('Close other tabs')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                  </TabsList>
                  <Button
                    variant="default"
                    className="primary"
                    disabled={!activeConnection || !statuses[activeConnection.id]?.connected}
                    onClick={() =>
                      void (
                        activeConnection!.engine === 'redis'
                          ? openRedis(
                              activeConnection!.id,
                              workspace.tabs.find(
                                (tab) =>
                                  tab.id === workspace.activeTab &&
                                  tab.connectionId === activeConnection!.id,
                              )?.database ||
                                activeConnection!.database ||
                                '0',
                            )
                          : openQuery(activeConnection!.id)
                      ).catch(onError)
                    }
                  >
                    {activeConnection?.engine === 'redis'
                      ? t('＋ Redis workspace')
                      : t('＋ SQL query')}
                  </Button>
                </div>
                {!workspace.tabs.length && (
                  <div className="welcome">
                    <div className="welcome-icon">▦</div>
                    <span className="eyebrow">{t('HUMAN + AGENT')}</span>
                    <h2>{t('A workspace for every question.')}</h2>
                    <p>
                      {t(
                        'Connect a database, explore your tables, and work with your agent in the same place.',
                      )}
                    </p>
                    <Button variant="default" className="primary" onClick={() => setForm('new')}>
                      {t('Create your first connection')}
                    </Button>
                    <div className="welcome-features">
                      <span>{t('SQL editor')}</span>
                      <span>{t('Table browser')}</span>
                      <span>{t('Shared context')}</span>
                    </div>
                  </div>
                )}
                {workspace.tabs.map((tab) => (
                  <TabsContent
                    value={tab.id}
                    keepMounted
                    className="tab-content"
                    key={tab.id}
                    style={{ display: workspace.activeTab === tab.id ? 'flex' : 'none' }}
                  >
                    <WorkspaceScope
                      tab={tab}
                      connection={connections.find(
                        (connection) => connection.id === tab.connectionId,
                      )}
                    />
                    {!statuses[tab.connectionId]?.connected &&
                      everConnected.current.has(tab.id) && (
                        <p className="navigation-empty" role="status">
                          {t(
                            'Connection lost. Double-click the connection to reconnect; unsaved edits are kept.',
                          )}
                        </p>
                      )}
                    <ErrorBoundary>
                      {!statuses[tab.connectionId]?.connected &&
                      !everConnected.current.has(tab.id) ? (
                        <p className="navigation-empty">{t('Double-click to connect')}</p>
                      ) : tab.type === 'create' ? (
                        <CreateObjectView
                          tab={tab}
                          connection={connections.find(
                            (connection) => connection.id === tab.connectionId,
                          )!}
                        />
                      ) : tab.type === 'index' || tab.type === 'trigger' ? (
                        <DatabaseObjectView tab={tab} />
                      ) : tab.type === 'table' ? (
                        <TableView
                          readOnly={
                            connections.find((connection) => connection.id === tab.connectionId)
                              ?.engine === 'sybase'
                          }
                          tab={tab}
                          settings={settings}
                          onError={onError}
                          viewRequest={tableRequests[tab.id]}
                        />
                      ) : tab.type === 'redis' ? (
                        <RedisView tab={tab} onError={onError} />
                      ) : (
                        <QueryView
                          tab={tab}
                          settings={settings}
                          busy={Object.values(running).some((query) => query.tabId === tab.id)}
                          onRun={(sql) => void runQuery(tab, sql).catch(onError)}
                          onError={onError}
                          onStop={() => {
                            for (const [id, query] of Object.entries(running))
                              if (query.tabId === tab.id)
                                void command('query.cancel', { id }).catch(onError);
                          }}
                        />
                      )}
                    </ErrorBoundary>
                  </TabsContent>
                ))}
              </Tabs>
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
        <footer className="status-bar">
          <span>
            <i className={mcp.running ? 'online' : ''} /> MCP{' '}
            {t(mcp.running ? 'enabled' : 'disabled')}
            {mcp.agents ? t(' · {count} agent connected', { count: mcp.agents }) : ''}
          </span>
          <span>
            {Object.values(running)[0]
              ? t('{name} is running a query…', { name: Object.values(running)[0].actor.name })
              : t('Ready')}
          </span>
          <span>
            {t('{count} connections · Credentials stored on this device', {
              count: connections.length,
            })}
          </span>
        </footer>
        {error && (
          <Alert className="toast" role="alert">
            <span>{error}</span>
            <Button
              aria-label={t('Close')}
              size="icon"
              variant="ghost"
              onClick={() => setError('')}
            >
              ✕
            </Button>
          </Alert>
        )}
        {form && (
          <ConnectionForm
            initial={form === 'new' ? undefined : form}
            onClose={() => setForm(undefined)}
            onSaved={() => {
              setForm(undefined);
              void refreshConnections().catch(onError);
            }}
          />
        )}
        {showSettings && (
          <SettingsPanel
            initial={settings}
            onClose={() => setShowSettings(false)}
            onSaved={() => setShowSettings(false)}
          />
        )}
        {pending.length > 0 && (
          <div
            className="approval-panel"
            ref={approvalPanel}
            role="alertdialog"
            aria-labelledby="approval-title"
            aria-describedby="approval-detail"
            tabIndex={-1}
          >
            <span className="eyebrow">{t('AGENT ACTION REQUEST')}</span>
            <h3 id="approval-title">
              {t('{name} requests {risk}', {
                name: pending[0].actor.name,
                risk: t(pending[0].risk),
              })}
            </h3>
            <p id="approval-detail">
              {connections.find((connection) => connection.id === pending[0].connectionId)?.name} ·{' '}
              {pending[0].command}
            </p>
            <pre>{JSON.stringify(pending[0].args, null, 2)}</pre>
            <div className="inline">
              <Button variant="outline" disabled={resolving} onClick={() => resolveApproval(false)}>
                {t('Reject')}
              </Button>
              <Button
                variant="default"
                className="primary"
                disabled={resolving}
                onClick={() => resolveApproval(true)}
              >
                {t('Approve once')}
              </Button>
              {pending[0].risk !== 'destructive' && (
                <Button
                  variant="outline"
                  disabled={resolving}
                  title={t(
                    'Allow this agent to repeat this operation for 10 minutes. Inserts cover the same table; updates, deletes and DDL need identical arguments. Settings or connection changes revoke grants.',
                  )}
                  onClick={() => resolveApproval(true, 'session')}
                >
                  {t('Approve for 10 min')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </LanguageContext.Provider>
  );
}
