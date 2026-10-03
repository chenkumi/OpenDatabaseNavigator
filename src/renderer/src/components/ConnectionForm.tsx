import { confirmAction } from './ConfirmDialog';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { SelectField } from './SelectField';
import { Checkbox } from './ui/checkbox';
import { useI18n } from '../i18n';
import { SecureStorageNotice, useSecureStorageStatus } from './SecureStorageNotice';
import { useRef, useState } from 'react';
import type { Connection } from '../../../shared/types';
import { command } from '../api';
import { connectionSchema } from '../../../shared/schemas';
import {
  REDIS_ENCODINGS,
  POSTGRES_ENCODINGS,
  ASE_ENCODINGS,
} from '../../../shared/client-encodings';
export function ConnectionForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Connection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useI18n();
  const secureStorage = useSecureStorageStatus();
  const [form, setForm] = useState({
    name: '',
    engine: 'sqlite',
    database: '',
    host: 'localhost',
    port: 5432,
    username: '',
    sqlServerAuth: 'sql',
    sqlServerSpn: '',
    password: '',
    group: 'Local',
    color: '#4f8cff',
    favorite: false,
    agentAccess: 'disabled',
    tls: false,
    connectionTimeout: 10000,
    heartbeatInterval: 0,
    readTimeout: 0,
    writeTimeout: 0,
    charset: '',
    pgDumpPath: '',
    sqlServerPowerShellPath: '',
    aseDriver: 'Adaptive Server Enterprise',
    aseTrustedFile: '',
    aseJavaPath: '',
    aseDdlgenPath: '',
    aseJconnectPath: '',
    ...initial,
  });
  const initialForm = useRef(JSON.stringify(form));
  const requestClose = async () => {
    // Escape and outside clicks must not silently throw away typed input.
    if (
      JSON.stringify(form) !== initialForm.current &&
      !(await confirmAction(t('Discard unsaved changes?')))
    )
      return;
    onClose();
  };
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const patch = (key: string, value: unknown) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const submit = async (test: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const payload: any = { ...form };
      if (!['mysql', 'redis', 'postgres', 'sybase'].includes(form.engine) || !form.charset.trim())
        delete payload.charset;
      if (!['mysql', 'postgres', 'redis', 'sqlserver', 'sybase'].includes(form.engine)) {
        payload.readTimeout = 0;
        payload.writeTimeout = 0;
      }
      if (form.engine !== 'postgres' || !form.pgDumpPath.trim()) delete payload.pgDumpPath;
      if (form.engine !== 'sqlserver' || !form.sqlServerPowerShellPath.trim())
        delete payload.sqlServerPowerShellPath;
      if (form.engine !== 'sybase') {
        delete payload.aseDriver;
        delete payload.aseTrustedFile;
      } else if (!form.aseDriver.trim()) delete payload.aseDriver;
      for (const field of ['aseJavaPath', 'aseDdlgenPath', 'aseJconnectPath'] as const)
        if (form.engine !== 'sybase' || !form[field].trim()) delete payload[field];
      if (initial && !form.password) delete payload.password;
      if (!initial && !form.password) delete payload.password;
      if (form.engine !== 'sqlserver') payload.sqlServerAuth = 'sql';
      if (
        form.engine !== 'sqlserver' ||
        form.sqlServerAuth !== 'windows' ||
        !form.sqlServerSpn.trim()
      )
        delete payload.sqlServerSpn;
      if (form.engine === 'sqlserver' && form.sqlServerAuth === 'windows') {
        delete payload.username;
        delete payload.password;
      }
      const validation = connectionSchema.safeParse(payload);
      if (!validation.success) {
        const fields: Record<string, string> = {
          name: 'Name',
          database: form.engine === 'sqlite' ? 'Database file' : 'Database',
          host: 'Host',
          port: 'Port',
          username: 'Username',
          password: 'Password',
          aseDriver: 'ASE ODBC driver',
          aseTrustedFile: 'Trusted certificates file',
          aseJavaPath: 'Java path for ASE',
          aseDdlgenPath: 'SAP DDLGen.jar path',
          aseJconnectPath: 'SAP jconn4.jar path',
          connectionTimeout: 'Connection timeout (ms)',
          heartbeatInterval: 'Heartbeat interval (seconds)',
          readTimeout: 'Read timeout (ms)',
          writeTimeout: 'Write timeout (ms)',
          charset: 'Client character set',
          pgDumpPath: 'pg_dump path',
          sqlServerPowerShellPath: 'PowerShell path for SQL export',
          sqlServerSpn: 'Server SPN',
        };
        setMessage(
          validation.error.issues
            .map((issue) => {
              const field = String(issue.path[0] ?? '');
              if (field === 'name' && !form.name.trim())
                return t('Please enter a connection name.');
              if (field === 'database' && form.engine === 'sqlite' && !form.database.trim())
                return t('Please select a database file.');
              return t('Please check {field}.', { field: t(fields[field] ?? field) });
            })
            .join('\n'),
        );
        return;
      }
      // Only a new/replacement password needs encryption. Never gate SQLite,
      // integrated authentication, or metadata-only/passwordless saves.
      if (!test && form.engine !== 'sqlite' && payload.password) {
        const status = await secureStorage.recheck();
        if (status && !status.available) {
          setMessage(
            t(
              'Cannot save password: secure credential storage is unavailable. Follow the guidance below, then recheck.',
            ),
          );
          return;
        }
      }
      try {
        await command(test ? 'connection.test' : 'connection.save', payload);
      } catch (error) {
        if (test || !(error as Error).message.startsWith('Unsaved changes:')) throw error;
        if (
          !(await confirmAction(
            t('Changing this connection closes its tabs. Discard unsaved changes and save?'),
          ))
        )
          return;
        await command('connection.save', { ...payload, discard: true });
      }
      if (test) setMessage(t('Connection successful'));
      else onSaved();
    } catch (error) {
      if ((error as Error).message.startsWith('OS secure credential storage is unavailable.')) {
        await secureStorage.recheck();
        setMessage(
          t(
            'Secure credential storage is unavailable. Follow the guidance below, then recheck before retrying.',
          ),
        );
      } else setMessage((error as Error).message);
    } finally {
      setBusy(false);
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
        className="modal connection-dialog"
        render={<form />}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit(false);
        }}
      >
        <header>
          <DialogTitle>{initial ? t('Edit connection') : t('New connection')}</DialogTitle>
          <Button
            size="icon"
            variant="ghost"
            type="button"
            disabled={busy}
            aria-label={t('Close')}
            onClick={onClose}
          >
            ✕
          </Button>
        </header>
        <div className="connection-content">
          <div className="form-grid">
            <Label>
              {t('Name')}
              <Input
                autoFocus
                value={form.name}
                onChange={(event) => patch('name', event.target.value)}
              />
            </Label>
            <Label>
              {t('Database type')}
              <SelectField
                aria-label={t('Database type')}
                value={form.engine}
                onValueChange={(event) => {
                  patch('engine', event);
                  if (event !== form.engine) patch('charset', '');
                  patch(
                    'port',
                    (
                      {
                        mysql: 3306,
                        postgres: 5432,
                        sqlserver: 1433,
                        redis: 6379,
                        sybase: 5000,
                      } as any
                    )[event] ?? 5432,
                  );
                }}
              >
                {['sqlite', 'mysql', 'postgres', 'sqlserver', 'redis', 'sybase'].map((type) => (
                  <option key={type} value={type}>
                    {type === 'sybase' ? t('SAP / Sybase ASE (experimental)') : type}
                  </option>
                ))}
              </SelectField>
            </Label>
            {form.engine === 'sqlite' ? (
              <Label className="wide">
                {t('Database file')}
                <div className="inline">
                  <Input
                    placeholder="C:\data\database.sqlite"
                    value={form.database}
                    onChange={(event) => patch('database', event.target.value)}
                  />
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const path = await window.desktop.chooseDatabase();
                      if (path) patch('database', path);
                    }}
                  >
                    {t('Browse…')}
                  </Button>
                </div>
              </Label>
            ) : (
              <>
                <Label>
                  {t('Host')}
                  <Input
                    value={form.host}
                    onChange={(event) => patch('host', event.target.value)}
                  />
                </Label>
                <Label>
                  {t('Port')}
                  <Input
                    type="number"
                    value={form.port}
                    onChange={(event) => patch('port', Number(event.target.value))}
                  />
                </Label>
                {form.engine === 'sqlserver' && (
                  <>
                    <Label className="wide">
                      {t('Authentication')}
                      <SelectField
                        aria-label={t('Authentication')}
                        value={form.sqlServerAuth}
                        onValueChange={(event) => {
                          patch('sqlServerAuth', event);
                          patch('password', '');
                        }}
                      >
                        <option value="sql">{t('SQL Server authentication')}</option>
                        <option value="windows" disabled={window.desktop.platform !== 'win32'}>
                          {t('Windows authentication')}
                        </option>
                      </SelectField>
                    </Label>
                    <p className="muted wide">
                      {t(
                        form.sqlServerAuth === 'windows'
                          ? 'Uses the current Windows account. Requires Microsoft ODBC Driver 18 for SQL Server.'
                          : 'Windows authentication is available only on Windows.',
                      )}
                    </p>
                    {form.sqlServerAuth === 'windows' && (
                      <Label className="wide">
                        {t('Server SPN')}
                        <Input
                          aria-label={t('Server SPN')}
                          value={form.sqlServerSpn}
                          placeholder="MSSQLSvc/database.example.com:1433"
                          onChange={(event) => patch('sqlServerSpn', event.target.value)}
                        />
                        <small>
                          {t(
                            'Optional service principal for Windows authentication. Required with network deadlines; use the SPN registered for your server. Network deadlines require a TCP host and a separate port.',
                          )}
                        </small>
                      </Label>
                    )}
                  </>
                )}
                {form.engine === 'sybase' && (
                  <>
                    <p className="muted wide">
                      {t(
                        'ASE 16.x support awaits real-server validation. Use SAP ASE ODBC, or choose a JDBC character set below and configure jConnect. SQL Anywhere and IQ are not supported.',
                      )}
                    </p>
                    {!form.charset && (
                      <Label className="wide">
                        {t('ASE ODBC driver')}
                        <Input
                          value={form.aseDriver}
                          onChange={(event) => patch('aseDriver', event.target.value)}
                        />
                      </Label>
                    )}
                    {form.tls && (
                      <Label className="wide">
                        {t('Trusted certificates file')}
                        <Input
                          value={form.aseTrustedFile}
                          onChange={(event) => patch('aseTrustedFile', event.target.value)}
                        />
                      </Label>
                    )}
                  </>
                )}
                {!(form.engine === 'sqlserver' && form.sqlServerAuth === 'windows') && (
                  <>
                    <Label>
                      {t('Username')}
                      <Input
                        value={form.username}
                        onChange={(event) => patch('username', event.target.value)}
                      />
                    </Label>
                    <Label>
                      {t('Password')}
                      <Input
                        type="password"
                        autoComplete="new-password"
                        placeholder={initial ? t('Leave blank to keep current password') : ''}
                        value={form.password}
                        onChange={(event) => patch('password', event.target.value)}
                      />
                    </Label>
                  </>
                )}
                <Label>
                  {form.engine === 'redis' ? t('DB index') : t('Database')}
                  <Input
                    placeholder={
                      form.engine === 'redis'
                        ? '0'
                        : t('Optional — select a database after connecting')
                    }
                    value={form.database}
                    onChange={(event) => patch('database', event.target.value)}
                  />
                </Label>
                <Label>
                  <Checkbox checked={form.tls} onCheckedChange={(event) => patch('tls', event)} />{' '}
                  TLS
                </Label>
                <Label>
                  {t('Connection timeout (ms)')}
                  <Input
                    type="number"
                    min={100}
                    max={300000}
                    step={100}
                    value={form.connectionTimeout}
                    onChange={(event) => patch('connectionTimeout', Number(event.target.value))}
                  />
                </Label>
                {form.engine === 'mysql' && (
                  <>
                    <Label>
                      {t('Client character set')}
                      <Input
                        value={form.charset}
                        placeholder="utf8mb4"
                        onChange={(event) => patch('charset', event.target.value)}
                      />
                      <small>{t('Leave blank to use the driver default.')}</small>
                    </Label>
                  </>
                )}
                {['mysql', 'postgres', 'redis', 'sqlserver', 'sybase'].includes(form.engine) && (
                  <>
                    {(['readTimeout', 'writeTimeout'] as const).map((field) => (
                      <Label key={field}>
                        {t(field === 'readTimeout' ? 'Read timeout (ms)' : 'Write timeout (ms)')}
                        <Input
                          type="number"
                          min={0}
                          max={300000}
                          step={100}
                          value={form[field]}
                          onChange={(event) => patch(field, Number(event.target.value))}
                        />
                        <small>
                          {t(
                            field === 'readTimeout'
                              ? '0 disables the read deadline. While awaiting results, each received chunk resets it; idle connections are not timed out.'
                              : '0 disables the write deadline. Pending socket writes must make progress within this interval.',
                          )}
                        </small>
                      </Label>
                    ))}
                    {form.engine === 'postgres' && (
                      <small className="col-span-2">
                        {t(
                          'PostgreSQL network deadlines apply to queries, SQL files and pg_dump export. Native export monitors transport inactivity throughout the job; output processing pauses the read deadline.',
                        )}
                      </small>
                    )}
                    {form.engine === 'sqlserver' && (
                      <small className="col-span-2">
                        {t(
                          'SQL Server network deadlines apply to queries, SQL files and TCP native export. Windows authentication requires an explicit server SPN. Export deadlines require the SqlServer PowerShell module with Microsoft.Data.SqlClient 5.0 or later.',
                        )}
                      </small>
                    )}
                    {form.engine === 'sybase' && (
                      <small className="col-span-2">
                        {t(
                          'ASE network deadlines are experimental. With TLS, use a PEM CA file; the app verifies the original host and encrypts upstream traffic. Native-driver traffic stays on loopback.',
                        )}
                      </small>
                    )}
                  </>
                )}
                {form.engine === 'postgres' && (
                  <Label>
                    {t('pg_dump path')}
                    <Input
                      value={form.pgDumpPath}
                      onChange={(event) => patch('pgDumpPath', event.target.value)}
                      placeholder={t('Auto-detect PostgreSQL client tools')}
                    />
                    <small>
                      {t(
                        'Optional absolute path to pg_dump. Required for SQL export if client tools cannot be found automatically.',
                      )}
                    </small>
                  </Label>
                )}
                {['redis', 'postgres', 'sybase'].includes(form.engine) && (
                  <Label>
                    {t('Client character set')}
                    <SelectField
                      aria-label={t('Client character set')}
                      value={
                        form.charset ||
                        (form.engine === 'sybase'
                          ? 'odbc'
                          : form.engine === 'postgres'
                            ? 'UTF8'
                            : 'utf8')
                      }
                      onValueChange={(value) => patch('charset', value === 'odbc' ? '' : value)}
                    >
                      {form.engine === 'sybase' && <option value="odbc">UTF-8 (ODBC)</option>}
                      {(form.engine === 'sybase'
                        ? ASE_ENCODINGS
                        : form.engine === 'postgres'
                          ? POSTGRES_ENCODINGS
                          : REDIS_ENCODINGS
                      ).map((encoding) => (
                        <option key={encoding.value} value={encoding.value}>
                          {encoding.label}
                        </option>
                      ))}
                    </SelectField>
                    <small>
                      {t(
                        form.engine === 'sybase'
                          ? 'JDBC encodings require JDK 11+ and SAP jconn4.jar. SQL and parameters must be representable in the selected encoding. Reconnect after changing this setting; SQL exports remain UTF-8. Experimental until verified with your ASE server.'
                          : form.engine === 'postgres'
                            ? 'Sets PostgreSQL protocol text encoding for SQL, parameters and results. Unrepresentable text is rejected. Change this setting and reconnect instead of using SET client_encoding. SQL export files remain UTF-8.'
                            : 'Encodes Redis text keys and values. JSON documents stay UTF-8. Unrepresentable characters are rejected; existing bytes are not converted.',
                      )}
                    </small>
                  </Label>
                )}
                {!['mysql', 'redis', 'postgres', 'sybase'].includes(form.engine) && (
                  <Label>
                    {t('Client character set')}
                    <Input
                      readOnly
                      value={
                        form.engine === 'sqlserver'
                          ? t('Automatic (Unicode / column collation)')
                          : 'UTF-8'
                      }
                    />
                    <small>
                      {t(
                        form.engine === 'sqlserver'
                          ? "The SQL Server driver uses Unicode and each column's collation; there is no connection-wide client character set."
                          : 'The ASE native bridge uses UTF-8; the ODBC driver negotiates conversion with the server.',
                      )}
                    </small>
                  </Label>
                )}
                {form.engine === 'sqlserver' && (
                  <Label>
                    {t('PowerShell path for SQL export')}
                    <Input
                      value={form.sqlServerPowerShellPath}
                      placeholder={t('Auto-detect PowerShell')}
                      onChange={(event) => patch('sqlServerPowerShellPath', event.target.value)}
                    />
                    <small>
                      {t(
                        'SQL export requires the SqlServer PowerShell module, or SQLPS on Windows. Leave blank to detect the host automatically.',
                      )}
                    </small>
                  </Label>
                )}
                {form.engine === 'sybase' && (
                  <>
                    {(
                      [
                        ['aseJavaPath', 'Java path for ASE'],
                        ['aseDdlgenPath', 'SAP DDLGen.jar path'],
                        ['aseJconnectPath', 'SAP jconn4.jar path'],
                      ] as const
                    ).map(([field, label]) => (
                      <Label key={field}>
                        {t(label)}
                        <Input
                          aria-label={t(label)}
                          value={form[field]}
                          onChange={(event) => patch(field, event.target.value)}
                        />
                      </Label>
                    ))}
                    <small className="col-span-2">
                      {t(
                        'ASE JDBC queries require JDK 11+ and SAP jconn4.jar. SQL export also requires SAP DDLGen.jar. Use absolute file paths. Leave Java blank to detect JAVA_HOME or PATH.',
                      )}
                    </small>
                  </>
                )}
                <Label>
                  {t('Heartbeat interval (seconds)')}
                  <Input
                    type="number"
                    min={0}
                    max={86400}
                    step={1}
                    value={form.heartbeatInterval}
                    onChange={(event) => patch('heartbeatInterval', Number(event.target.value))}
                  />
                  <small>{t('0 disables keepalive. Disconnecting stops all probes.')}</small>
                </Label>
              </>
            )}
            <Label>
              {t('Group')}
              <Input value={form.group} onChange={(event) => patch('group', event.target.value)} />
            </Label>
            <Label>
              {t('Connection color')}
              <Input
                type="color"
                value={form.color}
                onChange={(event) => patch('color', event.target.value)}
              />
            </Label>
            <Label>
              {t('Agent access')}
              <SelectField
                value={form.agentAccess}
                onValueChange={(event) => patch('agentAccess', event)}
              >
                <option value="disabled">{t('Disabled')}</option>
                <option value="read">{t('Read only')}</option>
                <option value="write">{t('Read + Write')}</option>
              </SelectField>
            </Label>
            <Label>
              <Checkbox
                checked={form.favorite}
                onCheckedChange={(event) => patch('favorite', event)}
              />{' '}
              {t('Favorite')}
            </Label>
          </div>
          {message && (
            <Alert role="status" className="notice connection-message">
              {message}
            </Alert>
          )}
          {form.engine !== 'sqlite' &&
            !(form.engine === 'sqlserver' && form.sqlServerAuth === 'windows') && (
              <SecureStorageNotice {...secureStorage} />
            )}
        </div>
        <footer>
          <Button variant="outline" type="button" disabled={busy} onClick={() => void submit(true)}>
            {t('Test connection')}
          </Button>
          <Button variant="default" type="submit" className="primary" disabled={busy}>
            {t('Save connection')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
