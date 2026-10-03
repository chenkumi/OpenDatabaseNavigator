import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { ViewOptionsForm } from './ViewOptionsForm';
import { useI18n } from '../i18n';
import type { StructureChange, TableStructure } from '../../../shared/types';
import type { ViewOptions } from '../../../shared/view-options';

export function ViewDesigner({
  id,
  detail,
  change,
  disabled,
  onChange,
}: {
  id: string;
  detail: TableStructure;
  change?: StructureChange;
  disabled: boolean;
  onChange: (change?: StructureChange) => void;
}) {
  const t = useI18n();
  const capabilities = detail.viewCapabilities;
  const advanced =
    !!capabilities && !!(capabilities.checkOptions.length || capabilities.algorithms.length);
  return (
    <Tabs
      defaultValue={change?.action === 'view-options' ? 'advanced' : 'definition'}
      className="view-designer object-designer"
    >
      <TabsList className="designer-tabs" aria-label={t('View design sections')}>
        <TabsTrigger value="definition">{t('Definition')}</TabsTrigger>
        <TabsTrigger value="columns">{t('Columns')}</TabsTrigger>
        {advanced && <TabsTrigger value="advanced">{t('Advanced')}</TabsTrigger>}
      </TabsList>
      <TabsContent value="definition" className="designer-section">
        <Label className="object-definition-label" htmlFor={`view-${id}`}>
          {t('View definition')}
        </Label>
        <Textarea
          id={`view-${id}`}
          className="object-definition-editor"
          spellCheck={false}
          readOnly={disabled || (!!change && change.action !== 'view')}
          value={change?.action === 'view' ? change.sql : detail.definition}
          onChange={(event) =>
            onChange(
              event.target.value === detail.definition
                ? undefined
                : { action: 'view', sql: event.target.value },
            )
          }
        />
        {advanced && (
          <p className="editor-help">
            {t('Apply or revert pending changes before switching between SQL and view options.')}
          </p>
        )}
      </TabsContent>
      <TabsContent value="columns" className="designer-section">
        <Table>
          <TableHeader>
            <TableRow>
              {['Column', 'Type', 'Nullable'].map((label) => (
                <TableHead key={label}>{t(label)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.columns.map((column) => (
              <TableRow key={column.name}>
                <TableCell>{column.name}</TableCell>
                <TableCell>{column.type}</TableCell>
                <TableCell>{t(column.nullable ? 'Yes' : 'No')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TabsContent>
      {advanced && (
        <TabsContent value="advanced" className="designer-section">
          <ViewOptionsForm
            value={{
              ...detail.viewOptions,
              ...(change?.action === 'view-options' ? change.options : {}),
            }}
            capabilities={capabilities}
            disabled={disabled || (!!change && change.action !== 'view-options')}
            onChange={(next) => {
              const options = Object.fromEntries(
                Object.entries(next).filter(
                  ([key, value]) =>
                    JSON.stringify(value) !==
                    JSON.stringify(detail.viewOptions?.[key as keyof ViewOptions]),
                ),
              ) as ViewOptions;
              onChange(
                Object.keys(options).length ? { action: 'view-options', options } : undefined,
              );
            }}
          />
          <p className="editor-help">
            {t('Apply or revert pending changes before switching between SQL and view options.')}
          </p>
        </TabsContent>
      )}
    </Tabs>
  );
}
