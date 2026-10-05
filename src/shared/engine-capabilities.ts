import type { Engine, Risk } from './types';

export const SYBASE_READ_ONLY_REASON =
  'SAP / Sybase ASE is read-only in this release. Writes, DDL, SQL file execution and native SQL export are disabled.';

export function engineReadOnly(engine: Engine) {
  return engine === 'sybase';
}

export function assertEngineRisk(engine: Engine | undefined, risk: Risk) {
  if (engine === 'sybase' && risk !== 'read' && risk !== 'workspace')
    throw new Error(SYBASE_READ_ONLY_REASON);
}

export function assertEngineCommand(engine: Engine | undefined, command: string) {
  if (engine === 'sybase' && ['script.execute', 'export.start'].includes(command))
    throw new Error(SYBASE_READ_ONLY_REASON);
}
