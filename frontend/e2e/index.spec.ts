import { expect, test } from '@playwright/test';

// Low-activity real Tron wallet: its whole history backfills in a few seconds.
const WALLET = 'TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz';

test('data index admin page: backfill, re-sync, remove', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Data index', exact: true })).toBeVisible();

  await page.goto('/admin/index');
  await expect(page.getByRole('heading', { name: 'Data index', level: 1 })).toBeVisible();
  await expect(page.getByText('Stored transfers')).toBeVisible();
  await expect(page.getByText('Full-chain tailer')).toBeVisible();

  // start from a clean slate for this wallet (it may be left over from a previous run)
  const row = () => page.getByRole('row').filter({ hasText: WALLET.slice(0, 6) });
  await page.getByLabel('Search wallets').fill(WALLET.slice(0, 6));
  await page.waitForTimeout(800);
  if (await row().count()) {
    await page.getByRole('button', { name: `Remove ${WALLET}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect(row()).toHaveCount(0);
  }

  await page.getByLabel('Wallet to index').fill(WALLET);
  await page.getByRole('button', { name: 'Backfill', exact: true }).first().click();
  await expect(page.getByText('Backfill queued').first()).toBeVisible();
  await expect(row().getByText('complete')).toBeVisible({ timeout: 120_000 }); // page polls while a backfill runs
  await page.screenshot({ path: 'e2e/screenshots/admin-index.png', fullPage: true });

  await row().getByRole('button', { name: /Re-sync/ }).click();
  await expect(page.getByText('Synced').first()).toBeVisible({ timeout: 60_000 });

  // address page shows the coverage badge from the index
  await page.goto(`/address/${WALLET}`);
  await expect(page.getByText(/Fully indexed · \d+ transfers/)).toBeVisible({ timeout: 120_000 });

  await page.goto('/admin/index');
  await page.getByLabel('Search wallets').fill(WALLET.slice(0, 6));
  await page.getByRole('button', { name: `Remove ${WALLET}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(row()).toHaveCount(0);
});
