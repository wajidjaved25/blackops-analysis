import { expect, Page, test } from '@playwright/test';

// Phase 9D: AI assistant is feature-flagged OFF (AI_ENABLED unset): both pages show "Coming soon" and never call /ai/* except the status probe.
const WALLET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/');
}

test('AI assistant shows Coming soon on the address page and the case Analysis tab, with no AI calls', async ({ page }) => {
  const aiCalls: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/ai/') && u.pathname !== '/api/ai/status') aiCalls.push(`${r.method()} ${u.pathname}`); });
  await login(page);

  const status = await page.evaluate(async () => (await fetch('/api/ai/status')).json());
  expect(status).toEqual({ enabled: false, model: null });
  const post = await page.evaluate(async () => { const r = await fetch('/api/ai/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'q', address: 'x' }) }); return { s: r.status, j: await r.json() }; });
  expect(post.s).toBe(503);
  expect(post.j).toMatchObject({ code: 'ai_disabled', message: 'AI assistant is coming soon' });
  aiCalls.length = 0;

  await page.goto(`/address/${WALLET}?chain=tron`);
  const card = page.locator('.ai-panel');
  await expect(card.getByText('Coming soon').first()).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole('button', { name: /coming soon/i })).toBeDisabled();
  await expect(page.getByPlaceholder('Ask a question about this data…')).toHaveCount(0);

  const caseId = await page.evaluate(async (t) => (await (await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t }) })).json()).id as number, `E2E ai ${Date.now()}`);
  await page.goto(`/cases/${caseId}`);
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.locator('.ai-panel').getByText('Coming soon').first()).toBeVisible();
  await expect(page.locator('.ai-panel').getByRole('button', { name: /coming soon/i })).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 800 }); // mobile: no horizontal scroll
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(aiCalls).toEqual([]);
  await page.evaluate(async (id) => { await fetch(`/api/cases/${id}`, { method: 'DELETE' }); }, caseId);
});
