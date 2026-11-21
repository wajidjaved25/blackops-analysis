import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  workers: 1,
  globalTeardown: './e2e/cleanup.ts',
  reporter: 'list',
  use: { channel: 'msedge', baseURL: process.env.PW_BASE_URL ?? 'http://localhost:3000', viewport: { width: 1440, height: 900 } },
});
