// Bundles each Lambda handler into one ESM file for the worker image (worker/Dockerfile). sharp stays
// external: it has a native binary, so the image installs it for linux-arm64 next to the bundles.
import { build } from 'esbuild';

/** Handlers in the image; a function picks one with its image command, `<name>.handler`. */
const ENTRY_POINTS = ['generate'];

await build({
  entryPoints: ENTRY_POINTS.map((name) => `src/${name}.ts`),
  outdir: 'dist/lambda',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['sharp'],
  sourcemap: true,
  // Bundled CommonJS dependencies may call require, which ESM doesn't define.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
