import { z } from 'zod';
const text = z
  .string()
  .max(65536)
  .refine((value) => !value.includes('\0'), 'NUL is not allowed.');
const option = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'), 'Invalid option.');
export const tablePropertiesSchema = z
  .object({
    storageEngine: option.optional(),
    charset: option.optional(),
    collation: option.optional(),
    comment: text.optional(),
  })
  .strict();
export const columnPropertiesSchema = z
  .object({
    charset: option.optional(),
    collation: option.optional(),
    binary: z.boolean().optional(),
    comment: text.optional(),
  })
  .strict();
export type TableProperties = z.infer<typeof tablePropertiesSchema>;
export type ColumnProperties = z.infer<typeof columnPropertiesSchema>;
export type PropertyChange =
  | { action: 'table-properties'; properties: TableProperties }
  | { action: 'column-properties'; column: string; properties: ColumnProperties };
export interface StructurePropertyOptions {
  table: { storageEngine: boolean; charset: boolean; collation: boolean; comment: boolean };
  column: { charset: boolean; collation: boolean; binary: boolean; comment: boolean };
  storageEngines: string[];
  charsets: string[];
  collations: { name: string; charset?: string }[];
  defaultCollations: Record<string, string>;
}
