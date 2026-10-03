import { Alert } from './ui/alert';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { useRef, useState } from 'react';

import type { DropObjectRef } from '../../../shared/drop-object';
import type { RenameObjectPlan } from '../../../shared/rename-object';
import { command } from '../api';
import { useI18n } from '../i18n';

export function RenameObjectDialog({
  target,
  onClose,
}: {
  target: DropObjectRef;
  onClose: () => void;
}) {
  const t = useI18n();
  const [name, setName] = useState(target.objectName);
  const [plan, setPlan] = useState<RenameObjectPlan>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const perform = async (apply: boolean) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      if (apply) {
        await command('object.rename', { ...target, newName: name, version: plan!.version });
        onClose();
      } else
        setPlan(
          await command<RenameObjectPlan>('object.rename_preview', { ...target, newName: name }),
        );
    } catch (error) {
      setError((error as Error).message);
      setPlan(undefined);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="modal"

        aria-label={t(`Rename ${target.kind}`)}
      >
        <header>
          <DialogTitle>{t(`Rename ${target.kind}`)}</DialogTitle>
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            aria-label={t('Close')}
            onClick={onClose}
          >
            ✕
          </Button>
        </header>
        <p>
          <strong>
            {target.database} · {target.schema}.{target.objectName}
          </strong>
        </p>
        <Label className="database-name-field">
          {t('New name')}
          <Input
            autoFocus
            maxLength={128}
            disabled={busy}
            value={name}
            onFocus={(event) => event.target.select()}
            onChange={(event) => {
              setName(event.target.value);
              setPlan(undefined);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && name.trim() && name !== target.objectName) {
                event.preventDefault();
                void perform(false);
              }
            }}
          />
        </Label>
        <p className="muted">
          {t(
            'Related clean tabs will reopen with the new name. Save or close unsaved tabs first. SQL query text is not rewritten.',
          )}
        </p>
        {plan && (
          <>
            <Alert role="status" className="notice">
              {t(plan.notice)}
            </Alert>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                maxHeight: '30vh',
                overflow: 'auto',
              }}
            >
              {plan.statements.join(';\n')};
            </pre>
            {!!plan.tabs.length && (
              <Collapsible className="disclosure">
                <CollapsibleTrigger className="disclosure-trigger">
                  {t('Affected tabs')} ({plan.tabs.length})
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
              <Alert className="notice" role="alert">
                {t('Unsaved changes: save or close related tabs before renaming.')}
              </Alert>
            )}
          </>
        )}
        {error && (
          <Alert className="notice" role="alert">
            {t(error)}
          </Alert>
        )}
        <footer>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !name.trim() || name === target.objectName}
            onClick={() => void perform(false)}
          >
            {t('Preview SQL')}
          </Button>
          <Button
            variant="default"
            className="primary"
            disabled={busy || !plan || plan.tabs.some((tab) => tab.dirty)}
            onClick={() => void perform(true)}
          >
            {busy ? t('Working…') : t('Rename object')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
