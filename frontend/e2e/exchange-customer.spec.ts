import { expect, Page, test } from '@playwright/test';

// Phase 9C UI. Payloads are mocked where noted (no real customer data); the UI wiring is real.
const ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DEP = { id: 7, orgId: 1, chain: 'tron', address: ADDR, name: 'Binance customer deposit address (internal transfer in case #7 statement)', category: 'exchange_deposit', source: 'statement', sourceUrl: null, confidence: 0.9, createdAt: '2026-11-21T00:00:00Z' };

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/');
}

test('address page: case role first, then "customer account", never "Binance wallet"', async ({ page }) => {
  await login(page);
  await page.route(/\/api\/labels\/address\//, (route) => route.fulfill({ json: [DEP] }));
  await page.route(/\/api\/address\/[^/]+\/cases/, (route) => route.fulfill({ json: [{ caseId: 7, title: 'Test case', status: 'open', role: 'suspect' }] }));
  await page.goto(`/address/${ADDR}`);
  const role = page.getByText('suspect', { exact: true }).first();
  const label = page.getByText('Binance customer account (deposit address)').first();
  await expect(label).toBeVisible({ timeout: 90_000 });
  await expect(role).toBeVisible();
  const [r, l] = [await role.boundingBox(), await label.boundingBox()];
  expect(r!.y).toBeLessThan(l!.y); // the case role is shown above the label
  await expect(page.getByText(/not a Binance wallet/)).toBeVisible();
  await expect(page.getByText(/request account holder records/i)).toBeVisible();
});

test('address page: possibly same owner groups, heuristic with evidence', async ({ page }) => {
  await login(page);
  await page.route(/\/api\/address\/[^/]+\/groups/, (route) => route.fulfill({ json: { address: ADDR, chain: 'tron', checked: 3, partial: false, note: 'Heuristics only: these are signals of possible common ownership, not proof.', bounds: { transfersPerWallet: 200, extraWallets: 16 },
    groups: [{ kind: 'round_trip', wallets: [ADDR], via: null, statement: 'A sent funds to B and B sent funds back within 14 h. Possibly the same owner moving funds between their own wallets.', evidence: [{ hash: 'a'.repeat(64), chain: 'tron', from: 'A', to: 'B', amount: 10, at: 1, note: 'outgoing leg' }] }] } }));
  await page.goto(`/address/${ADDR}`);
  await page.getByRole('button', { name: 'Find related wallets' }).click({ timeout: 90_000 });
  await expect(page.getByTestId('owner-groups')).toContainText('Possibly the same owner');
  await expect(page.getByTestId('owner-groups')).toContainText('heuristic');
  await expect(page.getByTestId('owner-groups')).toContainText('outgoing leg');
});

test('labels page: exchange wallet lists status and daily check button', async ({ page }) => {
  await login(page);
  let synced = false;
  await page.route(/\/api\/labels\/status/, (route) => route.fulfill({ json: { counts: {}, categories: ['exchange', 'exchange_deposit'], exchangeLists: [{ exchange: 'Binance', snapshot: '2026-11-12', url: 'https://example.org/x.zip', checkedAt: Date.now(), syncedAt: Date.now(), status: 'ok', counts: { tron: 46, eth: 111, bsc: 75 } }, { exchange: 'HTX', snapshot: null, url: null, checkedAt: null, syncedAt: null, status: 'error', error: 'HTTP 500' }] } }));
  await page.route(/\/api\/labels\/exchange-lists\/sync/, (route) => { synced = true; return route.fulfill({ json: [] }); });
  await page.goto('/labels');
  await expect(page.getByRole('heading', { name: /Exchange wallet lists/ })).toBeVisible();
  await expect(page.getByText('tron 46 · eth 111 · bsc 75')).toBeVisible();
  await expect(page.getByText('HTTP 500')).toBeVisible();
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect.poll(() => synced).toBe(true);
});
