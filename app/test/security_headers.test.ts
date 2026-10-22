import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN_VERIFY_HEADER, resetOriginSecretCache } from '../src/lib/origin_verify';
import {
  contentSecurityPolicy,
  createNonce,
  imagesBucketOrigin,
} from '../src/lib/security_headers';
import { proxy } from '../src/proxy';

const SECRET = 'origin-secret';
const IMAGES = 'https://pictora-dev-images-test.s3.us-west-2.amazonaws.com';
const COGNITO = 'https://pictora-dev.auth.us-west-2.amazoncognito.com';

/** The CSP's directives by name. */
function directives(csp: string | null): Map<string, string[]> {
  return new Map(
    (csp ?? '').split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe('contentSecurityPolicy', () => {
  const policy = directives(
    contentSecurityPolicy({ nonce: 'abc123', imagesOrigin: IMAGES, cognitoDomain: COGNITO }),
  );

  it('allows only the site itself by default, and no framing, plugins or base changes', () => {
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
  });

  it('runs only scripts with the nonce, without eval or inline scripts', () => {
    const scripts = policy.get('script-src') ?? [];
    expect(scripts).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-inline'");
  });

  it('loads images from the site, the images bucket and data URLs', () => {
    expect(policy.get('img-src')).toEqual(["'self'", 'data:', IMAGES]);
  });

  it('connects to the site, the images bucket (uploads) and Cognito', () => {
    expect(policy.get('connect-src')).toEqual(["'self'", IMAGES, COGNITO]);
    expect(policy.get('form-action')).toEqual(["'self'", COGNITO]);
  });

  it("allows eval for next dev's tooling only in development", () => {
    const dev = directives(contentSecurityPolicy({ nonce: 'n', development: true }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    // Without a bucket or Cognito the policy just leaves them out.
    expect(dev.get('img-src')).toEqual(["'self'", 'data:']);
    expect(dev.get('connect-src')).toEqual(["'self'"]);
  });
});

describe('createNonce and imagesBucketOrigin', () => {
  it('makes a fresh 128-bit nonce each time', () => {
    const nonce = createNonce();
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
    expect(createNonce()).not.toBe(nonce);
  });

  it('names the bucket the way presigned URLs do', () => {
    expect(
      imagesBucketOrigin({ IMAGES_BUCKET: 'pictora-dev-images-test', AWS_REGION: 'us-west-2' }),
    ).toBe(IMAGES);
    expect(imagesBucketOrigin({ IMAGES_BUCKET: 'bucket' })).toBeUndefined();
  });
});

describe('proxy security headers', () => {
  beforeEach(() => {
    resetOriginSecretCache();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    vi.stubEnv('IMAGES_BUCKET', 'pictora-dev-images-test');
    vi.stubEnv('AWS_REGION', 'us-west-2');
    vi.stubEnv('PICTORA_ENV', 'dev');
    // Sign-in isn't configured, so the proxy never calls Cognito.
    vi.stubEnv('COGNITO_USER_POOL_ID', '');
    vi.stubEnv('COGNITO_DOMAIN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  const request = (
    path: string,
    headers: Record<string, string> = { [ORIGIN_VERIFY_HEADER]: SECRET },
  ) => new NextRequest(`https://pictora.example.dev${path}`, { headers });

  it.each(['/', '/terms', '/api/health', '/api/images', '/generate', '/auth/login'])(
    'sets every security header on %s',
    async (path) => {
      const response = await proxy(request(path));
      const csp = response.headers.get('Content-Security-Policy');
      expect(directives(csp).get('default-src')).toEqual(["'self'"]);
      expect(directives(csp).get('img-src')).toContain(IMAGES);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('Permissions-Policy')).toBe(
        'camera=(), microphone=(), geolocation=()',
      );
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    },
  );

  it('sets them on refusals too', async () => {
    const response = await proxy(request('/api/images', {}));
    expect(response.status).toBe(403);
    expect(response.headers.get('Content-Security-Policy')).toMatch(/default-src 'self'/);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('hands pages the nonce in the CSP, and a new one per request', async () => {
    const first = await proxy(request('/'));
    const nonce = first.headers.get('x-middleware-request-x-nonce');
    expect(nonce).toBeTruthy();
    expect(first.headers.get('Content-Security-Policy')).toContain(`'nonce-${nonce}'`);
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(
      first.headers.get('Content-Security-Policy'),
    );
    const second = await proxy(request('/'));
    expect(second.headers.get('x-middleware-request-x-nonce')).not.toBe(nonce);
  });

  it('sends HSTS in prod only', async () => {
    expect((await proxy(request('/'))).headers.get('Strict-Transport-Security')).toBeNull();
    vi.stubEnv('PICTORA_ENV', 'prod');
    expect((await proxy(request('/'))).headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains',
    );
  });
});
