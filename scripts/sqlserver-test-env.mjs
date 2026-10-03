import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

// An optional, workspace-local Save-Module install is used only by test hosts.
// Production discovers modules through the user's normal PowerShell setup.
export function sqlServerTestEnv(env = process.env) {
  const modules = resolve('.local/powershell-modules');
  return existsSync(resolve(modules, 'SqlServer'))
    ? { ...env, PSModulePath: modules + delimiter + (env.PSModulePath || '') }
    : { ...env };
}
