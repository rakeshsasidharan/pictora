import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against core's source, so tests don't need core built first.
    alias: { '@pictora/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
