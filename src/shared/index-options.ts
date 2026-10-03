import { z } from 'zod';
export const indexOptionsSchema = z
  .object({
    type: z.enum(['NORMAL', 'UNIQUE', 'FULLTEXT', 'SPATIAL']).optional(),
    method: z.string().max(128).optional(),
    comment: z
      .string()
      .max(65536)
      .refine((v) => !v.includes('\0'), 'Invalid index comment.')
      .optional(),
  })
  .strict();
export type IndexOptions = z.infer<typeof indexOptionsSchema>;
export interface IndexCapabilities {
  defaultMethod: string;
  types: NonNullable<IndexOptions['type']>[];
  methods: { name: string; unique: boolean; ordered: boolean }[];
  comment: boolean;
}
