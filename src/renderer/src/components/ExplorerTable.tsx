import { Button } from './ui/button';
import { DropObjectDialog } from './DropObjectDialog';
import { RenameObjectDialog } from './RenameObjectDialog';
import { ActionMenu } from './ActionMenu';
import { useState } from 'react';
import { useI18n } from '../i18n';
import type { Column, TableInfo } from '../../../shared/types';
import { command } from '../api';
export function ExplorerTable({
  connectionId,
  database,
  table,
  displayName = table.name,
  onOpen,
  onError,
}: {
  connectionId: string;
  database?: string;
  table: TableInfo;
  displayName?: string;
  onOpen: (structure?: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const t = useI18n();
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [open, setOpen] = useState(false);
  const [columns, setColumns] = useState<Column[]>([]);
  const expand = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setColumns(
      await command<Column[]>('table.describe', {
        connectionId,
        database,
        schema: table.schema,
        table: table.name,
      }),
    );
    setOpen(true);
  };
  return (
    <div>
      {renaming && (
        <RenameObjectDialog
          target={{
            connectionId,
            database,
            schema: table.schema,
            objectName: table.name,
            table: table.name,
            kind: table.kind,
          }}
          onClose={() => setRenaming(false)}
        />
      )}
      {deleting && (
        <DropObjectDialog
          target={{
            connectionId,
            database,
            schema: table.schema,
            objectName: table.name,
            table: table.name,
            kind: table.kind,
          }}
          onClose={() => setDeleting(false)}
        />
      )}
      <div className="explorer-table-row">
        <Button
          variant="ghost"
          size="icon-sm"
          className="expand-columns"
          aria-label={t('Columns of {name}', { name: displayName })}
          onClick={() => void expand().catch(onError)}
        >
          {open ? '▾' : '▸'}
        </Button>
        <ActionMenu
          label={t('Object actions for {name}', { name: displayName })}
          actions={[
            { label: t(`Rename ${table.kind}`), run: () => setRenaming(true) },
            { label: t(`Delete ${table.kind}`), run: () => setDeleting(true) },
            { label: t('Open data'), run: () => onOpen(false) },
            {
              label: t(table.kind === 'view' ? 'Design view' : 'Design table'),
              run: () => onOpen(true),
            },
            {
              label: t('Copy full name'),
              run: () =>
                void navigator.clipboard
                  .writeText([table.schema, table.name].filter(Boolean).join('.'))
                  .catch(onError),
            },
            {
              label: t('Refresh columns'),
              run: () =>
                void command<Column[]>('table.describe', {
                  connectionId,
                  database,
                  schema: table.schema,
                  table: table.name,
                })
                  .then((value) => {
                    setColumns(value);
                    setOpen(true);
                  })
                  .catch(onError),
            },
          ]}
        >
          <Button
            variant="outline"
            className="table-node"
            onDoubleClick={() => onOpen(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onOpen(false);
              }
            }}
          >
            <span>{table.kind === 'view' ? '◈' : '▤'}</span>
            <span className="object-name" title={`${table.schema}.${table.name}`}>
              {displayName}
            </span>
          </Button>
        </ActionMenu>
      </div>
      {open && (
        <ul className="column-tree">
          {columns.map((column) => (
            <li key={column.name} title={`${column.type}${column.nullable ? '' : ' NOT NULL'}`}>
              <span>
                {column.primaryKey ? '◆' : '·'} {column.name}
              </span>
              <small>{column.type}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
