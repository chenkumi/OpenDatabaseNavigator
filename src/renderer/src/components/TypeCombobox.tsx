import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from './ui/combobox';
import { useI18n } from '../i18n';
export function TypeCombobox({
  id,
  label,
  value,
  items,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  items: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const t = useI18n();
  return (
    <Combobox
      modal={false}
      items={items}
      inputValue={value}
      value={value}
      disabled={disabled}
      onInputValueChange={(next, details) => {
        if (details.reason === 'input-change') onChange(next);
      }}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <ComboboxInput id={id} aria-label={label} disabled={disabled} />
      <ComboboxContent>
        <ComboboxEmpty>{t('No matching types. Custom types are allowed.')}</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
