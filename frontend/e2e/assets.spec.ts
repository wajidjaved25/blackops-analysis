import { expect, Page, test } from '@playwright/test';

// Real Tron wallet with USDT history and ~50 USDC transfers (Tron USDC is historical-only; chosen from TronGrid USDC events on 2026-11-20).
const BOTH = 'TE6JpQerB4JsHzVHk4isufZi5oHwX2t9Le';
const EVM = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/');
}
const chip = (page: Page, group: string, name: string) => page.getByRole('group', { name: group, exact: true }).getByRole('button', { name, exact: true });

test('address page: asset chips filter USDT / USDC and the Tron USDC note shows', async ({ page }) => {
  await login(page);
  await page.goto(`/address/${BOTH}`);
  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible({ timeout: 120_000 });
  await expect(chip(page, 'Asset', 'All')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/issuer support ended/).first()).toBeVisible(); // Tron USDC row in the Assets card
  const transfers = page.getByRole('table', { name: 'Transfers' });
  // combined: both assets appear
  await expect(transfers.getByText('USDC').first()).toBeVisible();
  await expect(transfers.getByText('USDT').first()).toBeVisible();

  await chip(page, 'Asset', 'USDC').click();
  await expect(page).toHaveURL(/asset=usdc/);
  await expect(page.getByText(/Circle ended USDC support on Tron/)).toBeVisible();
  await expect(transfers.getByText('USDC').first()).toBeVisible({ timeout: 60_000 });
  await expect(transfers.getByText('USDT')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/address-usdc.png', fullPage: true });

  await chip(page, 'Asset', 'USDT').click();
  await expect(page).toHaveURL(/asset=usdt/);
  await expect(transfers.getByText('USDT').first()).toBeVisible({ timeout: 60_000 });
  await expect(transfers.getByText('USDC')).toHaveCount(0);
  await expect(page.getByText(/Circle ended USDC support on Tron/)).toHaveCount(0); // note only when USDC is in view
});

test('graph: asset chips, asset link colours and legend', async ({ page }) => {
  await login(page);
  await page.goto(`/graph?addr=${BOTH}&asset=usdc`);
  await expect(chip(page, 'Asset', 'USDC')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/Circle ended USDC support on Tron/)).toBeVisible();
  await expect(page.getByText(/\d+ wallets/).first()).toBeVisible({ timeout: 120_000 });
  await expect(chip(page, 'Link colour', 'Asset')).toHaveAttribute('aria-pressed', 'true'); // non-USDT edges switch the colouring to asset
  await page.getByText('Legend').click();
  await expect(page.getByText('USDC link')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/graph-usdc.png' });
  await chip(page, 'Asset', 'All').click();
  await expect(page).toHaveURL(/graph\?addr=/);
  await expect(page).not.toHaveURL(/asset=/);
});

test('0x input: chain selector on address page, graph and dashboard search; Tron needs none', async ({ page }) => {
  await login(page);
  // dashboard search: choosing BNB Chain puts the chain into the URL
  await page.goto('/');
  await page.getByLabel('Address or transaction hash', { exact: true }).fill(EVM);
  await expect(chip(page, 'Chain', 'Ethereum')).toHaveAttribute('aria-pressed', 'true'); // default Ethereum
  await chip(page, 'Chain', 'BNB Chain').click();
  await page.getByRole('button', { name: 'Investigate' }).click();
  await page.waitForURL(/\/address\/0x.*chain=bsc/);
  await expect(chip(page, 'Chain', 'BNB Chain')).toHaveAttribute('aria-pressed', 'true');
  // no ETHERSCAN_API_KEY in this environment: the page must say so instead of pretending
  await expect(page.getByText(/ETHERSCAN_API_KEY/).first()).toBeVisible({ timeout: 60_000 });
  await chip(page, 'Chain', 'Ethereum').click();
  await expect(page).not.toHaveURL(/chain=bsc/);

  await page.goto(`/graph?addr=${EVM}&chain=bsc`);
  await expect(chip(page, 'Chain', 'BNB Chain')).toHaveAttribute('aria-pressed', 'true');

  await page.goto(`/address/${BOTH}`);
  await expect(page.getByRole('group', { name: 'Chain', exact: true })).toHaveCount(0); // Tron address: no choice to make
});

test('API: chain and asset parameters are validated', async ({ page }) => {
  await login(page);
  const get = async (p: string) => (await page.request.get(`/api${p}`)).status();
  expect(await get(`/address/${EVM}?chain=tron`)).toBe(400); // 0x address cannot be a Tron address
  expect(await get(`/address/${BOTH}?chain=bsc`)).toBe(400); // T address cannot be on BNB Chain
  expect(await get(`/address/${BOTH}?asset=dai`)).toBe(400);
  expect(await get(`/address/${BOTH}?chain=solana`)).toBe(400);
  expect(await get(`/tx/solana/${'a'.repeat(64)}`)).toBe(400);
  // every existing URL form keeps working: no chain/asset = autodetect + all assets
  expect(await get(`/address/${BOTH}?limit=5`)).toBe(200);
});
