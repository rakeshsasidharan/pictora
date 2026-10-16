import { describe, expect, it } from 'vitest';
import {
  JOB_ERROR_CODES,
  JOB_ERROR_MESSAGES,
  imageKey,
  jobError,
  jobPk,
  rateSk,
  ttlAfter,
  usageSk,
  userPk,
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
