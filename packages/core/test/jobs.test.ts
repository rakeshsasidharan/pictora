import { describe, expect, it } from 'vitest';
import {
  JOB_ERROR_CODES,
  JOB_ERROR_MESSAGES,
  activeJobsGsiPk,
  imageKey,
  imageSk,
  isBatchJob,
  jobError,
  jobPk,
  rateSk,
  spendSk,
  statsEnhancerSk,
  statsModelSk,
  statsPk,
  thumbnailKey,
  ttlAfter,
  usageRankSk,
  usageSk,
  userPk,
  utcMonth,
  versionSk,
  utcDate,
  utcMinute,
} from '../src/jobs.js';

describe('table keys', () => {
  it('follows the data model (tech design 4)', () => {
    expect(userPk('abc')).toBe('USER#abc');
    expect(usageSk('2026-10-15')).toBe('USAGE#2026-10-15');
    expect(rateSk('202610151230')).toBe('RATE#202610151230');
    expect(jobPk('01J')).toBe('JOB#01J');
    expect(imageKey('abc', 'IMG', 2)).toBe('users/abc/IMG/v2.png');
    expect(thumbnailKey('abc', 'IMG', 2)).toBe('users/abc/IMG/v2_thumb.webp');
    expect(imageSk('01I')).toBe('IMG#01I');
    expect(versionSk('01I', 3)).toBe('VER#01I#3');
    expect(spendSk('2026-10')).toBe('SPEND#2026-10');
    expect(statsPk('2026-10-15')).toBe('STATS#2026-10-15');
    expect(statsModelSk('mock')).toBe('MODEL#mock');
    expect(statsEnhancerSk('bedrock:us.openai.gpt-5.6-luna')).toBe(
      'ENHANCER#bedrock:us.openai.gpt-5.6-luna',
    );
    expect(activeJobsGsiPk('running')).toBe('JOBS#running');
    expect(activeJobsGsiPk('queued')).toBe('JOBS#queued');
  });

  it('pads usage ranks so they sort by points used', () => {
    expect(usageRankSk(7)).toBe('0000000007');
    expect(usageRankSk(1234)).toBe('0000001234');
    expect(usageRankSk(-3)).toBe('0000000000');
    expect([usageRankSk(25), usageRankSk(3), usageRankSk(100)].sort()).toEqual([
      '0000000003',
      '0000000025',
      '0000000100',
    ]);
  });
});

describe('utcMonth', () => {
  it('names the UTC month', () => {
    expect(utcMonth(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10');
    expect(utcMonth(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11');
  });
});

describe('UTC periods', () => {
  it('names the day and the minute in UTC', () => {
    const now = new Date('2026-10-15T23:59:42.123Z');
    expect(utcDate(now)).toBe('2026-10-15');
    expect(utcMinute(now)).toBe('202610152359');
    expect(utcDate(new Date('2026-10-16T00:00:00Z'))).toBe('2026-10-16');
  });

  it('computes TTLs in epoch seconds', () => {
    expect(ttlAfter(new Date('1970-01-01T00:00:10.900Z'), 120)).toBe(130);
  });
});

describe('job errors', () => {
  it('has a plain-language message for every code that mentions the refund', () => {
    for (const code of JOB_ERROR_CODES) {
      expect(jobError(code)).toEqual({ code, message: JOB_ERROR_MESSAGES[code] });
      expect(JOB_ERROR_MESSAGES[code]).toMatch(/refunded/);
    }
  });
});

describe('isBatchJob', () => {
  const generate = {
    type: 'generate',
    prompt: 'A fox',
    style: 'none',
    modelId: 'mock',
    aspect: '1:1',
    quality: 'draft',
    count: 1,
  } as const;

  it('is true for a generate job delivered as a batch only', () => {
    expect(isBatchJob({ request: { ...generate, delivery: 'batch' } })).toBe(true);
    expect(isBatchJob({ request: { ...generate, delivery: 'standard' } })).toBe(false);
    expect(isBatchJob({ request: generate })).toBe(false);
    expect(
      isBatchJob({
        request: {
          type: 'edit',
          imageId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
          parentVersion: 1,
          instruction: 'Add snow',
          modelId: 'mock',
          quality: 'draft',
        },
      }),
    ).toBe(false);
  });

  it('has a plain-language message for an expired batch', () => {
    expect(jobError('batch_expired').message).toMatch(/within 24 hours.*refunded/);
  });
});
