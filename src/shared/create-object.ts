import { z } from 'zod';
import { generationSchema } from './generated-columns';
import { viewOptionsSchema } from './view-options';
import { indexOptionsSchema } from './index-options';
const name = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('\0'), 'Invalid SQL identifier.');
export const createObjectSchema = z
  .object({
    connectionId: z.string().min(1),
    database: z.string().optional(),
    schema: name,
    kind: z.enum(['table', 'view', 'index', 'trigger']),
    name,
    table: z.string().max(128).default(''),
    columns: z
      .array(
        z.object({
          name,
          type: z.string().min(1).max(4096),
          nullable: z.boolean(),
          primaryKey: z.boolean(),
          defaultSql: z.string().max(65536).default(''),
          generation: generationSchema.optional(),
        }),
      )
      .max(256)
      .default([]),
    selectSql: z.string().max(524288).default(''),
    viewOptions: viewOptionsSchema.optional(),
    indexOptions: indexOptionsSchema.optional(),
    indexColumns: z
      .array(z.object({ name, descending: z.boolean() }))
      .max(64)
      .default([]),
    unique: z.boolean().default(false),
    timing: z.enum(['BEFORE', 'AFTER', 'INSTEAD OF']).default('AFTER'),
    event: z.enum(['INSERT', 'UPDATE', 'DELETE']).default('INSERT'),
    body: z.string().max(524288).default(''),
    createFunction: z.boolean().default(true),
    functionSchema: z.string().max(128).default(''),
    functionName: z.string().max(128).default(''),
  })
  .strict();
export type CreateObjectInput = z.infer<typeof createObjectSchema>;
