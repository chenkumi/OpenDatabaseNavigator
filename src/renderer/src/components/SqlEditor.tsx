import { useEffect, useRef, useState, useImperativeHandle, type Ref } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import type { Settings } from '../../../shared/types';
import { command } from '../api';
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
monaco.editor.defineTheme('workspace-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'B993F5' },
    { token: 'string', foreground: 'D7C78B' },
    { token: 'number', foreground: '81C9CF' },
  ],
  colors: {
    'editor.background': '#111619',
    'editor.foreground': '#E4E9EE',
    'editorLineNumber.foreground': '#64727D',
    'editorLineNumber.activeForeground': '#61B0FF',
    'editor.lineHighlightBackground': '#182126',
    'editor.selectionBackground': '#21466A',
    'editorCursor.foreground': '#61B0FF',
  },
});
// One schema scan per scope, shared by every query tab and reused for a minute,
// instead of describing up to 100 tables again each time a tab mounts.
const completionCache = new Map<string, { at: number; names: Promise<string[]> }>();
function completionNames(connectionId: string, database?: string, schema?: string) {
  const key = JSON.stringify([connectionId, database, schema]);
  const cached = completionCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.names;
  const names = (async () => {
    const tables = await command<any[]>('table.list', { connectionId, database, schema });
    const found = new Set<string>(tables.map((table) => table.name));
    const batch = 6;
    for (const table of tables.slice(0, 100).reduce<any[][]>((groups, item, index) => {
      (groups[Math.floor(index / batch)] ??= []).push(item);
      return groups;
    }, []))
      for (const columns of await Promise.all(
        table.map((item) =>
          command<any[]>('table.describe', {
            connectionId,
            database,
            schema: item.schema,
            table: item.name,
          }).catch(() => []),
        ),
      ))
        for (const column of columns) found.add(column.name);
    return [...found];
  })();
  completionCache.set(key, { at: Date.now(), names });
  names.catch(() => completionCache.delete(key));
  return names;
}
export interface SqlEditorHandle {
  execute: () => void;
}
export function SqlEditor({
  ref,
  onSelectionChange,
  onCanRunChange,
  sql,
  connectionId,
  database,
  schema,
  settings,
  onChange,
  onRun,
}: {
  ref?: Ref<SqlEditorHandle>;
  onSelectionChange?: (selected: boolean) => void;
  onCanRunChange?: (canRun: boolean) => void;
  sql: string;
  connectionId: string;
  database?: string;
  schema?: string;
  settings: Settings;
  onChange: (value: string) => void;
  onRun: (sql: string) => void;
}) {
  // The editor owns the text while typing. Workspace updates echo our own earlier
  // values back asynchronously; applying those would overwrite newer keystrokes.
  // Only a value we never sent (for example an agent edit) replaces the text.
  const [text, setText] = useState(sql);
  const sent = useRef<string[]>([]);
  useEffect(() => {
    if (sent.current.includes(sql)) {
      if (sql === sent.current.at(-1)) sent.current = [];
      return;
    }
    sent.current = [];
    setText(sql);
  }, [sql]);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystemDark(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const run = useRef(onRun);
  run.current = onRun;
  const selectionChanged = useRef(onSelectionChange);
  const canRunChanged = useRef(onCanRunChange);
  selectionChanged.current = onSelectionChange;
  canRunChanged.current = onCanRunChange;
  const executionText = () => {
    const current = editor.current;
    const selection = current?.getSelection();
    return selection && !selection.isEmpty()
      ? current!.getModel()!.getValueInRange(selection)
      : (current?.getValue() ?? '');
  };
  const execute = () => {
    const text = executionText();
    if (text.trim()) run.current(text);
  };
  useImperativeHandle(ref, () => ({ execute }));
  useEffect(() => {
    let disposed = false;
    let registration: monaco.IDisposable | undefined;
    completionNames(connectionId, database, schema)
      .then((names) => {
        if (disposed) return;
        registration = monaco.languages.registerCompletionItemProvider('sql', {
          triggerCharacters: ['.'],
          provideCompletionItems(model, position) {
            if (model !== editor.current?.getModel()) return { suggestions: [] };
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            return {
              suggestions: [
                ...names.map((name) => ({
                  label: name,
                  insertText: name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  range,
                })),
                ...[
                  'SELECT',
                  'FROM',
                  'WHERE',
                  'JOIN',
                  'LEFT JOIN',
                  'GROUP BY',
                  'ORDER BY',
                  'INSERT INTO',
                  'UPDATE',
                  'DELETE FROM',
                  'LIMIT',
                  'COUNT',
                  'AS',
                  'AND',
                  'OR',
                  'IS NULL',
                ].map((name) => ({
                  label: name,
                  insertText: name,
                  kind: monaco.languages.CompletionItemKind.Keyword,
                  range,
                })),
              ],
            };
          },
        });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      registration?.dispose();
    };
  }, [connectionId, database, schema]);
  const mount: OnMount = (instance) => {
    editor.current = instance;
    const update = () => {
      selectionChanged.current?.(!instance.getSelection()?.isEmpty());
      canRunChanged.current?.(!!executionText().trim());
    };
    instance.onDidChangeCursorSelection(update);
    instance.onDidChangeModelContent(update);
    update();
    instance.addAction({
      id: 'execute-query',
      label: 'Execute selection or query',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: execute,
    });
  };
  return (
    <Editor
      height="100%"
      language="sql"
      value={text}
      theme={
        settings.theme === 'light' || (settings.theme === 'system' && !systemDark)
          ? 'vs'
          : 'workspace-dark'
      }
      onMount={mount}
      onChange={(value) => {
        const next = value ?? '';
        setText(next);
        sent.current = [...sent.current.slice(-49), next];
        onChange(next);
      }}
      options={{
        minimap: { enabled: false },
        fontSize: settings.fontSize,
        tabSize: settings.tabSize,
        wordWrap: settings.wordWrap ? 'on' : 'off',
        automaticLayout: true,
        padding: { top: 16 },
        scrollBeyondLastLine: false,
      }}
    />
  );
}
