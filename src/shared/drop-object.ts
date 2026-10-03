import { z } from 'zod';
import type { Engine, WorkspaceTab } from './types';

export const dropObjectSchema = z
  .object({
    connectionId: z.string().min(1),
    database: z.string().min(1).optional(),
    schema: z.string().min(1).max(1024),
    objectName: z.string().min(1).max(1024),
    table: z.string().max(1024).default(''),
    kind: z.enum(['table', 'view', 'index', 'trigger']),
  })
  .strict();
export type DropObjectRef = z.infer<typeof dropObjectSchema>;
export interface DropObjectPlan {
  engine: Engine;
  statements: string[];
  version: string;
  ownedObjects: string[];
  /** Other tables whose rows change through foreign key actions when this is dropped. */
  dependents: string[];
  tabs: { id: string; title: string; dirty: boolean }[];
}
export function matchesDroppedObject(tab: WorkspaceTab, ref: DropObjectRef, defaultSchema: string) {
  if (
    tab.connectionId !== ref.connectionId ||
    tab.database !== ref.database ||
    (tab.schema ?? defaultSchema) !== ref.schema
  )
    return false;
  if (ref.kind === 'table' || ref.kind === 'view')
    return ['table', 'index', 'trigger'].includes(tab.type) && tab.table === ref.objectName;
  return tab.type === ref.kind && tab.objectName === ref.objectName && tab.table === ref.table;
}
