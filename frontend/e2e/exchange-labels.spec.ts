import { expect, Page, test } from '@playwright/test';

// 8C UI: label source badges + exchange filter, and the prominent exchange label on the address page.
// The label payloads are mocked (no real exchange list could be fetched, rule 5); the UI wiring is real.
const ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const URL = 'https://example.org/por-list.csv'; // crafted, not a real source
const ROW = { id: 1, orgId: 0, chain: 'tron', address: ADDR, name: 'Binance (proof-of-reserves wallet)', category: 'exchange', source: 'official', sourceUrl: URL, confidence: 1, createdAt: '2026-11-20T00:00:00Z' };

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/');
}

test('labels page: official badge links to its source, exchange filter is sent to the API', async ({ page }) => {
  await login(page);
  const seen: string[] = [];
  await page.route(/\/api\/labels\?/, (route) => { seen.push(route.request().url()); return route.fulfill({ json: { rows: [ROW], total: 1, page: 0, pageSize: 100 } }); });
  await page.goto('/labels');
  await expect(page.getByText('Binance (proof-of-reserves wallet)')).toBeVisible();
  await expect(page.getByText('official · global')).toBeVisible();
  await expect(page.getByRole('link', { name: 'source' })).toHaveAttribute('href', URL);
  await page.getByLabel('Exchange').selectOption('Binance');
  await expect.poll(() => seen.some((u) => u.includes('exchange=Binance'))).toBe(true);
  await page.getByLabel('Source').selectOption('explorer');
  await expect.poll(() => seen.some((u) => u.includes('source=explorer'))).toBe(true);
});

test('address page: prominent exchange label with source link', async ({ page }) => {
  await login(page);
  await page.route(/\/api\/labels\/address\//, (route) => route.fulfill({ json: [ROW] }));
  await page.goto(`/address/${ADDR}`);
  await expect(page.getByText('Binance — proof-of-reserves wallet')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('link', { name: 'source' })).toHaveAttribute('href', URL);
});
