import type { NextConfig } from 'next';

/**
 * Content-Security-Policy derived from upstream build/vite.js.
 * 'unsafe-eval' is required by Cesium / Knockout / WASM decoders;
 * 'blob:' is required by Cesium's web workers.
 */
const BROWSER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' blob: data: https: wss: ws:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const API_CSP = "default-src 'none'; sandbox";

const nextConfig: NextConfig = {
  serverExternalPackages: ['ws'],
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: API_CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      {
        source: '/((?!api/).*)',
        headers: [
          { key: 'Content-Security-Policy', value: BROWSER_CSP },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;
