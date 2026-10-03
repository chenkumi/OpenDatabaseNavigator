import { Alert } from './ui/alert';
import { confirmAction } from './ConfirmDialog';
import { Button } from './ui/button';
import { TableDesigner } from './TableDesigner';
import { ViewDesigner } from './ViewDesigner';
import { StructureNotice } from './StructureNotice';
import { useEffect, useRef, useState } from 'react';
import type {
  StructureChange,
  StructurePlan,
  TableStructure,
  WorkspaceTab,
} from '../../../shared/types';
import { command } from '../api';
import { useI18n } from '../i18n';

export function StructureEditor({
  tab,
  onApplied,
  onBusy,
}: {
  tab: WorkspaceTab;
  onApplied: (value: TableStructure) => void;
  onBusy: (busy: boolean) => void;
}) {
  const t = useI18n();
  const previewArea = useRef<HTMLElement>(null);
  const [detail, setDetail] = useState<TableStructure>();
  const [change, setChange] = useState<StructureChange | undefined>(() => {
    try {
      return tab.objectVersion ? JSON.parse(tab.sql) : undefined;
    } catch {
      return undefined;
    }
  });
  const [version, setVersion] = useState(tab.objectVersion ?? '');
  const [plan, setPlan] = useState<StructurePlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const args = {
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
    table: tab.table,
  };
  const persist = (next?: StructureChange, base = version) =>
    command('workspace.update', {
      id: tab.id,
      patch: {
        sql: next ? JSON.stringify(next) : '',
        objectVersion: next ? base : '',
        dirty: !!next,
      },
    });
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await command<TableStructure>('structure.describe', args);
      setDetail(result);
      if (!change) setVersion(result.version);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [tab.id]);
  const edit = (next?: StructureChange) => {
    const base = change ? version : detail!.version;
    setVersion(base);
    setChange(next);
    setPlan(undefined);
    setError('');
    setMessage('');
    void persist(next, base).catch((e) => setError(e.message));
  };
  const discard = async () => {
    if (change && !(await confirmAction(t('Discard unsaved changes?')))) return false;
    await persist();
    setChange(undefined);
    setPlan(undefined);
    setError('');
    setMessage('');
    return true;
  };
  const preview = async () => {
    setBusy(true);
    setError('');
    try {
      setPlan(await command<StructurePlan>('structure.preview', { ...args, change }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const current = await command<TableStructure>('structure.apply', {
        ...args,
        change,
        version,
      });
      setDetail(current);
      setVersion(current.version);
      setChange(undefined);
      setPlan(undefined);
      await persist();
      onApplied(current);
      setMessage('Changes applied.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  useEffect(() => {
    if (plan) {
      previewArea.current?.scrollIntoView({ block: 'nearest' });
      previewArea.current?.focus();
    }
  }, [plan]);
  return (
    <section
      className="structure structure-editor"
      aria-label={t('Structure editor')}
      aria-busy={busy}
    >
      <div className="toolbar designer-toolbar">
        <strong>
          {detail?.kind === 'view' ? t('View definition') : t('Design table')} · {tab.table}
        </strong>
        <span className="spacer" />
        <StructureNotice change={change} detail={detail} error={error} message={message} />
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (await discard()) await load();
            })().catch((e) => setError(e.message))
          }
        >
          {t('Refresh structure')}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !change}
          onClick={() => void discard().catch((e) => setError(e.message))}
        >
          {t('Revert changes')}
        </Button>
        <Button
          variant="default"
          className="primary"
          disabled={busy || !change || !!detail?.readOnlyReason}
          onClick={() => void preview()}
        >
          {t('Preview changes')}
        </Button>
      </div>
      {!detail && busy && <p>{t('Loading…')}</p>}
      {detail && (
        <>
          {detail.kind === 'table' ? (
            <TableDesigner
              connectionId={tab.connectionId}
              database={tab.database}
              detail={detail}
              change={change}
              disabled={busy || !!detail.readOnlyReason}
              onChange={edit}
            />
          ) : (
            <ViewDesigner
              id={tab.id}
              detail={detail}
              change={change}
              disabled={busy || !!detail.readOnlyReason}
              onChange={edit}
            />
          )}
          {plan && (
            <section
              ref={previewArea}
              tabIndex={-1}
              className="object-change-preview"
              aria-label={t('SQL preview')}
            >
              <h3>{t('SQL preview')}</h3>
              <p>
                {t(
                  detail?.engine === 'sybase'
                    ? 'ASE support is experimental. Multi-statement DDL requires the database ddl in tran option.'
                    : plan.atomic
                      ? 'Changes run in one transaction.'
                      : 'This database commits DDL implicitly; review the SQL before applying.',
                )}
              </p>
              {plan.rebuildTable && (
                <Alert role="status" className="notice">
                  {t(
                    'SQLite will rebuild the table and copy its data, then restore indexes and triggers. Foreign keys are checked before commit.',
                  )}
                </Alert>
              )}
              {plan.notice && <Alert role="status">{t(plan.notice)}</Alert>}
              {plan.destructive && (
                <Alert role="status" className="notice">
                  {t(
                    'This change can remove data or alter its meaning. Review it before applying.',
                  )}
                </Alert>
              )}
              <pre>{plan.statements.map((s) => s.trim().replace(/;$/, '') + ';').join('\n\n')}</pre>
              {plan.recoveryStatements && (
                <>
                  <h4>{t('Original definition (recovery SQL)')}</h4>
                  <pre>{plan.recoveryStatements.map((sql) => sql + ';').join('\n\n')}</pre>
                </>
              )}
              <Button
                variant="default"
                className="primary"
                disabled={busy}
                onClick={() => void apply()}
              >
                {t('Apply changes')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setPlan(undefined)}>
                {t('Cancel')}
              </Button>
            </section>
          )}
        </>
      )}
    </section>
  );
}
