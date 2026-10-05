// Real TableView with controlled SELECT completion; no database or credentials.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TableView } from '../../src/renderer/src/components/TableView';
import { LanguageContext } from '../../src/renderer/src/i18n';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import '../../src/renderer/src/styles.css';
import '../../src/renderer/src/theme.css';
import '../../src/renderer/src/design-system.css';

const options = new URLSearchParams(location.search);
const language = options.get('language') || 'en';
const theme = options.get('theme') || 'light';
document.documentElement.lang = language;
document.documentElement.dataset.theme = theme;
document.documentElement.classList.toggle('dark', theme === 'dark');
const pending = [];
const listeners = new Set();
window.loadingTest = {
  calls: [],
  release(empty = false, fail = false) {
    const request = pending.shift();
    if (!request) throw new Error('No pending SELECT');
    request.resolve(
      fail
        ? { success: false, error: 'Fixture read failed' }
        : {
            success: true,
            data: {
              success: true,
              columns: ['id'],
              rows: empty ? [] : [{ id: '1' }, { id: '2' }],
              rowCount: empty ? 0 : 2,
              affectedRows: 0,
              duration: 1000,
              hasMore: !empty,
            },
          },
    );
  },
  changed() {
    for (const listener of listeners)
      listener({
        type: 'RowUpdated',
        payload: {
          connectionId: 'fixture',
          database: 'sample',
          schema: 'dbo',
          table: 'items',
        },
      });
  },
  get pending() {
    return pending.length;
  },
};
window.desktop = {
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async command(name, args) {
    window.loadingTest.calls.push({ name, args });
    if (name === 'data.select') return new Promise((resolve) => pending.push({ resolve }));
    if (name === 'table.describe')
      return {
        success: true,
        data: [
          { name: 'id', type: 'integer', nullable: false, defaultValue: null, primaryKey: true },
        ],
      };
    return { success: true, data: undefined };
  },
};
const tab = {
  id: 'table-fixture',
  type: 'table',
  title: 'items',
  table: 'items',
  connectionId: 'fixture',
  database: 'sample',
  schema: 'dbo',
  sql: '',
  dirty: false,
  selectedRows: [],
};
function Fixture() {
  const [error, setError] = useState('');
  return (
    <LanguageContext.Provider value={language}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', minWidth: 0 }}>
        {error && <div role="alert">{error}</div>}
        <TableView
          tab={tab}
          settings={{ ...DEFAULT_SETTINGS, language, theme, pageSize: 2 }}
          readOnly
          onError={(error) => setError(error.message)}
        />
      </div>
    </LanguageContext.Provider>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
