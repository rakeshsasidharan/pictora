import { describe, expect, it } from 'vitest';
import { isStateChanging, originAllowed } from '../src/lib/csrf';

const SITE = 'https://pictora.rpillai.dev';

describe('originAllowed', () => {
  it('lets safe methods through without an Origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isStateChanging(method)).toBe(false);
      expect(originAllowed(method, null, SITE)).toBe(true);
    }
  });

  it('needs the site origin on state-changing methods', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(originAllowed(method, SITE, SITE)).toBe(true);
      expect(originAllowed(method, null, SITE)).toBe(false);
      expect(originAllowed(method, 'https://evil.example', SITE)).toBe(false);
      expect(originAllowed(method, 'https://pictora.rpillai.dev.evil.example', SITE)).toBe(false);
      expect(originAllowed(method, 'http://pictora.rpillai.dev', SITE)).toBe(false);
      expect(originAllowed(method, 'null', SITE)).toBe(false);
    }
  });

  it('refuses state-changing requests when the site URL is unknown', () => {
    expect(originAllowed('POST', SITE, undefined)).toBe(false);
  });
});
