import { Fieldset as FieldsetPrimitive } from '@base-ui/react/fieldset';
// Base UI propagates disabled state to custom controls as well as native inputs.
export function Fieldset(props: FieldsetPrimitive.Root.Props) {
  return <FieldsetPrimitive.Root data-slot="fieldset" {...props} />;
}
