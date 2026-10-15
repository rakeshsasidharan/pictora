import { defineConfig } from 'vitest/config';

// Unit tests for the suite's own helpers. The Playwright specs in `specs/` run only with `npm run e2e`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
