/** Request header that carries the per-request script nonce to pages (Next.js reads it from the CSP header). */
export const NONCE_HEADER = 'x-nonce';
export const CSP_HEADER = 'Content-Security-Policy';

/** Two years, the value the HSTS preload list asks for. */
export const HSTS_MAX_AGE_SECONDS = 63_072_000;

/** What the policy needs to know about the environment. */
export interface CspOptions {
  /** A fresh value per request; only scripts carrying it run. */
  nonce: string;
  /** Origin of the images bucket: presigned image URLs and presigned upload POSTs go there. */
  imagesOrigin?: string;
  /** Origin of the Cognito managed login pages. */
  cognitoDomain?: string;
  /** `next dev` needs `eval` for React's debugging tools; deployed builds never allow it. */
  development?: boolean;
}

/** A random nonce for the CSP, base64 encoded (128 bits). */
export function createNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}

/**
 * The Content Security Policy (tech design 12): everything from the site itself, images also from the images
 * bucket and `data:`, fetches also to the images bucket (uploads) and Cognito, and only nonce-carrying scripts
 * (`strict-dynamic` lets them load Next.js chunks). Styles allow inline `style` attributes, which React renders
 * for computed values such as a chart bar's colour.
 */
export function contentSecurityPolicy(options: CspOptions): string {
  const sources = (...values: (string | false | undefined)[]) =>
    values.filter((value): value is string => Boolean(value)).join(' ');
  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': sources(
      "'self'",
      `'nonce-${options.nonce}'`,
      "'strict-dynamic'",
      options.development && "'unsafe-eval'",
    ),
    'style-src': "'self' 'unsafe-inline'",
    'img-src': sources("'self'", 'data:', options.imagesOrigin),
    'font-src': "'self'",
    'connect-src': sources("'self'", options.imagesOrigin, options.cognitoDomain),
    // Signing out posts a form that redirects to Cognito's logout page.
    'form-action': sources("'self'", options.cognitoDomain),
    'frame-ancestors': "'none'",
    'base-uri': "'self'",
    'object-src': "'none'",
  };
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

/** Origin of the images bucket, as presigned URLs name it (virtual-hosted style), or undefined without one. */
export function imagesBucketOrigin(env: {
  [name: string]: string | undefined;
  IMAGES_BUCKET?: string;
  AWS_REGION?: string;
}): string | undefined {
  if (!env.IMAGES_BUCKET || !env.AWS_REGION) return undefined;
  return `https://${env.IMAGES_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com`;
}

/**
 * Sets the security headers on a response (tech design 12): the CSP, `nosniff`, the referrer and permissions
 * policies, `X-Frame-Options` for browsers without `frame-ancestors`, and HSTS when asked (prod only, so a dev
 * domain never pins HTTPS on a shared parent).
 */
export function setSecurityHeaders(
  headers: Headers,
  options: { csp: string; hsts: boolean },
): void {
  headers.set(CSP_HEADER, options.csp);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('X-Frame-Options', 'DENY');
  if (options.hsts) {
    headers.set('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`);
  }
}
