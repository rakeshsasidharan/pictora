import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(`../packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against the packages' source, so tests don't need them built first.
    alias: [
      { find: /^@pictora\/core$/, replacement: source('core/src/index.ts') },
      {
        find: /^@pictora\/core\/registry-store$/,
        replacement: source('core/src/registry_store.ts'),
      },
      { find: /^@pictora\/core\/block-store$/, replacement: source('core/src/block_store.ts') },
      { find: /^@pictora\/providers$/, replacement: source('providers/src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
