import { expect, Page, test } from '@playwright/test';

// Phase 10A UI: the "Exchange address sources" table on the Labels page. Payload is mocked (no real addresses); the UI wiring is real.
const SRC = [
  { id: 'binance', exchange: 'Binance', url: 'https://public.example.org/por.zip', kind: 'official', listName: 'proof-of-reserves list', lastChecked: '2026-11-21T10:00:00Z', lastChanged: '2026-11-20T10:00:00Z', version: '2026-11-12', rowCounts: { tron: 2140000, eth: 8140000, bsc: 1700, hot: 232 }, status: 'ok', error: null, seconds: 900, peakRssMb: 300 },
  { id: 'okx', exchange: 'OKX', url: 'https://static.example.org/okx.zip', kind: 'official', listName: 'proof-of-reserves list', lastChecked: '2026-11-21T10:00:00Z', lastChanged: null, version: null, rowCounts: null, status: 'error', error: 'no OKX proof-of-reserves file found', seconds: null, peakRssMb: null },
  { id: 'community-ethlabels', exchange: 'Various', url: 'https://raw.example.org/accounts.csv', kind: 'community', listName: 'community list', lastChecked: null, lastChanged: null, version: null, rowCounts: null, status: 'never', error: null, seconds: null, peakRssMb: null },
];

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/');
}

test('labels page: exchange address sources table with official / community badges and Check now', async ({ page }) => {
  await login(page);
  await page.route(/\/api\/labels\/status/, async (route) => {
    const r = await route.fetch();
    await route.fulfill({ json: { ...(await r.json()), exchangeSources: SRC } });
  });
  let synced = false;
  await page.route(/\/api\/labels\/exchange-lists\/sync/, (route) => {
    synced = true;
    return route.fulfill({ json: SRC });
  });
  await page.goto('/labels');
  const table = page.getByRole('table', { name: 'Exchange address sources' });
  await expect(table).toBeVisible({ timeout: 90_000 });
  await expect(table).toContainText('Binance');
  await expect(table).toContainText('tron 2,140,000');
  await expect(table).toContainText('eth 8,140,000');
  await expect(table).toContainText('no OKX proof-of-reserves file found');
  await expect(table.getByText('community list', { exact: true }).first()).toBeVisible();
  await expect(table.getByText('official list', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect.poll(() => synced).toBe(true);
});
