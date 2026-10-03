import { Alert } from './ui/alert';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { useEffect, useState } from 'react';

import type { DropObjectPlan, DropObjectRef } from '../../../shared/drop-object';
import { command } from '../api';
import { useI18n } from '../i18n';

export function DropObjectDialog({
  target,
  onClose,
}: {
  target: DropObjectRef;
  onClose: () => void;
}) {
  const t = useI18n();
  const [plan, setPlan] = useState<DropObjectPlan>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const load = async () => {
    setPlan(undefined);
    setError('');
    setDiscard(false);
    try {
      setPlan(await command<DropObjectPlan>('object.drop_preview', target));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="modal drop-object-dialog"

        aria-label={t(`Delete ${target.kind}`)}
      >
        <header>
          <DialogTitle>{t(`Delete ${target.kind}`)}</DialogTitle>
          <Button
            size="icon"
            variant="ghost"
            autoFocus
            disabled={busy}
            onClick={onClose}
            aria-label={t('Close')}
          >
            ✕
          </Button>
        </header>
        <p>
          <strong>
            {target.database} · {target.schema}.{target.objectName}
          </strong>
        </p>
        <p>
          {t(
            target.kind === 'table'
              ? 'This permanently deletes the table and all its rows.'
              : 'This permanently deletes the object.',
          )}
        </p>
        <p className="muted">
          {t(
            'Related object tabs will close. References in views, queries or routines may need updating. Database dependency errors cancel deletion.',
          )}
        </p>
        {target.kind === 'trigger' && plan?.engine === 'postgres' && (
          <p className="muted">
            {t('PostgreSQL trigger functions are retained because they may be shared.')}
          </p>
        )}
        {plan ? (
          <>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {plan.statements.join(';\n')};
            </pre>
            {!!plan.dependents?.length && (
              <Alert className="notice" role="alert">
                {t('Rows in these tables will also be deleted or changed by foreign key actions:')}{' '}
                {plan.dependents.join(', ')}
              </Alert>
            )}
            {!!plan.ownedObjects.length && (
              <Collapsible className="disclosure">
                <CollapsibleTrigger className="disclosure-trigger">
                  {t('Owned objects removed with this object')} ({plan.ownedObjects.length})
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul>
                    {plan.ownedObjects.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
            {!!plan.tabs.length && (
              <Collapsible className="disclosure">
                <CollapsibleTrigger className="disclosure-trigger">
                  {t('Tabs to close')} ({plan.tabs.length})
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul>
                    {plan.tabs.map((tab) => (
                      <li key={tab.id}>
                        {tab.title}
                        {tab.dirty ? ' *' : ''}
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
            {plan.tabs.some((tab) => tab.dirty) && (
              <Label>
                <Checkbox
                  checked={discard}
                  disabled={busy}
                  onCheckedChange={(e) => setDiscard(e)}
                />
                {t('Discard unsaved changes in these tabs')}
              </Label>
            )}
          </>
        ) : (
          !error && <p>{t('Loading…')}</p>
        )}
        {error && (
          <Alert className="notice" role="alert">
            {error}
          </Alert>
        )}
        <footer>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </Button>
          {error && (
            <Button variant="outline" disabled={busy} onClick={() => void load()}>
              {t('Refresh preview')}
            </Button>
          )}
          <Button
            variant="outline"
            className="danger"
            disabled={busy || !plan || (plan.tabs.some((tab) => tab.dirty) && !discard)}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await command('object.drop', { ...target, version: plan!.version, discard });
                onClose();
              } catch (e) {
                setError((e as Error).message);
                setPlan(undefined);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t('Deleting…') : t('Delete object')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
