import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Fieldset } from './ui/fieldset';
import { confirmAction } from './ConfirmDialog';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { SelectField } from './SelectField';
import { Table } from './ui/table';
import { TableHeader } from './ui/table';
import { TableRow } from './ui/table';
import { TableHead } from './ui/table';
import { TableBody } from './ui/table';
import { TableCell } from './ui/table';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { WorkspaceTab } from '../../../shared/types';
import { command } from '../api';
interface RedisPage {
  key?: string;
  type: string;
  items: any[];
  ttl?: number;
  hasMore: boolean;
  nextCursor?: string;
  readOnly?: boolean;
}
export function RedisView({
  tab,
  onError,
}: {
  tab: WorkspaceTab;
  onError: (error: unknown) => void;
}) {
  const t = useI18n();
  const [pattern, setPattern] = useState('*');
  const [keys, setKeys] = useState<RedisPage>();
  const [key, setKey] = useState('');
  const [value, setValue] = useState<RedisPage>();
  const [editor, setEditor] = useState('');
  const [field, setField] = useState('');
  const [score, setScore] = useState('0');
  const [ttl, setTtl] = useState('-1');
  const [newKey, setNewKey] = useState(false);
  const [kind, setKind] = useState('string');
  const [streamId, setStreamId] = useState('*');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [valueDirty, setValueDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [editingExisting, setEditingExisting] = useState(false);
  const markDirty = (next = true, valueEdit = true) => {
    setDirty(next);
    if (!next) setValueDirty(false);
    else if (valueEdit) setValueDirty(true);
    void command('workspace.update', { id: tab.id, patch: { dirty: next } }).catch(onError);
  };
  const discard = async () => !dirty || (await confirmAction(t('Discard unsaved changes?')));
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const scan = async (cursor?: string) =>
    setKeys(
      await command<RedisPage>('redis.scan', {
        connectionId: tab.connectionId,
        database: tab.database,
        pattern,
        cursor,
      }),
    );
  const load = async (name: string, cursor?: string) => {
    const page = await command<RedisPage>('redis.get', {
      connectionId: tab.connectionId,
      database: tab.database,
      key: name,
      cursor,
    });
    setKey(name);
    setValue(page);
    setEditor(['string', 'json'].includes(page.type) ? (page.items[0] ?? '') : '');
    setTtl(String(page.ttl));
    setField('');
    setEditingExisting(false);
    setStreamId('*');
    setExternalChange(false);
    markDirty(false);
  };
  useEffect(() => {
    void perform(() => scan());
  }, [tab.id]);
  useEffect(
    () =>
      window.desktop.subscribe((event) => {
        if (event.type !== 'RedisValueChanged') return;
        const changed = event.payload as { connectionId: string; database: string; key: string };
        if (
          changed.connectionId !== tab.connectionId ||
          changed.database !== (tab.database || '0') ||
          changed.key !== key ||
          newKey ||
          busy
        )
          return;
        if (dirty) setExternalChange(true);
        else void perform(() => load(key));
      }),
    [tab.id, key, dirty, busy, newKey],
  );
  const write = async (operation: string, args: Record<string, unknown>, saveTtl = false) => {
    await command(`redis.${operation}`, {
      connectionId: tab.connectionId,
      database: tab.database,
      key,
      ...args,
    });
    if (saveTtl && value && ttl !== String(value.ttl))
      await command('redis.expire', {
        connectionId: tab.connectionId,
        database: tab.database,
        key,
        ttl: Number(ttl),
      });
    await load(key);
  };
  const save = async () => {
    const type = newKey ? kind : value?.type;
    if (value?.readOnly && !newKey) return;
    if (type === 'stream') {
      let fields: unknown;
      try {
        const parsed = JSON.parse(editor);
        fields = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object'
            ? Object.entries(parsed)
            : null;
      } catch {
        throw new Error(
          t('Enter stream fields as a JSON object or an array of field/value pairs.'),
        );
      }
      if (
        !Array.isArray(fields) ||
        !fields.length ||
        !fields.every(
          (pair) =>
            Array.isArray(pair) &&
            pair.length === 2 &&
            pair.every((part) => typeof part === 'string'),
        )
      )
        throw new Error(t('Stream field names and values must be strings.'));
      await write('xadd', { id: streamId, fields }, true);
      setNewKey(false);
      await scan();
      return;
    }
    const operation =
      type === 'json'
        ? 'json_set'
        : type === 'string'
          ? 'set'
          : type === 'hash'
            ? 'hset'
            : type === 'list'
              ? field === ''
                ? 'rpush'
                : 'lset'
              : type === 'set'
                ? 'sadd'
                : 'zadd';
    const args =
      type === 'hash'
        ? { field, value: editor }
        : type === 'list'
          ? { ...(field !== '' ? { index: Number(field) } : {}), value: editor }
          : type === 'set'
            ? { member: editor }
            : type === 'zset'
              ? { member: editor, score: Number(score) }
              : { value: editor };
    await write(operation, args, true);
    setNewKey(false);
    await scan();
  };
  const streamColumns =
    value?.type === 'stream'
      ? Array.from(
          new Set<string>(
            value.items.flatMap((item) => item.fields.map(([name]: [string, string]) => name)),
          ),
        )
      : [];
  return (
    <Fieldset className="redis-workspace" disabled={busy} aria-busy={busy}>
      <aside className="redis-keys">
        <div className="navigation-heading">
          {t('Redis DB {index}', { index: tab.database || '0' })}
        </div>
        <div className="toolbar">
          <Input
            aria-label={t('Key pattern')}
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void perform(() => scan());
            }}
          />
          <Button variant="outline" disabled={busy} onClick={() => void perform(() => scan())}>
            {t('Scan')}
          </Button>
        </div>
        <Button
          variant="outline"
          className="add-connection"
          onClick={async () => {
            if (!(await discard())) return;
            setNewKey(true);
            setKey('');
            setValue(undefined);
            setEditor('');
            setField('');
            setEditingExisting(false);
            setStreamId('*');
            setTtl('-1');
            markDirty(false);
          }}
        >
          {t('＋ New key')}
        </Button>
        <div className="key-list">
          {keys?.items.map((name) => (
            <Button
              variant="outline"
              className={key === name ? 'active' : ''}
              key={name}
              onClick={async () => {
                if (!(await discard())) return;
                setNewKey(false);
                void perform(() => load(name));
              }}
            >
              {name}
            </Button>
          ))}
        </div>
        <div className="toolbar">
          <span>{t('{count} keys', { count: keys?.items.length ?? 0 })}</span>
          <Button
            variant="outline"
            disabled={busy || !keys?.hasMore}
            onClick={() => void perform(() => scan(keys?.nextCursor))}
          >
            {t('Next scan →')}
          </Button>
        </div>
      </aside>
      <section className="redis-value">
        {externalChange && (
          <Alert role="status" className="notice">
            {t('Data changed elsewhere. Save or revert your edits, then refresh.')}
          </Alert>
        )}
        {key || newKey ? (
          <>
            <div className="toolbar">
              <strong>{newKey ? t('New Redis key') : key}</strong>
              <Badge className="badge">{value?.type}</Badge>
              <span className="spacer" />
              {!newKey && (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      if (await discard()) void perform(() => load(key));
                    }}
                  >
                    {t('Refresh')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmAction(t('Delete Redis key “{name}”?', { name: key })))
                        void perform(async () => {
                          await command('redis.delete', {
                            connectionId: tab.connectionId,
                            database: tab.database,
                            key,
                          });
                          setKey('');
                          setValue(undefined);
                          markDirty(false);
                          await scan();
                        });
                    }}
                  >
                    {t('Delete key')}
                  </Button>
                </>
              )}
            </div>
            {newKey && (
              <div className="toolbar">
                <Input
                  aria-label={t('New key name')}
                  placeholder={t('Key name')}
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value);
                    markDirty();
                  }}
                />
                <SelectField
                  aria-label={t('Redis type')}
                  value={kind}
                  onValueChange={(event) => {
                    setKind(event);
                    markDirty();
                  }}
                >
                  {['string', 'list', 'set', 'zset', 'hash', 'stream', 'json'].map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </SelectField>
              </div>
            )}
            {!newKey && (
              <div className="toolbar">
                <span>
                  {t('TTL')}{' '}
                  {value?.ttl === -1
                    ? t('No expiry')
                    : value?.ttl === -2
                      ? t('Key not found')
                      : t('{count} seconds', { count: value?.ttl ?? 0 })}
                </span>
                <Input
                  aria-label={t('TTL seconds')}
                  type="number"
                  min={-1}
                  value={ttl}
                  onChange={(event) => {
                    setTtl(event.target.value);
                    markDirty(true, false);
                  }}
                />
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !valueDirty ||
                      (await confirmAction(t('Apply TTL and discard other unsaved edits?')))
                    )
                      void perform(() => write('expire', { ttl: Number(ttl) }));
                  }}
                >
                  {t('Set TTL')}
                </Button>
                <small>{t('−1 removes expiry')}</small>
              </div>
            )}
            {value && ['hash', 'list', 'set', 'zset'].includes(value.type) && (
              <div className="redis-items">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {value.type === 'hash'
                          ? t('Field')
                          : value.type === 'list'
                            ? t('Index')
                            : t('Member')}
                      </TableHead>
                      <TableHead>{value.type === 'zset' ? t('Score') : t('Value')}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {value.items.map((item, index) => (
                      <TableRow key={index}>
                        <TableCell>
                          {typeof item === 'string'
                            ? item
                            : (item.field ?? item.index ?? item.member)}
                        </TableCell>
                        <TableCell>
                          {typeof item === 'string' ? '' : (item.value ?? item.score)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            onClick={async () => {
                              if (!(await discard())) return;
                              setEditingExisting(value.type !== 'set');
                              setTtl(String(value.ttl));
                              setField(String(item.field ?? item.index ?? ''));
                              setEditor(
                                typeof item === 'string' ? item : (item.value ?? item.member),
                              );
                              setScore(String(item.score ?? 0));
                              markDirty(false);
                            }}
                          >
                            {t(value.type === 'set' ? 'Copy member' : 'Edit')}
                          </Button>
                          {['hash', 'set', 'zset'].includes(value.type) && (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={async () => {
                                if (!(await discard())) return;
                                void perform(() =>
                                  write(
                                    value.type === 'hash'
                                      ? 'hdelete'
                                      : value.type === 'set'
                                        ? 'srem'
                                        : 'zrem',
                                    value.type === 'hash'
                                      ? { field: item.field }
                                      : { member: typeof item === 'string' ? item : item.member },
                                  ),
                                );
                              }}
                            >
                              {t('Remove')}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Button
                  variant="outline"
                  disabled={busy || !value.hasMore}
                  onClick={async () => {
                    if (await discard()) void perform(() => load(key, value.nextCursor));
                  }}
                >
                  {t('Next values →')}
                </Button>
              </div>
            )}
            {value?.type === 'stream' && (
              <div className="redis-items">
                <p>
                  {t('Stream entries are immutable. Append a new entry or delete an existing one.')}
                </p>
                <Table aria-label={t('Stream entries')}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Entry ID')}</TableHead>
                      {streamColumns.map((name) => (
                        <TableHead key={name}>{name}</TableHead>
                      ))}
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {value.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.id}</TableCell>
                        {streamColumns.map((name) => (
                          <TableCell key={name} className="redis-stream-cell">
                            {item.fields
                              .filter(([field]: [string, string]) => field === name)
                              .map(([, text]: [string, string], index: number) => (
                                <div key={index}>{text}</div>
                              ))}
                          </TableCell>
                        ))}
                        <TableCell>
                          <Button
                            variant="outline"
                            onClick={async () => {
                              if (
                                (await discard()) &&
                                (await confirmAction(
                                  t('Delete stream entry {id}?', { id: item.id }),
                                ))
                              )
                                void perform(() => write('xdelete', { id: item.id }));
                            }}
                          >
                            {t('Remove')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {!value.items.length && <p>{t('No stream entries.')}</p>}
                <Button
                  variant="outline"
                  disabled={busy || !value.hasMore}
                  onClick={async () => {
                    if (await discard()) void perform(() => load(key, value.nextCursor));
                  }}
                >
                  {t('Next values →')}
                </Button>
              </div>
            )}
            {value?.readOnly && (
              <Alert role="status" className="notice">
                {t(
                  'This extension type has no content viewer yet. You can inspect its type and TTL, change expiry, or delete the key.',
                )}
              </Alert>
            )}
            {value?.type === 'none' && (
              <Alert role="status" className="notice">
                {t('Key not found')}
              </Alert>
            )}
            {(newKey || (value && !value.readOnly && value.type !== 'none')) && (
              <div className="redis-editor">
                {(newKey ? kind : value?.type) === 'stream' && (
                  <>
                    <Label>
                      {t('Entry ID')}
                      <Input
                        aria-label={t('Entry ID')}
                        value={streamId}
                        onChange={(event) => {
                          setStreamId(event.target.value);
                          markDirty();
                        }}
                      />
                    </Label>
                    <small>
                      {t(
                        'Use * for an automatic ID. Fields: {"level":"info","message":"Hello"}. Duplicate fields can use [["field","value"]].',
                      )}
                    </small>
                  </>
                )}
                {(newKey ? kind : value?.type) === 'json' && (
                  <small>
                    {t('Edit the complete JSON document. The server must support RedisJSON.')}
                  </small>
                )}
                {['hash', 'list'].includes(newKey ? kind : (value?.type ?? '')) && (
                  <Label>
                    {(newKey ? kind : value?.type) === 'hash'
                      ? t('Field')
                      : t('Index (empty = append)')}
                    <Input
                      readOnly={editingExisting}
                      value={field}
                      onChange={(event) => {
                        setField(event.target.value);
                        markDirty();
                      }}
                    />
                  </Label>
                )}
                {(newKey ? kind : value?.type) === 'zset' && (
                  <Label>
                    {t('Score')}
                    <Input
                      type="number"
                      value={score}
                      onChange={(event) => {
                        setScore(event.target.value);
                        markDirty();
                      }}
                    />
                  </Label>
                )}
                <Label>
                  {t(
                    (newKey ? kind : value?.type) === 'stream'
                      ? 'Stream fields (JSON)'
                      : (newKey ? kind : value?.type) === 'json'
                        ? 'JSON document'
                        : 'Value / member',
                  )}
                  <Textarea
                    aria-label={t('Redis value')}
                    rows={7}
                    value={editor}
                    readOnly={editingExisting && value?.type === 'zset'}
                    onChange={(event) => {
                      setEditor(event.target.value);
                      markDirty();
                    }}
                  />
                </Label>
                <Button
                  variant="default"
                  className="primary"
                  disabled={busy || !key}
                  onClick={() => void perform(save)}
                >
                  {t((newKey ? kind : value?.type) === 'stream' ? 'Append entry' : 'Save value')}
                </Button>
                {dirty && <span className="dirty">{t('Unsaved changes')}</span>}
                {editingExisting && (
                  <Button
                    variant="outline"
                    onClick={async () => {
                      if (!(await discard())) return;
                      setEditingExisting(false);
                      setField('');
                      setEditor('');
                      setScore('0');
                      markDirty(false);
                    }}
                  >
                    {t('New member')}
                  </Button>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="welcome">
            <div className="welcome-icon">⌘</div>
            <h2>{t('Explore your Redis keys')}</h2>
            <p>{t('Scan keys by pattern, inspect values, and manage their expiry.')}</p>
          </div>
        )}
      </section>
    </Fieldset>
  );
}
