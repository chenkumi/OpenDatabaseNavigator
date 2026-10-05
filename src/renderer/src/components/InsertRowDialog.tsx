import { Alert } from './ui/alert';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { SelectField } from './SelectField';
import { Input } from './ui/input';
import { useState } from 'react';
import { confirmAction } from './ConfirmDialog';
import type { Column } from '../../../shared/types';
import { useI18n } from '../i18n';

export function InsertRowDialog({
  columns,
  onClose,
  onInsert,
}: {
  columns: Column[];
  onClose: () => void;
  onInsert: (values: Record<string, unknown>) => Promise<void>;
}) {
  const t = useI18n();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [json, setJson] = useState('{}');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestClose = async () => {
    // Escape and outside clicks must not silently throw away typed input.
    if (
      (Object.keys(values).length > 0 || json !== '{}') &&
      !(await confirmAction(t('Discard unsaved changes?')))
    )
      return;
    onClose();
  };
  const parse = () => {
    const value = JSON.parse(json);
    if (!value || Array.isArray(value) || typeof value !== 'object')
      throw new Error(t('Enter a JSON object with column values.'));
    return value as Record<string, unknown>;
  };

  const switchMode = () => {
    try {
      if (advanced) {
        const next = parse();
        if (
          Object.entries(next).some(
            ([name, value]) =>
              !columns.some((column) => column.name === name) ||
              (value !== null && !['string', 'number', 'boolean'].includes(typeof value)),
          )
        )
          throw new Error(t('These JSON values require advanced mode.'));
        setValues(next);
      } else setJson(JSON.stringify(values, null, 2));
      setAdvanced(!advanced);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) void requestClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        render={<form />}
        className="modal insert-row-dialog"

        aria-labelledby="insert-row-title"

        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setError('');
          setBusy(true);
          try {
            await onInsert(advanced ? parse() : values);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <header>
          <DialogTitle id="insert-row-title">{t('Insert row')}</DialogTitle>
          <Button
            size="icon"
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => void requestClose()}
            aria-label={t('Close')}
          >
            ×
          </Button>
        </header>
        <div className="insert-row-content">
          <p>
            {t('Omitted columns use database defaults. NULL and empty text are different values.')}
          </p>
          <Button variant="outline" type="button" disabled={busy} onClick={switchMode}>
            {t(advanced ? 'Use field form' : 'Advanced JSON')}
          </Button>
          {advanced ? (
            <Textarea
              aria-label={t('Row JSON')}
              rows={10}
              value={json}
              disabled={busy}
              onChange={(event) => setJson(event.target.value)}
            />
          ) : (
            columns.map((column) => {
              const provided = Object.hasOwn(values, column.name);
              const mode = !provided ? 'omit' : values[column.name] === null ? 'null' : 'value';
              const boolean = /^(boolean|bool|bit)$/i.test(column.type);
              const numeric =
                /^(tinyint|smallint|mediumint|int|integer|float|real|double)(\b|\()/i.test(
                  column.type,
                );
              return (
                <div className="insert-field" key={column.name}>
                  <Label htmlFor={`insert-${column.name}`}>
                    <strong>{column.name}</strong>
                    <small>
                      {column.type}
                      {column.nullable ? '' : ' · NOT NULL'}
                      {column.defaultValue != null
                        ? ` · ${t('Default')}: ${String(column.defaultValue)}`
                        : ''}
                    </small>
                  </Label>
                  <SelectField
                    aria-label={t('Value mode for {name}', { name: column.name })}
                    value={mode}
                    disabled={busy || column.generated}
                    onValueChange={(event) => {
                      const next = { ...values };
                      if (event === 'omit') delete next[column.name];
                      else {
                        setValues({
                          ...values,
                          [column.name]: event === 'null' ? null : boolean ? false : '',
                        });
                        return;
                      }
                      setValues(next);
                    }}
                  >
                    <option value="omit">
                      {t(column.generated ? 'Computed by database' : 'Use database default')}
                    </option>
                    <option value="value">{t('Value')}</option>
                    {(column.nullable || mode === 'null') && <option value="null">NULL</option>}
                  </SelectField>
                  {mode === 'value' &&
                    (boolean ? (
                      <SelectField
                        id={`insert-${column.name}`}
                        aria-label={t('Value for {name}', { name: column.name })}
                        value={String(values[column.name])}
                        disabled={busy}
                        onValueChange={(event) =>
                          setValues({ ...values, [column.name]: event === 'true' })
                        }
                      >
                        {![true, false].includes(values[column.name] as boolean) && (
                          <option value={String(values[column.name])}>
                            {String(values[column.name])}
                          </option>
                        )}
                        <option value="false">false</option>
                        <option value="true">true</option>
                      </SelectField>
                    ) : (
                      <Input
                        id={`insert-${column.name}`}
                        aria-label={t('Value for {name}', { name: column.name })}
                        type={numeric ? 'number' : 'text'}
                        step="any"
                        required={numeric}
                        value={String(values[column.name])}
                        disabled={busy}
                        onChange={(event) => {
                          const text = event.target.value;
                          const number = Number(text);
                          setValues({
                            ...values,
                            [column.name]:
                              numeric &&
                              text !== '' &&
                              Number.isFinite(number) &&
                              Math.abs(number) <= Number.MAX_SAFE_INTEGER
                                ? number
                                : text,
                          });
                        }}
                      />
                    ))}
                </div>
              );
            })
          )}
          {error && (
            <Alert className="notice" role="alert">
              {error}
            </Alert>
          )}
        </div>
        <footer>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => void requestClose()}
          >
            {t('Cancel')}
          </Button>
          <Button type="submit" variant="default" className="primary" disabled={busy}>
            {t(busy ? 'Inserting…' : 'Insert')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
