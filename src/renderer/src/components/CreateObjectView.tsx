import { Alert } from './ui/alert';
import { Fieldset } from './ui/fieldset';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { SelectField } from './SelectField';
import { Input } from './ui/input';
import { Table } from './ui/table';
import { TableHeader } from './ui/table';
import { TableRow } from './ui/table';
import { TableHead } from './ui/table';
import { TableBody } from './ui/table';
import { TableCell } from './ui/table';
import { Checkbox } from './ui/checkbox';
import { Textarea } from './ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { useEffect, useState } from 'react';
import type {
  Connection,
  WorkspaceTab,
  TableInfo,
  Column,
  DatabaseObjectPlan,
} from '../../../shared/types';
import type { CreateObjectInput } from '../../../shared/create-object';
import { command } from '../api';
import { useI18n } from '../i18n';
import { ColumnTypeEditor } from './ColumnTypeEditor';
import { GenerationFields } from './GeneratedColumnDesigner';
import type { GenerationCapabilities } from '../../../shared/generated-columns';
import type { ViewCapabilities } from '../../../shared/view-options';
import { ViewOptionsForm } from './ViewOptionsForm';
import { IndexOptionsForm } from './IndexOptionsForm';
import type { IndexCapabilities } from '../../../shared/index-options';

export function CreateObjectView({
  tab,
  connection,
}: {
  tab: WorkspaceTab;
  connection: Connection;
}) {
  const t = useI18n();
  const [draft, setDraft] = useState<CreateObjectInput>(() => {
    if (tab.sql) {
      try {
        return JSON.parse(tab.sql);
      } catch {}
    }
    return {
      connectionId: tab.connectionId,
      database: tab.database,
      schema:
        tab.schema ||
        (connection.engine === 'sqlite'
          ? 'main'
          : connection.engine === 'postgres'
            ? 'public'
            : ['sqlserver', 'sybase'].includes(connection.engine)
              ? 'dbo'
              : tab.database || ''),
      kind: tab.createKind!,
      name: '',
      table: '',
      columns: [
        {
          name: 'id',
          type: ['sqlserver', 'sybase'].includes(connection.engine) ? 'int' : 'integer',
          nullable: false,
          primaryKey: true,
          defaultSql: '',
        },
      ],
      selectSql: 'SELECT 1 AS id',
      indexColumns: [],
      unique: false,
      timing: 'AFTER',
      event: 'INSERT',
      body:
        connection.engine === 'postgres'
          ? 'RETURN NEW;'
          : ['sqlserver', 'sybase'].includes(connection.engine)
            ? 'SET NOCOUNT ON;\n-- Add trigger statements here.'
            : connection.engine === 'mysql'
              ? 'SET @trigger_value = 1;'
              : 'SELECT 1;',
      createFunction: true,
      functionSchema: '',
      functionName: '',
    };
  });
  const [schemas, setSchemas] = useState<string[]>([]),
    [tables, setTables] = useState<TableInfo[]>([]),
    [columns, setColumns] = useState<Column[]>([]);
  const [generationCaps, setGenerationCaps] = useState<GenerationCapabilities>();
  const [viewCaps, setViewCaps] = useState<ViewCapabilities>();
  const [indexCaps, setIndexCaps] = useState<IndexCapabilities>();
  useEffect(() => {
    let active = true;
    setIndexCaps(undefined);
    if (draft.kind === 'index' && draft.table)
      void command<IndexCapabilities>('index.options', {
        connectionId: tab.connectionId,
        database: tab.database,
        schema: draft.schema,
        table: draft.table,
      })
        .then((value) => {
          if (active) setIndexCaps(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [tab.id, draft.schema, draft.table]);
  useEffect(() => {
    if (draft.kind !== 'view') return;
    let active = true;
    void command<ViewCapabilities>('view.options', {
      connectionId: tab.connectionId,
      database: tab.database,
    })
      .then((value) => {
        if (active) setViewCaps(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [tab.id]);
  useEffect(() => {
    if (draft.kind !== 'table') return;
    let active = true;
    void command<GenerationCapabilities>('generation.options', {
      connectionId: tab.connectionId,
      database: tab.database,
    })
      .then((value) => {
        if (active) setGenerationCaps(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [tab.id]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [plan, setPlan] = useState<DatabaseObjectPlan>(),
    [created, setCreated] = useState(tab.objectVersion === 'created');
  const change = (patch: Partial<CreateObjectInput>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setPlan(undefined);
    setError('');
    void command('workspace.update', {
      id: tab.id,
      patch: { sql: JSON.stringify(next), dirty: true },
    }).catch((e) => setError(e.message));
  };
  useEffect(() => {
    let stale = false;
    void command<string[]>('schema.list', {
      connectionId: tab.connectionId,
      database: tab.database,
    })
      .then((items) => {
        if (!stale) setSchemas(items);
      })
      .catch((e) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [tab.id]);
  useEffect(() => {
    let stale = false;
    setTables([]);
    void command<TableInfo[]>('table.list', {
      connectionId: tab.connectionId,
      database: tab.database,
      schema: draft.schema,
    })
      .then((items) => {
        if (!stale) setTables(items);
      })
      .catch((e) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [tab.id, draft.schema]);
  useEffect(() => {
    let stale = false;
    setColumns([]);
    if (draft.kind === 'index' && draft.table)
      void command<Column[]>('table.describe', {
        connectionId: tab.connectionId,
        database: tab.database,
        schema: draft.schema,
        table: draft.table,
      })
        .then((items) => {
          if (!stale) setColumns(items);
        })
        .catch((e) => {
          if (!stale) setError(e.message);
        });
    return () => {
      stale = true;
    };
  }, [tab.id, draft.schema, draft.table]);
  const perform = async (apply: boolean) => {
    setBusy(true);
    setError('');
    try {
      const result = await command<DatabaseObjectPlan>(
        apply ? 'object.create' : 'object.create_preview',
        draft,
      );
      setPlan(result);
      if (apply) {
        setCreated(true);
        await command('workspace.update', {
          id: tab.id,
          patch: {
            dirty: false,
            objectVersion: 'created',
            sql: JSON.stringify(draft),
            title: `${draft.kind}: ${draft.name}`,
          },
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const target = tables.find((item) => item.name === draft.table);
  const timings =
    connection.engine === 'mysql'
      ? ['BEFORE', 'AFTER']
      : target?.kind === 'view'
        ? ['INSTEAD OF']
        : connection.engine === 'sybase'
          ? ['AFTER']
          : connection.engine === 'sqlserver'
            ? ['AFTER', 'INSTEAD OF']
            : ['BEFORE', 'AFTER'];
  const label = {
    table: 'Create table',
    view: 'Create view',
    index: 'Create index',
    trigger: 'Create trigger',
  }[draft.kind];
  return (
    <section className="database-object-view create-object-view" aria-label={t(label)}>
      <div className="toolbar">
        <strong>{t(label)}</strong>
        <small>{connection.engine}</small>
        <span className="spacer" />
        <Button variant="outline" disabled={busy || created} onClick={() => void perform(false)}>
          {t('Preview SQL')}
        </Button>
        <Button
          variant="default"
          className="primary"
          disabled={busy || created || !plan}
          onClick={() => void perform(true)}
        >
          {t('Create object')}
        </Button>
        {created && (
          <Button
            variant="outline"
            onClick={() =>
              void command(
                ['table', 'view'].includes(draft.kind) ? 'app.open_table' : 'app.open_object',
                {
                  connectionId: draft.connectionId,
                  database: draft.database,
                  schema: draft.schema,
                  table: ['table', 'view'].includes(draft.kind) ? draft.name : draft.table,
                  ...(['index', 'trigger'].includes(draft.kind)
                    ? { type: draft.kind, objectName: draft.name }
                    : {}),
                },
              ).catch((e) => setError(e.message))
            }
          >
            {t('Open created object')}
          </Button>
        )}
      </div>
      <div className="database-object-content">
        {error && (
          <Alert className="notice" role="alert">
            {t(error)}
          </Alert>
        )}
        {created && (
          <Alert className="notice" role="status">
            {t('Object created.')}
          </Alert>
        )}
        <Fieldset disabled={busy || created} className="create-object-form">
          <div className="toolbar">
            <Label>
              {t('Schema')}
              <SelectField
                aria-label={t('Schema')}
                value={draft.schema}
                onValueChange={(e) => change({ schema: e, table: '', indexColumns: [] })}
              >
                {Array.from(new Set([draft.schema, ...schemas])).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </SelectField>
            </Label>
            <Label>
              {t('Object name')}
              <Input
                aria-label={t('Object name')}
                value={draft.name}
                onChange={(e) => change({ name: e.target.value })}
              />
            </Label>
          </div>
          {draft.kind === 'table' && (
            <>
              <div className="create-columns">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {[
                        'Name',
                        'Data type',
                        'Length / precision',
                        'Decimal places',
                        'Nullable',
                        'Primary key',
                        'Default SQL',
                        'Remove',
                      ].map((label) => (
                        <TableHead key={label}>{t(label)}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {draft.columns.map((column, index) => (
                      <TableRow key={index}>
                        <TableCell>
                          <Input
                            aria-label={`${t('Column name')} ${index + 1}`}
                            value={column.name}
                            onChange={(e) =>
                              change({
                                columns: draft.columns.map((item, position) =>
                                  position === index ? { ...item, name: e.target.value } : item,
                                ),
                              })
                            }
                          />
                        </TableCell>
                        <ColumnTypeEditor
                          engine={connection.engine}
                          value={column.type}
                          disabled={
                            busy ||
                            created ||
                            (!!column.generation && !!generationCaps?.inferredType)
                          }
                          column={column.name || String(index + 1)}
                          onChange={(type) =>
                            change({
                              columns: draft.columns.map((item, position) =>
                                position === index ? { ...item, type } : item,
                              ),
                            })
                          }
                        />
                        <TableCell>
                          <Checkbox
                            aria-label={`${t('Nullable')} ${index + 1}`}
                            checked={column.nullable && !column.primaryKey}
                            disabled={column.primaryKey || !!column.generation}
                            onCheckedChange={(e) =>
                              change({
                                columns: draft.columns.map((item, position) =>
                                  position === index ? { ...item, nullable: e } : item,
                                ),
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Checkbox
                            aria-label={`${t('Primary key')} ${index + 1}`}
                            checked={column.primaryKey}
                            disabled={!!column.generation}
                            onCheckedChange={(e) =>
                              change({
                                columns: draft.columns.map((item, position) =>
                                  position === index ? { ...item, primaryKey: e } : item,
                                ),
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            aria-label={`${t('Default SQL')} ${index + 1}`}
                            value={column.defaultSql}
                            disabled={!!column.generation}
                            onChange={(e) =>
                              change({
                                columns: draft.columns.map((item, position) =>
                                  position === index
                                    ? { ...item, defaultSql: e.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            onClick={() =>
                              change({
                                columns: draft.columns.filter((_, position) => position !== index),
                              })
                            }
                          >
                            {t('Remove')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  change({
                    columns: [
                      ...draft.columns,
                      {
                        name: '',
                        type: 'varchar(255)',
                        nullable: true,
                        primaryKey: false,
                        defaultSql: '',
                      },
                    ],
                  })
                }
              >
                {t('Add column')}
              </Button>
              {!!generationCaps?.modes.length && (
                <Fieldset className="column-properties">
                  <legend>{t('Generated columns')}</legend>
                  {draft.columns.map((column, index) => (
                    <div key={index} className="column-property-grid">
                      <Label>
                        {column.name || t('Unnamed column')}
                        <Checkbox
                          aria-label={`${t('Generated column')} ${index + 1}`}
                          checked={!!column.generation}
                          onCheckedChange={(enabled) =>
                            change({
                              columns: draft.columns.map((item, position) =>
                                position === index
                                  ? {
                                      ...item,
                                      generation: enabled
                                        ? { expression: '', storage: generationCaps.modes[0] }
                                        : undefined,
                                      ...(enabled
                                        ? { defaultSql: '', primaryKey: false, nullable: true }
                                        : {}),
                                    }
                                  : item,
                              ),
                            })
                          }
                        />
                      </Label>
                      {column.generation && (
                        <GenerationFields
                          value={column.generation}
                          capabilities={generationCaps}
                          suffix={` ${index + 1}`}
                          onChange={(generation) =>
                            change({
                              columns: draft.columns.map((item, position) =>
                                position === index ? { ...item, generation } : item,
                              ),
                            })
                          }
                        />
                      )}
                    </div>
                  ))}
                </Fieldset>
              )}
            </>
          )}
          {draft.kind === 'view' && (
            <Tabs defaultValue="definition" className="create-view-tabs object-designer">
              <TabsList className="designer-tabs" aria-label={t('View design sections')}>
                <TabsTrigger value="definition">{t('Definition')}</TabsTrigger>
                {viewCaps && !!(viewCaps.checkOptions.length || viewCaps.algorithms.length) && (
                  <TabsTrigger value="advanced">{t('Advanced')}</TabsTrigger>
                )}
              </TabsList>
              <TabsContent value="definition">
                <Label>
                  {t('SELECT query')}
                  <Textarea
                    aria-label={t('SELECT query')}
                    rows={12}
                    value={draft.selectSql}
                    onChange={(e) => change({ selectSql: e.target.value })}
                  />
                </Label>
              </TabsContent>
              <TabsContent value="advanced">
                {viewCaps && (
                  <ViewOptionsForm
                    value={draft.viewOptions ?? {}}
                    capabilities={viewCaps}
                    onChange={(viewOptions) => change({ viewOptions })}
                  />
                )}
              </TabsContent>
            </Tabs>
          )}
          {['index', 'trigger'].includes(draft.kind) && (
            <Label>
              {t('Target table / view')}
              <SelectField
                aria-label={t('Target table / view')}
                value={draft.table}
                onValueChange={(e) => {
                  const isView = tables.find((item) => item.name === e)?.kind === 'view';
                  change({
                    table: e,
                    indexColumns: [],
                    timing: isView ? 'INSTEAD OF' : 'AFTER',
                  });
                }}
              >
                <option value="">{t('Select a target')}</option>
                {tables
                  .filter((item) =>
                    draft.kind === 'index' || connection.engine === 'mysql'
                      ? item.kind === 'table'
                      : true,
                  )
                  .map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name} ({item.kind})
                    </option>
                  ))}
              </SelectField>
            </Label>
          )}
          {draft.kind === 'index' && (
            <>
              {indexCaps && (
                <IndexOptionsForm
                  value={{ type: draft.unique ? 'UNIQUE' : 'NORMAL', ...draft.indexOptions }}
                  capabilities={indexCaps}
                  onChange={(indexOptions) =>
                    change({ indexOptions, unique: indexOptions.type === 'UNIQUE' })
                  }
                />
              )}
              <p>{t('Select columns in index order.')}</p>
              {columns.map((column) => {
                const current = draft.indexColumns.find((item) => item.name === column.name);
                return (
                  <div className="toolbar" key={column.name}>
                    <Label>
                      <Checkbox
                        checked={!!current}
                        onCheckedChange={(e) =>
                          change({
                            indexColumns: e
                              ? [...draft.indexColumns, { name: column.name, descending: false }]
                              : draft.indexColumns.filter((item) => item.name !== column.name),
                          })
                        }
                      />
                      {column.name}
                    </Label>
                    {current && (
                      <>
                        <span>#{draft.indexColumns.indexOf(current) + 1}</span>
                        <SelectField
                          aria-label={`${column.name} ${t('Sort order')}`}
                          value={current.descending ? 'DESC' : 'ASC'}
                          onValueChange={(e) =>
                            change({
                              indexColumns: draft.indexColumns.map((item) =>
                                item.name === column.name
                                  ? { ...item, descending: e === 'DESC' }
                                  : item,
                              ),
                            })
                          }
                        >
                          <option>ASC</option>
                          <option>DESC</option>
                        </SelectField>
                      </>
                    )}
                  </div>
                );
              })}
            </>
          )}
          {draft.kind === 'trigger' && (
            <>
              <div className="toolbar">
                <Label>
                  {t('Timing')}
                  <SelectField
                    aria-label={t('Timing')}
                    value={draft.timing}
                    onValueChange={(e) => change({ timing: e as CreateObjectInput['timing'] })}
                  >
                    {timings.map((timing) => (
                      <option key={timing}>{timing}</option>
                    ))}
                  </SelectField>
                </Label>
                <Label>
                  {t('Event')}
                  <SelectField
                    aria-label={t('Event')}
                    value={draft.event}
                    onValueChange={(e) => change({ event: e as CreateObjectInput['event'] })}
                  >
                    {['INSERT', 'UPDATE', 'DELETE'].map((event) => (
                      <option key={event}>{event}</option>
                    ))}
                  </SelectField>
                </Label>
              </div>
              {connection.engine === 'postgres' && (
                <>
                  <Label>
                    <Checkbox
                      checked={draft.createFunction}
                      onCheckedChange={(e) => change({ createFunction: e })}
                    />
                    {t('Create a trigger function in the same transaction')}
                  </Label>
                  <Label>
                    {t('Function name')}
                    <Input
                      aria-label={t('Function name')}
                      placeholder={draft.name + '_fn'}
                      value={draft.functionName}
                      onChange={(e) => change({ functionName: e.target.value })}
                    />
                  </Label>
                  <Label>
                    {t('Function schema')}
                    <Input
                      value={draft.functionSchema}
                      placeholder={draft.schema}
                      onChange={(e) => change({ functionSchema: e.target.value })}
                    />
                  </Label>
                </>
              )}
              <p>
                {t(
                  connection.engine === 'postgres'
                    ? 'PostgreSQL row trigger: return NEW for INSERT/UPDATE, OLD for DELETE. Existing functions are never replaced.'
                    : ['sqlserver', 'sybase'].includes(connection.engine)
                      ? 'SQL Server statement trigger: use inserted/deleted sets; a statement can affect multiple rows.'
                      : connection.engine === 'mysql'
                        ? 'MySQL / MariaDB row trigger: use NEW/OLD. DDL commits implicitly.'
                        : 'SQLite row trigger: use NEW/OLD; views require INSTEAD OF.',
                )}
              </p>
              {(connection.engine !== 'postgres' || draft.createFunction) && (
                <Label>
                  {t('Trigger body')}
                  <small>
                    {t('Enter statements only; BEGIN/END are generated. Omit GO and DELIMITER.')}
                  </small>
                  <Textarea
                    aria-label={t('Trigger body')}
                    rows={10}
                    value={draft.body}
                    onChange={(e) => change({ body: e.target.value })}
                  />
                </Label>
              )}
            </>
          )}
        </Fieldset>
        {plan && (
          <section className="create-preview">
            <h3>{t('SQL preview')}</h3>
            <p>{t(plan.notice)}</p>
            <pre>{plan.statements.join(';\n\n')}</pre>
          </section>
        )}
      </div>
    </section>
  );
}
