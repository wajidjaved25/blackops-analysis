import { expect, Page, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';

// Phase 8B. Synthetic statement only. Every recipient is the seeded Allbridge wallet (label category bridge = an endpoint), so the trace itself needs no chain calls.
const BRIDGE = 'TWPziSAroSacAjDuL52ByQzU86s9mP2gPr';
const HEADER = ['Time (UTC+5)', 'Coin', 'Network', 'Amount', 'Fee', 'Address', 'TXID', 'Status'];
const hex = () => randomBytes(32).toString('hex');

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/');
}
const call = (page: Page, path: string, method = 'GET', body?: unknown) =>
  page.evaluate(async ([p, m, b]) => {
    const r = await fetch(`/api${p}`, { method: m as string, headers: b ? { 'Content-Type': 'application/json' } : undefined, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, method, body] as const);

test('case analysis: run from the Analysis tab, findings with evidence, bounds, report section', async ({ page }) => {
  test.setTimeout(480_000); // the analysis job queues behind the statement's verification job (5 chain lookups on the shared free API)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExcelJS = require('../../backend/node_modules/exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Withdrawals');
  const at = (d: number) => `2026-11-${String(d).padStart(2, '0')} 02:05:00`; // 02:05 in UTC+5 (the header)
  ws.addRows([
    HEADER,
    [at(1), 'USDT', 'TRX', 500, 1, BRIDGE, hex(), 'Completed'], [at(2), 'USDT', 'TRX', 500, 1, BRIDGE, hex(), 'Completed'], [at(3), 'USDT', 'TRX', 500, 1, BRIDGE, hex(), 'Completed'],
    [at(4), 'USDT', 'TRX', 9995, 1, BRIDGE, hex(), 'Completed'], [at(5), 'USDT', 'TRX', 9990, 1, BRIDGE, hex(), 'Completed'],
    [at(6), 'USDT', 'TRX', 40, 0, 'TXyz', 'Off-chain transfer 700001', 'Completed'], [at(7), 'USDT', 'TRX', 60, 0, 'TXyz', 'Off-chain transfer 700002', 'Completed'],
  ]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  await login(page);
  const id = (await call(page, '/cases', 'POST', { title: `E2E analysis ${Date.now()}` })).json.id as number;
  expect((await call(page, `/cases/${id}/analyses`, 'POST', {})).status).toBe(400); // nothing to analyse yet
  const imp = await page.request.post(`/api/cases/${id}/transactions/import`, { multipart: { file: { name: 'synthetic.xlsx', mimeType: 'application/octet-stream', buffer } } });
  expect((await imp.json()).imported).toBe(7);
  expect((await call(page, `/cases/${id}/analyses`, 'POST', { thresholds: 'x' })).status).toBe(400); // bad thresholds are refused

  await page.goto(`/cases/${id}`);
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.getByText('No analysis yet')).toBeVisible();
  await page.getByLabel('UTC offset (h)').fill('5');
  await page.getByLabel('Time budget (s)').fill('60');
  await page.getByRole('button', { name: 'Run analysis' }).click();
  const results = page.getByTestId('analysis-results');
  await expect(results).toBeVisible({ timeout: 300_000 });

  await expect(results.getByText('Claimed by statement')).toBeVisible();
  await expect(results.getByText('Off-chain (same exchange)').first()).toBeVisible();
  await expect(results.getByText('3 identical amounts of 500 USDT')).toBeVisible();
  await expect(results.getByText('2 amounts just under 10,000')).toBeVisible();
  await expect(results.getByText(/transactions between 00:00 and 06:00/)).toBeVisible(); // 02:05 local: needs the UTC offset typed in the form
  await expect(results.getByText('2 internal exchange transfers (100)')).toBeVisible();
  // a finding shows its plain-English statement and evidence rows
  await results.getByText('3 identical amounts of 500 USDT').click();
  await expect(results.getByText(/exactly the same amount/)).toBeVisible();
  // the recipient is a labelled bridge: an endpoint, never traced
  await expect(results.getByRole('heading', { name: 'Endpoints reached (1)' })).toBeVisible();
  await expect(results.getByText('Bridge', { exact: true }).first()).toBeVisible();
  await expect(results.getByTestId('link-chart')).toBeVisible();
  await page.waitForTimeout(1500); // canvas paints on the next frames
  expect(await results.getByTestId('link-chart').locator('canvas').count()).toBeGreaterThan(0);
  await results.getByTestId('link-chart').screenshot({ path: 'e2e/screenshots/analysis-chart.png' });
  await page.screenshot({ path: 'e2e/screenshots/analysis-tab.png', fullPage: true });

  // stored, versioned result: bounds, every finding has evidence
  const list = (await call(page, `/cases/${id}/analyses`)).json as { id: number }[];
  expect(list.length).toBe(1);
  const one = (await call(page, `/cases/${id}/analyses/${list[0].id}`)).json;
  expect(one.result.bounds).toMatchObject({ hops: 2, fanout: 5, maxWallets: 60, busyTransfers: 200 });
  expect(one.result.findings.every((f: { statement: string; evidence: unknown[] }) => f.statement && f.evidence.length > 0)).toBeTruthy();
  expect(one.result.trace.walletsTraced).toBe(0); // the only recipient is an endpoint: nothing fetched, and the result says so
  expect((await call(page, `/cases/${id}/analyses`, 'POST', {})).status).toBe(201); // a second run is a new row
  expect((await call(page, `/cases/${id}/analyses`, 'POST', {})).status).toBe(409); // one at a time

  // mobile: no horizontal page scroll
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.getByTestId('analysis-results')).toBeVisible({ timeout: 240_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();

  await page.goto(`/cases/${id}/report`);
  await expect(page.getByRole('heading', { name: /Case analysis \(run #/ })).toBeVisible({ timeout: 150_000 });
  await call(page, `/cases/${id}`, 'DELETE');
});
