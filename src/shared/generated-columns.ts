import { z } from 'zod';
export const generationSchema = z
  .object({
    expression: z.string().min(1).max(65536),
    storage: z.enum(['virtual', 'stored']),
  })
  .strict();
export type Generation = z.infer<typeof generationSchema>;
export interface GenerationCapabilities {
  modes: Generation['storage'][];
  editExpression: boolean;
  changeStorage: boolean;
  inferredType: boolean;
}
export type GeneratedChange =
  | { action: 'generated-add'; name: string; type: string; generation: Generation }
  | { action: 'generated-edit'; column: string; generation: Generation };
