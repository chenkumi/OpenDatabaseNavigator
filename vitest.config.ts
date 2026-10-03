import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Whole-suite runs execute many files in parallel; the 5 s default makes
  // process-spawning and export tests time out under load.
  test: { testTimeout: 20_000, hookTimeout: 30_000 },
});
