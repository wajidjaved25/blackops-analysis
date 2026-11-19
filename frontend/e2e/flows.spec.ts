import { expect, test } from '@playwright/test';

const BAD = 'TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz';
const BUSY = 'TU4vEruvZwLLkSfV9bNw12EJTPvNr7Pvaa';
const shot = (page: import('@playwright/test').Page, n: string) => page.screenshot({ path: `e2e/screenshots/flow-${n}.png`, fullPage: true });

test('case, graph, monitoring, screening, labels flows', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/');

  // Case + addresses
  const title = `E2E case ${Date.now()}`;
  await page.goto('/cases?new=1');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create case' }).click();
  await page.waitForURL(/\/cases\/\d+$/);
  const caseUrl = page.url();
  await page.getByRole('tab', { name: /Addresses/ }).click();
  await page.getByLabel('Address', { exact: true }).fill(BAD);
  await page.getByRole('combobox', { name: 'Role' }).selectOption('victim');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Address added')).toBeVisible();
  await shot(page, 'case-addresses');

  // Graph -> save to case
  await page.goto(`/graph?addr=${BAD}`);
  await page.getByText(/\d+ wallets/).first().waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Save to case' }).click();
  await page.getByRole('dialog').getByRole('combobox').selectOption({ label: title });
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(/\/cases\/\d+$/, { timeout: 60_000 });
  await page.getByRole('tab', { name: 'Graph' }).click();
  await expect(page.getByAltText('Saved fund-flow graph')).toBeVisible();
  await shot(page, 'case-graph');
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await page.getByText(/Storyline/).waitFor({ timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await shot(page, 'case-timeline');

  // reopen saved graph
  await page.getByRole('tab', { name: 'Graph' }).click();
  await page.getByRole('link', { name: /Open in graph/ }).click();
  await page.getByText(/Saved graph from case/).waitFor({ timeout: 30_000 });
  await shot(page, 'graph-from-case');

  // report
  await page.goto(`${caseUrl}/report`);
  await page.getByText('Investigation report').waitFor({ timeout: 120_000 });
  await shot(page, 'case-report');

  // monitoring
  await page.goto('/monitoring');
  await page.getByRole('button', { name: /New watchlist/ }).click();
  await page.getByLabel('Name').fill(`E2E list ${Date.now() % 10000}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/\/monitoring\/\d+$/);
  await page.getByRole('button', { name: /Add addresses/ }).click();
  await page.getByRole('textbox', { name: 'Addresses' }).fill(BUSY);
  await page.getByRole('dialog').getByRole('button', { name: /^Add \d+/ }).click();
  await expect(page.getByText(/Added \d/)).toBeVisible();
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByText('Rule added')).toBeVisible();
  await shot(page, 'watchlist');

  // screening
  await page.goto('/screening');
  await page.getByRole('textbox', { name: 'Addresses' }).fill(`${BAD}\n${BUSY}`);
  await page.getByRole('button', { name: /Screen 2 addresses/ }).click();
  await page.getByText(/Results · job/).waitFor({ timeout: 30_000 });
  await page.getByText(/OFAC|sanction|Severe/i).first().waitFor({ timeout: 120_000 }).catch(() => {});
  await shot(page, 'screening');

  // labels dry-run
  await page.goto('/labels');
  await page.getByRole('button', { name: /Import CSV/ }).click();
  await page.getByRole('dialog').locator('textarea').fill(`address,name,category\n${BUSY},Busy hot,exchange\nnot-an-address,Bad,scam`);
  await page.getByRole('button', { name: /Preview/ }).click();
  await expect(page.getByText('1 valid', { exact: true })).toBeVisible();
  await shot(page, 'labels-dryrun');
});
