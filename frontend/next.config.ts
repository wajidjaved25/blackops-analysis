import type { NextConfig } from 'next';

const API = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  output: 'standalone', // small self-contained server for the Docker image
  // Proxy /api/* to the Nest backend, so the browser never needs CORS.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};
export default config;
