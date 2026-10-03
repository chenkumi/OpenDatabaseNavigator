import { stat } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import type { Connection } from '../../../../shared/types';

export async function aseToolFile(path: string | undefined, names: string[], label: string) {
  if (!path || !isAbsolute(path) || !names.includes(basename(path).toLowerCase()))
    throw new Error(`ASE requires an absolute path to ${label}.`);
  if (!(await stat(path).catch(() => undefined))?.isFile())
    throw new Error(`ASE cannot find ${label}.`);
  // Only jar files are placed on a class path, where the separator is significant.
  if ((path.endsWith('.jar') && path.includes(delimiter)) || /[\r\n\0]/.test(path))
    throw new Error(`Invalid ASE tool path for ${label}.`);
  return path;
}

export async function aseJavaTools(connection: Connection) {
  let java = connection.aseJavaPath;
  if (!java) {
    const name = process.platform === 'win32' ? 'java.exe' : 'java';
    const directories = [
      process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin'),
      ...(process.env.PATH || '').split(delimiter),
    ];
    for (const directory of directories) {
      if (
        directory &&
        isAbsolute(directory) &&
        (await stat(join(directory, name)).catch(() => undefined))?.isFile()
      ) {
        java = join(directory, name);
        break;
      }
    }
  }
  return {
    java: await aseToolFile(java, ['java', 'java.exe'], 'Java (java.exe or java)'),
    jdbc: await aseToolFile(connection.aseJconnectPath, ['jconn4.jar'], 'SAP jconn4.jar'),
  };
}
