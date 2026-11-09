import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../../.github/scripts/prune_certificates.sh');
const ARN_PREFIX = 'arn:aws:acm:us-east-1:111111111111:certificate/';

interface StubCertificate {
  tags: { Key: string; Value: string }[];
  inUseBy: string[];
  /** Makes `delete-certificate` fail for this certificate. */
  deleteFails?: boolean;
}

interface StubState {
  certificates: Record<string, StubCertificate>;
  /** Makes `list-certificates` fail. */
  listFails?: boolean;
}

/**
 * A stand-in for the `aws` CLI that answers the four ACM calls the script makes from a JSON state file and
 * logs every call, so the tests see exactly what the script asked for and deleted.
 */
const AWS_STUB = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.AWS_STUB_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(readFileSync(process.env.AWS_STUB_STATE, 'utf8'));
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] !== 'acm' || option('--region') !== 'us-east-1') {
  console.error('unexpected call: ' + args.join(' '));
  process.exit(2);
}
const arn = option('--certificate-arn');
const certificate = state.certificates[arn];
switch (args[1]) {
  case 'list-certificates':
    if (state.listFails) { console.error('AccessDenied'); process.exit(254); }
    console.log(JSON.stringify({
      CertificateSummaryList: Object.keys(state.certificates).map((CertificateArn) => ({ CertificateArn })),
    }));
    break;
  case 'list-tags-for-certificate':
    console.log(JSON.stringify({ Tags: certificate.tags }));
    break;
  case 'describe-certificate':
    console.log(JSON.stringify({ Certificate: { CertificateArn: arn, InUseBy: certificate.inUseBy } }));
    break;
  case 'delete-certificate':
    if (certificate.deleteFails) { console.error('ResourceInUseException'); process.exit(254); }
    break;
  default:
    console.error('unexpected call: ' + args.join(' '));
    process.exit(2);
}
`;

function tags(stage?: string, project = 'pictora'): StubCertificate['tags'] {
  const result = [{ Key: 'Project', Value: project }];
  return stage ? [...result, { Key: 'Stage', Value: stage }] : result;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prune-certificates-'));
  writeFileSync(join(dir, 'aws'), AWS_STUB);
  chmodSync(join(dir, 'aws'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(state: StubState, args: string[]) {
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'calls.log');
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, '');
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      AWS_STUB_STATE: statePath,
      AWS_STUB_LOG: logPath,
    },
  });
  const calls = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const deleted = calls
    .filter((call) => call[1] === 'delete-certificate')
    .map((call) => call[call.indexOf('--certificate-arn') + 1]);
  return { status: result.status, stdout: result.stdout, deleted, calls };
}

const current = `${ARN_PREFIX}current-dev`;

describe('prune_certificates.sh', () => {
  it('deletes an unused certificate tagged for the stage and logs it', () => {
    const old = `${ARN_PREFIX}old-dev`;
    const result = run(
      {
        certificates: {
          [current]: {
            tags: tags('dev'),
            inUseBy: ['arn:aws:cloudfront::111111111111:distribution/E1'],
          },
          [old]: { tags: tags('dev'), inUseBy: [] },
        },
      },
      ['dev', current],
    );
    expect(result.status).toBe(0);
    expect(result.deleted).toEqual([old]);
    expect(result.stdout).toContain(`Deleted unused dev certificate ${old}`);
    expect(result.stdout).toContain('1 deleted');
  });

  it('keeps the current certificate, in-use, other-stage, untagged and other projects’ certificates', () => {
    const result = run(
      {
        certificates: {
          // The current certificate is kept even before CloudFront reports it in use.
          [current]: { tags: tags('dev'), inUseBy: [] },
          [`${ARN_PREFIX}in-use-dev`]: {
            tags: tags('dev'),
            inUseBy: ['arn:aws:cloudfront::111111111111:distribution/E1'],
          },
          [`${ARN_PREFIX}old-prod`]: { tags: tags('prod'), inUseBy: [] },
          [`${ARN_PREFIX}untagged`]: { tags: [], inUseBy: [] },
          [`${ARN_PREFIX}no-stage`]: { tags: tags(), inUseBy: [] },
          [`${ARN_PREFIX}other-project`]: { tags: tags('dev', 'other'), inUseBy: [] },
          [`${ARN_PREFIX}stage-only`]: { tags: [{ Key: 'Stage', Value: 'dev' }], inUseBy: [] },
        },
      },
      ['dev', current],
    );
    expect(result.status).toBe(0);
    expect(result.deleted).toEqual([]);
    expect(result.stdout).toContain('0 deleted');
    // The current certificate is skipped before any call about it.
    expect(result.calls.some((call) => call.includes(current))).toBe(false);
  });

  it('deletes only the prod certificates when cleaning up prod', () => {
    const prodCurrent = `${ARN_PREFIX}current-prod`;
    const result = run(
      {
        certificates: {
          [prodCurrent]: { tags: tags('prod'), inUseBy: ['distribution'] },
          [`${ARN_PREFIX}old-prod`]: { tags: tags('prod'), inUseBy: [] },
          [`${ARN_PREFIX}old-dev`]: { tags: tags('dev'), inUseBy: [] },
        },
      },
      ['prod', prodCurrent],
    );
    expect(result.status).toBe(0);
    expect(result.deleted).toEqual([`${ARN_PREFIX}old-prod`]);
  });

  it('warns and exits 0 when a delete fails, and carries on with the rest', () => {
    const failing = `${ARN_PREFIX}failing-dev`;
    const other = `${ARN_PREFIX}other-dev`;
    const result = run(
      {
        certificates: {
          [current]: { tags: tags('dev'), inUseBy: ['distribution'] },
          [failing]: { tags: tags('dev'), inUseBy: [], deleteFails: true },
          [other]: { tags: tags('dev'), inUseBy: [] },
        },
      },
      ['dev', current],
    );
    expect(result.status).toBe(0);
    expect(result.deleted).toEqual([failing, other]);
    expect(result.stdout).toContain(`::warning::Certificate cleanup: could not delete ${failing}`);
    expect(result.stdout).toContain(`Deleted unused dev certificate ${other}`);
    expect(result.stdout).toContain('1 deleted');
  });

  it('warns and exits 0 when the certificates cannot be listed', () => {
    const result = run({ certificates: {}, listFails: true }, ['dev', current]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::Certificate cleanup: could not list certificates');
  });

  it.each([
    ['without a current certificate ARN', ['dev', '']],
    ['for an unknown stage', ['staging', current]],
  ])('deletes nothing %s', (_, args) => {
    const result = run(
      { certificates: { [`${ARN_PREFIX}old-dev`]: { tags: tags('dev'), inUseBy: [] } } },
      args,
    );
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toContain('::warning::');
  });
});
