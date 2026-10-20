import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSource = (file: string) =>
  fileURLToPath(new URL(`../packages/core/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against core's and providers' source, so tests don't need them built first.
    alias: [
      { find: /^@pictora\/core$/, replacement: coreSource('index.ts') },
      { find: /^@pictora\/core\/registry-store$/, replacement: coreSource('registry_store.ts') },
      { find: /^@pictora\/core\/observability$/, replacement: coreSource('observability.ts') },
      { find: /^@pictora\/core\/block-store$/, replacement: coreSource('block_store.ts') },
      {
        find: /^@pictora\/providers\/text$/,
        replacement: fileURLToPath(new URL('../packages/providers/src/text.ts', import.meta.url)),
      },
      {
        find: /^@pictora\/providers\/image$/,
        replacement: fileURLToPath(new URL('../packages/providers/src/image.ts', import.meta.url)),
      },
    ],
  },
  test: {
    // Powertools would write log lines and metrics to stdout; tests capture what they need themselves.
    env: { POWERTOOLS_LOG_LEVEL: 'SILENT', POWERTOOLS_METRICS_DISABLED: 'true' },
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
