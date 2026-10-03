import type { Connection, WorkspaceTab } from '../../../shared/types';
import { useI18n } from '../i18n';
import { Fragment } from 'react';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './ui/breadcrumb';

function scopeParts(tab: WorkspaceTab, connection?: Connection, short = false) {
  const database =
    short && connection?.engine === 'sqlite' ? tab.database?.split(/[\\/]/).at(-1) : tab.database;
  // MySQL/MariaDB expose the database as its schema; other engines have distinct levels.
  const schema =
    connection?.engine === 'mysql' && tab.schema === tab.database ? undefined : tab.schema;
  return [connection?.name ?? tab.connectionId, database, schema, tab.table, tab.objectName].filter(
    (part): part is string => Boolean(part),
  );
}
export function scopeLabel(tab: WorkspaceTab, connection?: Connection, short = false) {
  return scopeParts(tab, connection, short).join(' › ');
}
export function WorkspaceScope({
  tab,
  connection,
}: {
  tab: WorkspaceTab;
  connection?: Connection;
}) {
  const t = useI18n();
  return (
    <Breadcrumb
      className="workspace-scope"
      aria-label={t('Workspace scope')}
      title={scopeLabel(tab, connection)}
    >
      <span className="connection-dot" style={{ background: connection?.color }} />
      <BreadcrumbList>
        {scopeParts(tab, connection, true).map((part, index, parts) => (
          <Fragment key={index}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {index === parts.length - 1 ? (
                <BreadcrumbPage>{part}</BreadcrumbPage>
              ) : (
                <span>{part}</span>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
