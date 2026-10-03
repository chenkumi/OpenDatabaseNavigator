import { useState } from 'react';
import { X } from 'lucide-react';
import type { Column, Filter, FilterOperator } from '../../../shared/types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SelectField } from './SelectField';
import { useI18n } from '../i18n';

type Draft = { column: string; operator: FilterOperator; value: string };
const empty = (): Draft => ({ column: '', operator: '=', value: '' });
export function TableFilters({
  columns,
  applied,
  disabled,
  onApply,
}: {
  columns: Column[];
  applied: Filter[];
  disabled: boolean;
  onApply: (filters: Filter[]) => void;
}) {
  const t = useI18n();
  const [drafts, setDrafts] = useState<Draft[]>([empty()]);
  const patch = (index: number, update: Partial<Draft>) =>
    setDrafts(drafts.map((draft, i) => (i === index ? { ...draft, ...update } : draft)));
  const setFilters = (filters: Filter[]) => {
    setDrafts(
      filters.length
        ? filters.map((filter) => ({ ...filter, value: String(filter.value ?? '') }))
        : [empty()],
    );
    onApply(filters);
  };
  const apply = () =>
    onApply(
      drafts.map((draft) =>
        draft.operator.includes('NULL')
          ? { column: draft.column, operator: draft.operator }
          : { ...draft },
      ),
    );
  return (
    <form
      className="table-filters"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && drafts.every((draft) => draft.column)) apply();
      }}
    >
      <div className="filter-rows">
        {drafts.map((draft, index) => (
          <div className="filter-row" key={index}>
            <span className="muted">{index ? 'AND' : t('Filter')}</span>
            <SelectField
              aria-label={
                index ? t('Filter column {index}', { index: index + 1 }) : t('Filter column')
              }
              value={draft.column}
              disabled={disabled}
              onValueChange={(column) => patch(index, { column })}
            >
              <option value="">{t('Filter column…')}</option>
              {columns.map((column) => (
                <option key={column.name}>{column.name}</option>
              ))}
            </SelectField>
            <SelectField
              aria-label={
                index ? t('Filter operator {index}', { index: index + 1 }) : t('Filter operator')
              }
              value={draft.operator}
              disabled={disabled}
              onValueChange={(operator) => patch(index, { operator: operator as FilterOperator })}
            >
              {['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IS NULL', 'IS NOT NULL'].map(
                (operator) => (
                  <option key={operator}>{operator}</option>
                ),
              )}
            </SelectField>
            <Input
              aria-label={
                index ? t('Filter value {index}', { index: index + 1 }) : t('Filter value')
              }
              placeholder={t('Value')}
              disabled={disabled || draft.operator.includes('NULL')}
              value={draft.value}
              onChange={(event) => patch(index, { value: event.target.value })}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('Remove condition {index}', { index: index + 1 })}
              disabled={disabled}
              onClick={() =>
                setDrafts(drafts.length === 1 ? [empty()] : drafts.filter((_, i) => i !== index))
              }
            >
              <X />
            </Button>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <Button
          variant="outline"
          disabled={disabled || drafts.length >= 30}
          onClick={() => setDrafts([...drafts, empty()])}
        >
          {t('Add condition')}
        </Button>
        <Button
          variant="default"
          type="submit"
          disabled={disabled || !drafts.every((draft) => draft.column)}
        >
          {t('Apply')}
        </Button>
        <Button
          variant="outline"
          disabled={
            disabled || (!applied.length && !drafts.some((draft) => draft.column || draft.value))
          }
          onClick={() => setFilters([])}
        >
          {t('Clear filter')}
        </Button>
        <span className="muted">{t('All conditions must match (AND)')}</span>
      </div>
      {!!applied.length && (
        <div className="applied-filter" role="status">
          <span>{t('Applied filter')}:</span>
          {applied.map((filter, index) => (
            <span className="filter-chip" key={index}>
              {index > 0 && <span className="muted">AND</span>}
              <span>
                {filter.column} {filter.operator}{' '}
                {filter.operator.includes('NULL') ? '' : String(filter.value)}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={t('Remove applied condition {index}', { index: index + 1 })}
                onClick={() => setFilters(applied.filter((_, i) => i !== index))}
              >
                <X />
              </Button>
            </span>
          ))}
        </div>
      )}
    </form>
  );
}
