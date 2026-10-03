import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('\0'), 'Invalid SQL identifier.');
export const referenceActions = [
  'NO ACTION',
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'SET DEFAULT',
] as const;
const action = z.enum(referenceActions);
export const constraintDefinitionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('foreign-key'),
      name: identifier,
      columns: z.array(identifier).min(1).max(64),
      referencedSchema: identifier,
      referencedTable: identifier,
      referencedColumns: z.array(identifier).min(1).max(64),
      onDelete: action,
      onUpdate: action,
    })
    .strict(),
  z
    .object({
      kind: z.literal('check'),
      name: identifier,
      expression: z.string().min(1).max(65536),
      notEnforced: z.boolean(),
    })
    .strict(),
]);
export type ConstraintDefinition = z.infer<typeof constraintDefinitionSchema>;
export type ReferenceAction = (typeof referenceActions)[number];
export interface TableConstraint {
  id: string;
  definition: ConstraintDefinition;
  readOnlyReason?: string;
  source?: { clause: number; start: number; end: number; whole: boolean };
}
export interface ConstraintCapabilities {
  foreignKey: boolean;
  check: boolean;
  notEnforced: boolean;
  actions: ReferenceAction[];
}
export type ConstraintChange =
  | { action: 'constraint-upsert'; id?: string; constraint: ConstraintDefinition }
  | { action: 'constraint-drop'; id: string };
