// Real renderer components with a deterministic IPC-boundary test double. No database access.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DatabaseExplorer } from '../../src/renderer/src/components/DatabaseExplorer';
import { LanguageContext } from '../../src/renderer/src/i18n';
import '../../src/renderer/src/styles.css';
import '../../src/renderer/src/theme.css';
import '../../src/renderer/src/design-system.css';

const options = new URLSearchParams(location.search);
const engine = options.get('engine') || 'sybase';
const language = options.get('language') || 'en';
const theme = options.get('theme') || 'light';
document.documentElement.lang = language;
document.documentElement.dataset.theme = theme;
document.documentElement.classList.toggle('dark', theme === 'dark');
const connection = { id: 'fixture', name: 'Owner fixture', engine, database: 'sample' };
const owners = ['dbo', 'reporting', 'empty'];
const table = (schema, name, kind = 'table') => ({ schema, name, kind });
const objects = owners
  .slice(0, 2)
  .flatMap((schema) => [table(schema, 'orders'), table(schema, 'v_orders', 'view')]);
const metadata = (type) =>
  owners.slice(0, 2).map((schema) => ({
    schema,
    name: type === 'index' ? 'orders_idx' : 'orders_trigger',
    table: 'orders',
    type,
  }));
window.treeTest = { calls: [], opened: [], scopes: [], errors: [], failOwner: '', extra: false };
window.desktop = {
  subscribe: () => () => {},
  command: async (name, args) => {
    window.treeTest.calls.push({ name, args });
    switch (name) {
      case 'database.list':
        return { success: true, data: ['sample'] };
      case 'schema.list':
        return { success: true, data: owners };
      case 'table.list':
        if (window.treeTest.failOwner === args.schema)
          return { success: false, error: 'Fixture catalog unavailable' };
        return {
          success: true,
          data: [...objects, ...(window.treeTest.extra ? [table('dbo', 'new_orders')] : [])].filter(
            (item) => item.schema === args.schema,
          ),
        };
      case 'index.list':
        return { success: true, data: metadata('index') };
      case 'trigger.list':
        return { success: true, data: metadata('trigger') };
      default:
        return { success: false, error: `Unexpected fixture command: ${name}` };
    }
  },
};
function Fixture() {
  const [scope, setScope] = useState();
  const [refresh, setRefresh] = useState(0);
  window.treeTest.refresh = () => setRefresh((value) => value + 1);
  return (
    <LanguageContext.Provider value={language}>
      <aside className="sidebar" style={{ width: 360, height: '100vh', overflow: 'auto' }}>
        <DatabaseExplorer
          connection={connection}
          scope={scope}
          refresh={refresh}
          onScope={async (database, schema = 'dbo') => {
            window.treeTest.scopes.push({ database, schema });
            setScope({ database, schema });
          }}
          onOpen={(database, item, structure) =>
            window.treeTest.opened.push({ database, ...item, structure })
          }
          onObject={(database, item) => window.treeTest.opened.push({ database, ...item })}
          onQuery={() => {}}
          onNewFile={() => {}}
          onError={(error) => window.treeTest.errors.push(String(error))}
        />
      </aside>
    </LanguageContext.Provider>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
