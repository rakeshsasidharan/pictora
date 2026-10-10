import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesising whole stages copies assets on disk, which can pass 5 s on a busy runner.
    testTimeout: 30_000,
  },
});
