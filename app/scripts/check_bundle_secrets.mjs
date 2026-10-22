// Fails the build when anything that looks like a secret reaches the browser (#28, tech design 12). Run with
// `npm run check:secrets --workspace @pictora/app` after `next build`; CI runs it after the build step.
//
// It scans what the browser can download: the client bundles in `.next/static`, and the prerendered HTML and
// RSC payloads in `.next/server/app`. Server-only code stays on the server, so it isn't scanned.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Patterns for keys that must never be public. Each matches the key's documented shape. */
export const SECRET_PATTERNS = [
  { name: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Google OAuth client secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/ },
  { name: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    name: 'AWS secret access key',
    pattern: /aws_?secret_?access_?key["'\s:=]+[A-Za-z0-9/+]{40}\b/i,
  },
  { name: 'Private key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'Google service account key', pattern: /"type"\s*:\s*"service_account"/ },
];

/** The files a browser can fetch, relative to `.next`. */
const SCANNED = [
  { dir: 'static', extensions: ['.js', '.css', '.json', '.html', '.txt', '.map'] },
  { dir: join('server', 'app'), extensions: ['.html', '.rsc', '.body', '.meta'] },
];

/** Every secret-like match in the text, by pattern name, with the match shortened so the log can't leak it. */
export function findSecrets(text) {
  return SECRET_PATTERNS.flatMap(({ name, pattern }) => {
    const match = pattern.exec(text);
    return match ? [{ name, excerpt: `${match[0].slice(0, 8)}…` }] : [];
  });
}

async function* files(dir, extensions) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path, extensions);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) yield path;
  }
}

/** Scans the build in `nextDir`; resolves to the findings and how many files were read. */
export async function scanBuild(nextDir) {
  const findings = [];
  let scanned = 0;
  for (const { dir, extensions } of SCANNED) {
    for await (const path of files(join(nextDir, dir), extensions)) {
      scanned += 1;
      for (const finding of findSecrets(await readFile(path, 'utf8'))) {
        findings.push({ file: relative(nextDir, path), ...finding });
      }
    }
  }
  return { findings, scanned };
}

async function main() {
  const nextDir = join(APP_DIR, '.next');
  const { findings, scanned } = await scanBuild(nextDir);
  if (scanned === 0) {
    console.error('No build output in app/.next; run next build first.');
    process.exitCode = 1;
    return;
  }
  for (const { file, name, excerpt } of findings) console.error(`${file}: ${name} (${excerpt})`);
  if (findings.length > 0) {
    console.error(`Found ${findings.length} possible secrets in the client build.`);
    process.exitCode = 1;
  } else {
    console.log(`No secrets in ${scanned} client build files.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
