import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  workers: 1,
  reporter: 'list',
  use: { channel: 'msedge', baseURL: 'http://localhost:3000', viewport: { width: 1440, height: 900 } },
});
