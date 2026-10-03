import { z } from 'zod';
const account = z
  .string()
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid account name.');
export const viewOptionsSchema = z
  .object({
    algorithm: z.enum(['UNDEFINED', 'MERGE', 'TEMPTABLE']).optional(),
    definer: z
      .object({ user: account, host: account.min(1) })
      .strict()
      .nullable()
      .optional(),
    security: z.enum(['DEFINER', 'INVOKER']).optional(),
    checkOption: z.enum(['NONE', 'LOCAL', 'CASCADED']).optional(),
  })
  .strict();
export type ViewOptions = z.infer<typeof viewOptionsSchema>;
export interface ViewCapabilities {
  algorithms: NonNullable<ViewOptions['algorithm']>[];
  definer: boolean;
  securityModes: NonNullable<ViewOptions['security']>[];
  checkOptions: NonNullable<ViewOptions['checkOption']>[];
  currentDefiner?: { user: string; host: string };
}
