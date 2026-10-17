import { describe, expect, it } from 'vitest';
import {
  DELETE_CONFIRMATION,
  onboardingRequestSchema,
  parsePurgeMessage,
  userObjectPrefixes,
} from '../src/index.js';

describe('parsePurgeMessage', () => {
  it('reads the sub, the username and the attempt', () => {
    expect(parsePurgeMessage('{"sub":"abc-123","username":"google_1234"}')).toEqual({
      sub: 'abc-123',
      username: 'google_1234',
    });
    expect(parsePurgeMessage('{"sub":"abc","username":"abc","attempt":2}')).toEqual({
      sub: 'abc',
      username: 'abc',
      attempt: 2,
    });
  });

  it.each([
    'not json',
    '[]',
    '{}',
    '{"sub":"abc"}',
    '{"sub":"a/b","username":"abc"}',
    '{"sub":"abc","username":""}',
    '{"sub":"abc","username":"abc","attempt":-1}',
    '{"sub":"abc","username":"abc","attempt":1.5}',
  ])('rejects %s', (body) => {
    expect(parsePurgeMessage(body)).toBeUndefined();
  });
});

describe('account deletion', () => {
  it('asks for DELETE and covers the image and upload prefixes', () => {
    expect(DELETE_CONFIRMATION).toBe('DELETE');
    expect(userObjectPrefixes('abc')).toEqual(['users/abc/', 'uploads/abc/']);
  });
});

describe('onboardingRequestSchema', () => {
  it('needs both confirmations and the terms version', () => {
    const valid = { ageConfirmed: true, termsAccepted: true, tosVersion: '2026-10-14' };
    expect(onboardingRequestSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, ageConfirmed: false },
      { ...valid, termsAccepted: false },
      { ageConfirmed: true, termsAccepted: true },
      { ...valid, extra: 1 },
    ]) {
      expect(onboardingRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
