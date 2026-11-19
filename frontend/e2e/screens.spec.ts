import { expect, test, type Page } from '@playwright/test';

const BUSY = 'TU4vEruvZwLLkSfV9bNw12EJTPvNr7Pvaa';
const BAD = 'TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz';
const ROUTES: [string, string][] = [
  ['dashboard', '/'], ['screening', '/screening'], ['monitoring', '/monitoring'], ['alerts', '/alerts'], ['cases', '/cases'],
  ['labels', '/labels'], ['attribution', '/attribution'], ['users', '/admin/users'], ['roles', '/admin/roles'], ['apikeys', '/admin/api-keys'],
  ['audit', '/admin/audit'], ['org', '/admin/org'], ['notifications', '/admin/notifications'], ['profile', '/profile'],
  ['address-bad', `/address/${BAD}`], ['address-busy', `/address/${BUSY}`], ['graph-bad', `/graph?addr=${BAD}`], ['graph-busy', `/graph?addr=${BUSY}`],
];

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/');
}
async function settle(page: Page, name: string) {
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  if (name.startsWith('address')) await page.getByText(/Risk assessment|Something went wrong|Not available/).first().waitFor({ timeout: 120_000 }).catch(() => {});
  else if (name.startsWith('graph')) { await page.getByText(/\d+ wallets|No transfers found/).first().waitFor({ timeout: 120_000 }).catch(() => {}); await page.waitForTimeout(1500); }
  else await page.waitForTimeout(800);
}

for (const mode of (process.env.MODES ?? 'dark,light,mobile').split(',') as ('dark' | 'light' | 'mobile')[]) {
  test(`screens ${mode}`, async ({ page }) => {
    if (mode === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((t) => localStorage.setItem('theme', t), mode === 'light' ? 'light' : 'dark');
    await login(page);
    for (const [name, url] of ROUTES) {
      await page.goto(url);
      await settle(page, name);
      await page.screenshot({ path: `e2e/screenshots/${mode}-${name}.png`, fullPage: !name.startsWith('graph') });
      // no horizontal page overflow
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect.soft(over, `${mode} ${name} horizontal overflow`).toBeLessThanOrEqual(1);
    }
  });
}
