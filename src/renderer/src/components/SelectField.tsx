import { Children, Fragment, isValidElement, type ReactNode, type ComponentProps } from 'react';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';

// A compact application-level composition of the shadcn Base UI Select.
// Options remain declarative; callbacks receive values, never synthetic DOM events.
export function SelectField({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled,
  name,
  ...props
}: Omit<ComponentProps<typeof SelectTrigger>, 'value' | 'defaultValue' | 'onChange'> & {
  value?: string | number;
  defaultValue?: string | number;
  onValueChange?: (value: string) => void;
  children?: ReactNode;
  name?: string;
}) {
  const options: { value: string; label: ReactNode; disabled?: boolean }[] = [];
  function collect(nodes: ReactNode) {
    Children.forEach(nodes, (child) => {
      if (
        !isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(
          child,
        )
      )
        return;
      if (child.type === Fragment) collect(child.props.children);
      else
        options.push({
          value: String(child.props.value ?? child.props.children ?? ''),
          label: child.props.children,
          disabled: child.props.disabled,
        });
    });
  }
  collect(children);
  return (
    <Select
      items={options}
      value={value === undefined ? undefined : String(value)}
      defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
      disabled={disabled}
      name={name}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(next);
      }}
    >
      <SelectTrigger {...props}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            data-value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
