import { Button } from './ui/button';
import { useRef, useState } from 'react';
import type { Settings, WorkspaceTab } from '../../../shared/types';
import { command } from '../api';
import { useI18n } from '../i18n';
import { SqlEditor, type SqlEditorHandle } from './SqlEditor';
import { ResultGrid } from './ResultGrid';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './ui/resizable';

export function QueryView({
  tab,
  settings,
  busy,
  onRun,
  onStop,
  onError,
}: {
  tab: WorkspaceTab;
  settings: Settings;
  busy: boolean;
  onRun: (sql: string) => void;
  onStop: () => void;
  onError: (error: unknown) => void;
}) {
  const t = useI18n();
  const editor = useRef<SqlEditorHandle>(null);
  const [selection, setSelection] = useState(false);
  const [canRun, setCanRun] = useState(!!tab.sql.trim());
  const [layout] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem('query-layout') ?? 'null');
      return value &&
        Number.isFinite(value.editor) &&
        Number.isFinite(value.results) &&
        value.editor >= 10 &&
        value.results >= 10
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  });
  return (
    <div className="query-view">
      <div className="toolbar">
        <small>{t('Ctrl / ⌘ + Enter executes selection')}</small>
        <small>{t('One SQL statement per run')}</small>
        <span className="spacer" />
        <Button variant="outline" disabled={!busy} onClick={onStop}>
          {t('Stop')}
        </Button>
        <Button
          variant="default"
          className="primary"
          disabled={busy || !canRun}
          onClick={() => editor.current?.execute()}
        >
          {t(selection ? '▶ Run selection' : '▶ Run SQL')}
        </Button>
      </div>
      <ResizablePanelGroup
        orientation="vertical"
        className="query-panels"
        defaultLayout={layout}
        onLayoutChanged={(value) => {
          try {
            localStorage.setItem('query-layout', JSON.stringify(value));
          } catch {
            /* Optional preference. */
          }
        }}
      >
        <ResizablePanel id="editor" defaultSize="45%" minSize={100}>
          <SqlEditor
            ref={editor}
            sql={tab.sql}
            connectionId={tab.connectionId}
            database={tab.database}
            schema={tab.schema}
            settings={settings}
            onSelectionChange={setSelection}
            onCanRunChange={setCanRun}
            onChange={(sql) => {
              if (sql !== tab.sql)
                void command('workspace.update', { id: tab.id, patch: { sql } }).catch(onError);
            }}
            onRun={onRun}
          />
        </ResizablePanel>
        <ResizableHandle aria-label={t('Resize SQL editor and results')} />
        <ResizablePanel id="results" defaultSize="55%" minSize={200}>
          <div className="query-results">
            <div className="result-heading">{t('RESULTS')}</div>
            {tab.result ? (
              <>
                <ResultGrid result={tab.result} pageKey={tab.result} />
                {tab.result.nextCursor && (
                  <div className="toolbar">
                    <span className="muted">
                      {t('Live results · Use ORDER BY for consistent paging')}
                    </span>
                    <span className="spacer" />
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void command('query.next', {
                          connectionId: tab.connectionId,
                          cursor: tab.result!.nextCursor,
                        }).catch(onError)
                      }
                    >
                      {t('Next result page →')}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="empty-small">{t('Run a query to see results here.')}</div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
