import { z } from 'zod';
import type { Engine } from './types';

const localeName = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid locale name.');

export const databaseOptionName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/);
export const databaseCreateOptionsSchema = z.object({
  charset: databaseOptionName.optional(),
  collation: databaseOptionName.optional(),
  localeProvider: z.enum(['libc', 'icu', 'builtin']).optional(),
  locale: localeName.optional(),
  lcCtype: localeName.optional(),
});
export const databasePropertyChangeSchema = databaseCreateOptionsSchema
  .pick({ charset: true, collation: true })
  .strict();
export type DatabasePropertyChange = z.infer<typeof databasePropertyChangeSchema>;
export type DatabaseCreateOptions = z.infer<typeof databaseCreateOptionsSchema>;
export interface DatabaseOptions {
  charsets: string[];
  collations: { name: string; charset?: string }[];
  postgres?: {
    version: number;
    providers: ('libc' | 'icu' | 'builtin')[];
    locales: { provider: 'libc' | 'icu' | 'builtin'; name: string; encoding?: string }[];
  };
}
export interface DatabaseProperties {
  engine: Engine;
  database: string;
  charset?: string;
  collation?: string;
  localeProvider?: string;
  locale?: string;
  lcCtype?: string;
  version: string;
  editable: { charset: boolean; collation: boolean };
  notice: string;
}
