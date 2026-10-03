import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useI18n } from '../i18n';
import { cellText, prettyJson } from '../../../shared/result-format';
import { command } from '../api';

export function CellValueDialog({
  column,
  value,
  onClose,
}: {
  column: string;
  value: unknown;
  onClose: () => void;
}) {
  const t = useI18n();
  const raw = cellText(value);
  const formatted = prettyJson(raw);
  const [pretty, setPretty] = useState(formatted !== undefined);
  const [message, setMessage] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="modal cell-value-dialog" showCloseButton={false}>
        <DialogTitle>
          {t('Cell value')} · {column}
        </DialogTitle>
        <div className="toolbar">
          <span className="muted">
            {value === null ? 'NULL' : t('{count} characters', { count: raw.length })}
          </span>
          <span className="spacer" />
          {formatted !== undefined && (
            <Button variant="outline" onClick={() => setPretty(!pretty)}>
              {t(pretty ? 'Raw text' : 'Format JSON')}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => {
              void command('clipboard.result.copy', { content: raw })
                .then(() => setMessage(t('Copied')))
                .catch(() => setMessage(t('Could not copy. Select the text and copy manually.')));
            }}
          >
            {t('Copy value')}
          </Button>
        </div>
        <Textarea
          aria-label={t('Full cell value')}
          className="cell-value-text"
          readOnly
          value={pretty ? formatted! : raw}
        />
        <footer className="toolbar">
          <span role="status">{message}</span>
          <span className="spacer" />
          <Button variant="outline" onClick={onClose}>
            {t('Close')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
