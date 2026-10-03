import { Alert } from './ui/alert';
import { confirmAction } from './ConfirmDialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { useEffect, useState } from 'react';
import type {
  DatabaseObjectDefinition,
  DatabaseObjectPlan,
  WorkspaceTab,
} from '../../../shared/types';
import { command } from '../api';
import { useI18n } from '../i18n';
import { IndexOptionsForm } from './IndexOptionsForm';
import type { IndexOptions } from '../../../shared/index-options';
export function DatabaseObjectView({ tab }: { tab: WorkspaceTab }) {
  const t = useI18n();
  const [object, setObject] = useState<DatabaseObjectDefinition>();
  const [indexChange, setIndexChange] = useState<IndexOptions | undefined>(() => {
    if (tab.type === 'index' && tab.objectVersion)
      try {
        return JSON.parse(tab.sql).indexOptions;
      } catch {}
    return undefined;
  });
  const [sql, setSql] = useState(tab.sql);
  const [version, setVersion] = useState(tab.objectVersion ?? '');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(true);
  const [plan, setPlan] = useState<DatabaseObjectPlan>();
  const [revision, setRevision] = useState(0);
  const ref = {
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema ?? '',
    table: tab.table ?? '',
    objectName: tab.objectName,
    kind: tab.type,
  };
  const dirty =
    !!object && (!!indexChange || sql !== object.editableSql || version !== object.version);
  const persist = (value: string, base: string, changed: boolean) =>
    command('workspace.update', {
      id: tab.id,
      patch: { sql: changed ? value : '', objectVersion: changed ? base : '', dirty: changed },
    });
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError('');
    command<DatabaseObjectDefinition>('object.describe', ref)
      .then((current) => {
        if (cancelled) return;
        setObject(current);
        if (!tab.objectVersion || revision > 0) {
          setSql(current.editableSql);
          setVersion(current.version);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab.id, revision]);
  const change = (value: string) => {
    setSql(value);
    setPlan(undefined);
    setMessage('');
    void persist(
      value,
      version,
      value !== object?.editableSql || version !== object?.version,
    ).catch((e) => setError(e.message));
  };
  const refresh = async () => {
    if (dirty && !(await confirmAction(t('Discard unsaved changes?')))) return;
    await persist('', '', false);
    setIndexChange(undefined);
    setPlan(undefined);
    setMessage('');
    setObject(undefined);
    setRevision((v) => v + 1);
  };
  const preview = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setPlan(
        await command<DatabaseObjectPlan>('object.preview', {
          ...ref,
          ...(indexChange ? { indexOptions: indexChange } : { sql }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const current = await command<DatabaseObjectDefinition>('object.apply', {
        ...ref,
        ...(indexChange ? { indexOptions: indexChange } : { sql }),
        version,
      });
      setObject(current);
      setIndexChange(undefined);
      setSql(current.editableSql);
      setVersion(current.version);
      setPlan(undefined);
      await persist('', '', false);
      setMessage(t('Changes applied.'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="database-object-view" aria-busy={busy}>
      <div className="toolbar">
        <strong>
          {t(tab.type === 'index' ? 'Index' : 'Trigger')}: {tab.objectName}
        </strong>
        <span className="spacer" />
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void refresh().catch((e) => setError(e.message))}
        >
          {t('Refresh')}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !dirty}
          onClick={async () => {
            if (await confirmAction(t('Discard unsaved changes?'))) {
              setSql(object!.editableSql);
              setIndexChange(undefined);
              setError('');
              setMessage('');
              setVersion(object!.version);
              setPlan(undefined);
              void persist('', '', false).catch((e) => setError(e.message));
            }
          }}
        >
          {t('Revert changes')}
        </Button>
        <Button
          variant="default"
          className="primary"
          disabled={busy || !dirty || !!object?.readOnlyReason}
          onClick={() => void preview()}
        >
          {t('Preview changes')}
        </Button>
      </div>
      <div className="database-object-content">
        {busy && <p className="muted">{t('Loading…')}</p>}
        {error && (
          <Alert className="notice" role="alert">
            {t(error)}
          </Alert>
        )}
        {message && <p role="status">{message}</p>}
        {object && (
          <>
            <dl>
              <dt>{t('Database')}</dt>
              <dd>{tab.database}</dd>
              <dt>{t('Table')}</dt>
              <dd>{[object.schema, object.table].filter(Boolean).join('.')}</dd>
            </dl>
            <p className="muted">{t(object.notice)}</p>
            {object.readOnlyReason && (
              <Alert role="status" className="notice">
                {t(object.readOnlyReason)}
              </Alert>
            )}
            <Tabs defaultValue={indexChange ? 'options' : 'definition'} className="object-designer">
              <TabsList className="designer-tabs" aria-label={t('Object design sections')}>
                <TabsTrigger value="definition">{t('Definition')}</TabsTrigger>
                {object.indexCapabilities && object.indexOptions && (
                  <TabsTrigger value="options">{t('Index options')}</TabsTrigger>
                )}
                <TabsTrigger value="original">{t('Original definition')}</TabsTrigger>
              </TabsList>
              <TabsContent value="options" className="designer-section">
                {object.indexCapabilities && object.indexOptions && (
                  <IndexOptionsForm
                    capabilities={object.indexCapabilities}
                    value={{ ...object.indexOptions, ...indexChange }}
                    disabled={
                      busy ||
                      !!object.readOnlyReason ||
                      (!indexChange && sql !== object.editableSql)
                    }
                    onChange={(next) => {
                      const patch = Object.fromEntries(
                        Object.entries(next).filter(
                          ([key, value]) =>
                            value !== object.indexOptions?.[key as keyof IndexOptions],
                        ),
                      ) as IndexOptions;
                      const value = Object.keys(patch).length ? patch : undefined;
                      setIndexChange(value);
                      setSql(object.editableSql);
                      setPlan(undefined);
                      setError('');
                      setMessage('');
                      void persist(
                        value ? JSON.stringify({ indexOptions: value }) : '',
                        version,
                        !!value || version !== object.version,
                      ).catch((e) => setError(e.message));
                    }}
                  />
                )}
                {object.indexCapabilities && (
                  <small>
                    {t(
                      'Apply or revert pending changes before switching between SQL and index options.',
                    )}
                  </small>
                )}
              </TabsContent>
              <TabsContent value="definition" className="designer-section">
                <Label className="object-definition-label" htmlFor={`definition-${tab.id}`}>
                  {t('SQL definition')}
                </Label>
                <Textarea
                  id={`definition-${tab.id}`}
                  className="object-definition-editor"
                  spellCheck={false}
                  value={indexChange ? object.editableSql : sql}
                  readOnly={busy || !!object.readOnlyReason || !!indexChange}
                  onChange={(e) => change(e.target.value)}
                />
              </TabsContent>
              <TabsContent value="original" className="designer-section">
                <pre>
                  {object.editableSql ||
                    object.definition ||
                    t('Definition unavailable or generated by the database.')}
                </pre>
              </TabsContent>
            </Tabs>
            {plan && (
              <section className="object-change-preview" aria-label={t('SQL preview')}>
                <h3>{t('SQL preview')}</h3>
                <p>{t(plan.notice)}</p>
                <pre>
                  {plan.statements
                    .map((statement) => statement.trim().replace(/;$/, '') + ';')
                    .join('\n\n')}
                </pre>
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
      </div>
    </section>
  );
}
