import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { useEffect, useState } from 'react';
import { command } from '../api';
import { useI18n } from '../i18n';

interface Summary {
  inferred: boolean;
  databases: { database: string; keys: number | null }[];
}

export function RedisExplorer({
  connectionId,
  selected,
  onOpen,
}: {
  connectionId: string;
  selected?: string;
  onOpen: (database: string) => void;
}) {
  const t = useI18n();
  const [summary, setSummary] = useState<Summary>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void command<Summary>('redis.databases', { connectionId })
      .then((next) => {
        if (!disposed) {
          setSummary(next);
          setError('');
        }
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason.message ?? reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [connectionId, revision]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = window.desktop.subscribe((event) => {
      if (
        event.type === 'RedisValueChanged' &&
        (event.payload as { connectionId: string }).connectionId === connectionId
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => setRevision((value) => value + 1), 200);
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [connectionId]);
  return (
    <>
      <div className="navigation-heading">
        <span>▤ {t('Database Explorer')}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('Refresh databases')}
          title={t('Refresh databases')}
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          ↻
        </Button>
      </div>
      {error && (
        <Alert className="notice" role="alert">
          {error}
        </Alert>
      )}
      {summary?.inferred && (
        <p className="navigation-empty">
          {t('Database list uses defaults because server configuration is unavailable.')}
        </p>
      )}
      <div className="redis-databases" aria-label={t('Redis databases')} aria-busy={loading}>
        {summary?.databases.map(({ database, keys }) => (
          <Button
            variant="outline"
            key={database}
            data-redis-database={database}
            className={selected === database ? 'active' : ''}
            aria-pressed={selected === database}
            title={t('Open Redis DB {database}', { database })}
            onClick={() => onOpen(database)}
          >
            <span
              className={`redis-database-icon ${keys && keys > 0 ? 'populated' : ''}`}
              aria-hidden="true"
            >
              ▤
            </span>
            <span>{database}</span>
            <span className="spacer" />
            <span
              className="redis-key-count"
              aria-label={
                keys === null ? t('Key count unavailable') : t('{count} keys', { count: keys })
              }
            >
              {keys === null ? '—' : keys.toLocaleString()}
            </span>
          </Button>
        ))}
      </div>
    </>
  );
}
