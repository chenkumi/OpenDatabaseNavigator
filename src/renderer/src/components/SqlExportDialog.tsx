import { useEffect, useRef, useState } from 'react';
import type { SqlExportProgress } from '../../../shared/sql-export';
import type { Engine } from '../../../shared/types';
import { command } from '../api';
import { useI18n } from '../i18n';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { Alert } from './ui/alert';

export function SqlExportDialog({
  connectionId,
  database,
  engine,
  onClose,
}: {
  connectionId: string;
  database: string;
  engine: Engine;
  onClose: () => void;
}) {
  const t = useI18n();
  const [includeData, setIncludeData] = useState(true);
  const [progress, setProgress] = useState<SqlExportProgress>();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    id = useRef<string | undefined>(undefined);
  const running = progress?.state === 'running';
  useEffect(() => {
    const unsubscribe = window.desktop.subscribe((event) => {
      if (
        event.type === 'SqlExportProgress' &&
        (event.payload as SqlExportProgress).id === id.current
      )
        setProgress(event.payload as SqlExportProgress);
    });
    return () => {
      unsubscribe();
      if (id.current) void command('export.release', { id: id.current }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!running) return;
    let active = true;
    const timer = setInterval(() => {
      void command<SqlExportProgress>('export.status', { id: id.current })
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
  }, [running]);
  const act = async (task: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await task();
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
        className="modal sql-export-dialog"
        aria-label={t('Export SQL file')}
      >
        <header>
          <DialogTitle>{t('Export SQL file')}</DialogTitle>
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
        <p className="break-all">
          <strong>{database}</strong>
        </p>
        <p className="muted">
          {t(
            engine === 'sybase'
              ? 'ASE exports the native database creation script. Review database names, device paths and prerequisites before restoring on a compatible server.'
              : 'Export tables, indexes, views and triggers. Restore into an empty database. Data is read from one consistent snapshot.',
          )}
        </p>
        <Label>
          <Checkbox
            checked={includeData}
            disabled={busy || running || progress?.state === 'completed'}
            onCheckedChange={(value) => setIncludeData(!!value)}
          />
          {t('Include table data')}
        </Label>
        <p className="muted">{includeData ? t('Structure and data') : t('Structure only')}</p>
        <p className="muted">
          {t(
            engine === 'mysql'
              ? 'MySQL / MariaDB: InnoDB uses a snapshot; mixed MyISAM/Aria/MEMORY tables require READ locks that temporarily block writes. Restore into an empty database with the original name and collation. Qualified references and DEFINER accounts are preserved. Routines are included; events and grants are not. Up to 16 MiB.'
              : engine === 'postgres'
                ? 'PostgreSQL: requires native pg_dump client tools. Includes schemas, types, sequences, routines and privileges. Referenced roles, extensions and tablespaces must exist at the destination. Publications and subscriptions are excluded. Row counts are unavailable. Up to 16 MiB.'
                : engine === 'sqlserver'
                  ? 'SQL Server: requires PowerShell with the SqlServer or SQLPS module. Data export holds shared table locks that temporarily block writes. Restore into an empty database with the original collation and required principals and filegroups. Up to 16 MiB.'
                  : engine === 'sybase'
                    ? 'ASE: experimental native ddlgen export, including CREATE DATABASE and USE. Data requires JDK 11+ and jconn4.jar, and holds shared table locks that temporarily block writes. Configure SAP tools in connection settings. Up to 16 MiB; real ASE validation is pending.'
                    : 'Up to 16 MiB, compatible with Execute SQL file. SQLite virtual tables are not yet supported; unsupported or oversized exports fail without saving a partial file.',
          )}
        </p>
        {progress && (
          <div role="status" className="space-y-2">
            <p>{t(`Export ${progress.state}`)}</p>
            <p>
              {t('Tables')}: {progress.tables} · {t('Rows')}: {progress.rows ?? '—'} ·{' '}
              {(progress.bytes / 1024).toFixed(1)} KiB
            </p>
            {progress.currentTable && <p className="break-all">{progress.currentTable}</p>}
            {running && <p className="muted">{t('Reading database and writing SQL…')}</p>}
            {progress.error && <Alert role="alert">{progress.error}</Alert>}
          </div>
        )}
        {saved && (
          <p role="status">
            {t('SQL file saved')}: {saved}
          </p>
        )}
        {error && <Alert role="alert">{error}</Alert>}
        <footer>
          <Button variant="outline" disabled={busy || running} onClick={onClose}>
            {t('Close')}
          </Button>
          {running ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await command('export.cancel', { id: id.current });
                })
              }
            >
              {t('Cancel export')}
            </Button>
          ) : progress?.state === 'completed' ? (
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await command<{ fileName: string } | null>(
                    'file.sql.save-export',
                    { id: id.current },
                  );
                  if (result) setSaved(result.fileName);
                })
              }
            >
              {t('Save SQL file')}
            </Button>
          ) : (
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (id.current) await command('export.release', { id: id.current });
                  id.current = crypto.randomUUID();
                  setProgress(undefined);
                  try {
                    await command('export.start', {
                      id: id.current,
                      connectionId,
                      database,
                      includeData,
                    });
                  } catch (error) {
                    id.current = undefined;
                    throw error;
                  }
                  setProgress(await command('export.status', { id: id.current }));
                })
              }
            >
              {t('Start export')}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
