import { useEffect, useRef, useState } from 'react';
import type { ScriptProgress } from '../../../shared/sql-script';
import { command } from '../api';
import { useI18n } from '../i18n';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Alert } from './ui/alert';

export function SqlScriptDialog({
  connectionId,
  database,
  onClose,
}: {
  connectionId: string;
  database: string;
  onClose: () => void;
}) {
  const t = useI18n();
  const [file, setFile] = useState<{ fileName: string; sql: string }>();
  const [preview, setPreview] = useState<{
    total: number;
    mysqlSqlMode?: string;
    units: { index: number; line: number; sql: string }[];
  }>();
  const [progress, setProgress] = useState<ScriptProgress>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [continueOnError, setContinueOnError] = useState(false);
  const pending = useRef(false),
    runId = useRef<string | undefined>(undefined);
  const running = progress?.state === 'running';
  useEffect(() => {
    return window.desktop.subscribe((event) => {
      if (event.type === 'SqlScriptProgress') {
        const value = event.payload as ScriptProgress;
        if (value.id === runId.current) setProgress(value);
      }
    });
  }, []);
  useEffect(() => {
    if (!running || !progress) return;
    let active = true;
    const timer = setInterval(() => {
      void command<ScriptProgress>('script.status', { id: progress.id })
        .then((value) => {
          if (active) setProgress(value);
        })
        .catch((err) => {
          if (active) setError(err.message);
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [running, progress?.id]);
  const choose = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const selected = await command<{ fileName: string; sql: string } | null>('file.sql.open');
      if (!selected) return;
      setFile(selected);
      setPreview(undefined);
      setProgress(undefined);
      runId.current = undefined;
      setPreview(await command('script.preview', { connectionId, database, ...selected }));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const execute = async () => {
    if (pending.current || !file || !preview) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const id = crypto.randomUUID();
    runId.current = id;
    try {
      await command('script.execute', {
        connectionId,
        database,
        ...file,
        mysqlSqlMode: preview.mysqlSqlMode,
        id,
        continueOnError,
      });
      setProgress(await command<ScriptProgress>('script.status', { id }));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && !running) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="modal sql-script-dialog"
        aria-label={t('Execute SQL file')}
      >
        <header>
          <DialogTitle>{t('Execute SQL file')}</DialogTitle>
          <Button
            size="icon"
            variant="ghost"
            disabled={busy || running}
            aria-label={t('Close')}
            onClick={onClose}
          >
            ✕
          </Button>
        </header>
        <p>
          <strong>{database}</strong>
          {file && ` · ${file.fileName}`}
        </p>
        <p className="muted">
          {t(
            'The file uses one isolated session. Successful statements may already be committed. Uncommitted transactions are rolled back when the session closes.',
          )}
        </p>
        <p className="muted">
          {t(
            'UTF-8 or UTF-16 with BOM, up to 16 MiB. SQL Server/ASE use GO; MySQL supports DELIMITER. Client shell commands and COPY FROM STDIN are not supported.',
          )}
        </p>
        <div className="inline">
          <Button variant="outline" disabled={busy || running} onClick={() => void choose()}>
            {t('Choose SQL file')}
          </Button>
          <Label>
            <Checkbox
              aria-label={t('Continue after errors')}
              disabled={busy || running}
              checked={continueOnError}
              onCheckedChange={(checked) => setContinueOnError(!!checked)}
            />
            {t('Continue after errors')}
          </Label>
        </div>
        {preview && !progress && (
          <>
            <p>
              {t('Statements / batches')}: {preview.total}
            </p>
            <div className="max-h-64 overflow-auto">
              <table className="w-full [&_th]:text-left [&_th]:pb-2 [&_td]:align-top [&_td]:py-1">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('Line')}</th>
                    <th>SQL</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.units.map((unit) => (
                    <tr key={unit.index}>
                      <td>{unit.index}</td>
                      <td>{unit.line}</td>
                      <td>
                        <pre className="whitespace-pre-wrap break-all text-xs">{unit.sql}</pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.total > 200 && <small>{t('Preview shows the first 200 batches.')}</small>}
          </>
        )}
        {progress && (
          <>
            <p role="status">
              {t(`Script ${progress.state}`)} · {progress.completed} / {progress.total} ·{' '}
              {t('Failed')}: {progress.failed}
              {progress.currentLine ? ` · ${t('Line')}: ${progress.currentLine}` : ''}
            </p>
            <progress
              aria-label={t('SQL file progress')}
              className="w-full h-2 rounded appearance-none [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-bar]:rounded [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:rounded"
              max={progress.total}
              value={progress.completed}
            />
            {progress.error && <Alert role="alert">{progress.error}</Alert>}
            <div className="max-h-64 overflow-auto">
              <table className="w-full [&_th]:text-left [&_th]:pb-2 [&_td]:align-top [&_td]:py-1">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('Line')}</th>
                    <th>{t('Result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {progress.results.map((row) => (
                    <tr key={row.index} className={row.success ? '' : 'text-destructive'}>
                      <td>{row.index}</td>
                      <td>{row.line}</td>
                      <td className="break-all">{row.success ? t('Executed') : row.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <small>
              {t(
                'Showing the last 200 results. Failed or cancelled files are not automatically retried.',
              )}
            </small>
          </>
        )}
        {error && <Alert role="alert">{error}</Alert>}
        <footer>
          <Button variant="outline" disabled={busy || running} onClick={onClose}>
            {t('Close')}
          </Button>
          {running ? (
            <Button
              variant="outline"
              onClick={() =>
                void command('script.cancel', { id: progress.id }).catch((err) =>
                  setError(err.message),
                )
              }
            >
              {t('Cancel execution')}
            </Button>
          ) : (
            <Button disabled={busy || !preview || !!progress} onClick={() => void execute()}>
              {t('Execute file')}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
