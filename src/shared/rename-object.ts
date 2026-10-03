import { z } from 'zod';
import { dropObjectSchema, type DropObjectPlan } from './drop-object';

export const renameObjectSchema = dropObjectSchema
  .extend({
    newName: z
      .string()
      .min(1)
      .max(128)
      .refine(
        (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
        'Invalid object name.',
      ),
  })
  .strict();
export type RenameObjectInput = z.infer<typeof renameObjectSchema>;
export interface RenameObjectPlan extends DropObjectPlan {
  notice: string;
  atomic: boolean;
}
