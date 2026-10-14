import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  agentRules: false,
  // The legal pages read their Markdown at run time, so the standalone server needs the files.
  outputFileTracingIncludes: {
    '/terms': ['./content/legal/**/*'],
    '/content-policy': ['./content/legal/**/*'],
    '/privacy': ['./content/legal/**/*'],
  },
};

export default nextConfig;
