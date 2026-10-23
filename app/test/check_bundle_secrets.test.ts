import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error The script is plain JavaScript, run by Node without a build step.
import { findSecrets, scanBuild } from '../scripts/check_bundle_secrets.mjs';

interface Finding {
  name: string;
  excerpt: string;
  file?: string;
}

const find = findSecrets as (text: string) => Finding[];
const scan = scanBuild as (dir: string) => Promise<{ findings: Finding[]; scanned: number }>;

// Built from parts so this file itself never holds a key-shaped string.
const FAKE = {
  openai: ['sk', 'proj', 'A'.repeat(40)].join('-'),
  google: `AIza${'B'.repeat(35)}`,
  oauth: `GOCSPX-${'C'.repeat(28)}`,
  accessKey: `AKIA${'D'.repeat(16)}`,
  privateKey: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
};

describe('findSecrets', () => {
  it.each([
    ['OpenAI API key', FAKE.openai],
    ['Google API key', FAKE.google],
    ['Google OAuth client secret', FAKE.oauth],
    ['AWS access key ID', FAKE.accessKey],
    ['Private key', FAKE.privateKey],
  ])('finds a %s', (name, secret) => {
    const [finding] = find(`var a=1;const key="${secret}";`);
    expect(finding?.name).toBe(name);
    // The log shows only the start of the match.
    expect(finding?.excerpt).toBe(`${secret.slice(0, 8)}…`);
  });

  it('passes ordinary bundle code, including words that start like keys', () => {
    expect(
      find('function skip(){return "sk-short"} const task="ASIA";const url="https://example.com"'),
    ).toEqual([]);
  });
});

describe('scanBuild', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('scans client chunks and prerendered pages, and skips server code', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pictora-next-'));
    await mkdir(join(dir, 'static', 'chunks'), { recursive: true });
    await mkdir(join(dir, 'server', 'app'), { recursive: true });
    await writeFile(join(dir, 'static', 'chunks', 'main.js'), 'console.log("hello")');
    await writeFile(join(dir, 'server', 'app', 'terms.html'), `<p>${FAKE.google}</p>`);
    await writeFile(join(dir, 'server', 'app', 'page.js'), `const k="${FAKE.openai}"`);

    const { findings, scanned } = await scan(dir);
    expect(scanned).toBe(2);
    expect(findings).toEqual([
      { file: join('server', 'app', 'terms.html'), name: 'Google API key', excerpt: 'AIzaBBBB…' },
    ]);
  });
});
