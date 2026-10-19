import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  agentRules: false,
  // Images are served as they are: the static samples are already sized WebP files on the assets bucket behind
  // CloudFront. The optimizer would fetch them through the app's own handler, where the proxy's origin check
  // rejects the internal request (403), and would spend Lambda time resizing them.
  images: { unoptimized: true },
  // The legal pages read their Markdown at run time, so the standalone server needs the files.
  outputFileTracingIncludes: {
    '/terms': ['./content/legal/**/*'],
    '/content-policy': ['./content/legal/**/*'],
    '/privacy': ['./content/legal/**/*'],
  },
};

export default nextConfig;
