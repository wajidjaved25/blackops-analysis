import type { NextConfig } from 'next';

const API = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  poweredByHeader: false,
  output: 'standalone', // small self-contained server for the Docker image
  // Proxy /api/* to the Nest backend, so the browser never needs CORS.
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};
export default config;
