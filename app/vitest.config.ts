import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSource = (file: string) =>
  fileURLToPath(new URL(`../packages/core/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against core's source, so tests don't need core built first.
    alias: [
      { find: /^@pictora\/core$/, replacement: coreSource('index.ts') },
      { find: /^@pictora\/core\/registry-store$/, replacement: coreSource('registry_store.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
