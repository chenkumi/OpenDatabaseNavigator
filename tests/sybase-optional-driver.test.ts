import { expect, it, vi } from 'vitest';

const loadNative = vi.hoisted(() => vi.fn());
vi.mock('node:module', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:module')>();
  return { ...original, createRequire: () => loadNative };
});

import { SybaseAdapter } from '../src/main/database/adapters/sybase/sybase-adapter';
import { connectionSchema } from '../src/shared/schemas';

it('loads the optional ASE ODBC bridge lazily and reports a missing native dependency', async () => {
  loadNative.mockImplementation(() => {
    throw Object.assign(new Error('Native dependency is unavailable'), { code: 'MODULE_NOT_FOUND' });
  });
  const adapter = new SybaseAdapter({
    ...connectionSchema.parse({ name: 'ASE', engine: 'sybase', host: 'localhost' }),
    id: 'optional-ase',
  });
  expect(loadNative).not.toHaveBeenCalled();
  try {
    await expect(adapter.connect()).rejects.toThrow(
      'Sybase ASE requires the msnodesqlv8 native bridge and SAP ASE ODBC driver for this platform.',
    );
    expect(loadNative).toHaveBeenCalledWith('msnodesqlv8');
  } finally {
    await adapter.disconnect();
  }
});
