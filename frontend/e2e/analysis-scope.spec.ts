import { expect, Page, test } from '@playwright/test';

// Phase 10B: choose what part of a case an analysis runs on. Synthetic statement (built here with ExcelJS); two rows reference real public Tron
// transactions (also used in transactions.spec.ts), the rest are exchange-internal rows that need no chain access.
const SWAP_TX = '987c9423fb154a4acc0eac1d936ec8be8978e7967770d70e630c89f8decf4ba1'; // really pays 23 USDT to SWAP_TO
const SWAP_TO = 'TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ';
const DEPOSIT_TX = 'd99920edd28a93615e3be3177078c616d9bdfaad16f495a3fd513ddb415e4371';
const BRIDGE = 'TWPziSAroSacAjDuL52ByQzU86s9mP2gPr';
const HEADER = ['Time (UTC+5)', 'Coin', 'Network', 'Amount', 'Fee', 'Address', 'TXID', 'Status'];

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
const newCase = async (page: Page, title: string) => (await call(page, '/cases', 'POST', { title: `${title} ${Date.now()}` })).json.id as number;
const waitRun = async (page: Page, caseId: number, runId: number, ms = 150_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call(page, `/cases/${caseId}/analyses/${runId}`);
    if (r.json.status === 'done' || r.json.status === 'failed') return r.json;
    if (Date.now() > end) throw new Error('analysis did not finish');
    await page.waitForTimeout(2000);
  }
};

test('scope: filters, live count, selected rows, validation, result records the scope', async ({ page }) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExcelJS = require('../../backend/node_modules/exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Withdrawals').addRows([
    HEADER,
    ['2026-11-20 10:06:36', 'USDT', 'TRX', 2700, 1.5, BRIDGE, DEPOSIT_TX, 'Completed'], // on-chain, matches
    ['2026-11-20 08:15:09', 'USDT', 'TRX', 25, 1, SWAP_TO, SWAP_TX, 'Completed'], // on-chain, chain says 23: mismatch
    ['2026-03-05 09:00:00', 'USDT', 'TRX', 10, 0, 'TXyz1', 'Off-chain transfer 900001', 'Completed'],
    ['2026-03-20 09:00:00', 'USDT', 'TRX', 20, 0, 'TXyz2', 'Off-chain transfer 900002', 'Completed'],
    ['2026-05-02 09:00:00', 'USDT', 'TRX', 30, 0, 'TXyz1', 'Off-chain transfer 900003', 'Completed'],
  ]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  await login(page);
  const id = await newCase(page, 'E2E scope');
  const other = await newCase(page, 'E2E scope other');
  try {
    await page.goto(`/cases/${id}`);
    await page.getByRole('tab', { name: 'Transactions' }).click();
    await page.getByRole('button', { name: 'Import statement' }).click();
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'synthetic-withdrawals.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await page.getByRole('button', { name: /Import 5 rows/ }).click();
    await expect(page.getByText(/Imported 5 rows/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByText('Verified', { exact: true }).first()).toBeVisible({ timeout: 120_000 }); // the verification job has run

    // --- API rules ---
    const list = (await call(page, `/cases/${id}/transactions?limit=50`)).json.rows as { id: number; status: string; address: string }[];
    const offChain = list.filter((t) => t.status === 'off_chain').map((t) => t.id);
    expect(offChain).toHaveLength(3);
    const otherTx = (await call(page, `/cases/${other}/transactions`, 'POST', { hashes: SWAP_TX })).json;
    expect(otherTx.added).toBe(1);
    const otherIds = ((await call(page, `/cases/${other}/transactions`)).json.rows as { id: number }[]).map((t) => t.id);
    const bad = async (scope: unknown) => call(page, `/cases/${id}/analyses`, 'POST', { scope });
    let r = await bad({ mode: 'selected', transactionIds: [offChain[0], ...otherIds] }); // an id from another case
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/does not belong to this case/);
    r = await bad({ statuses: ['pending'], chains: ['bsc'] }); // matches nothing
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/No transactions match this scope \(0 of 5\)/);
    expect((await bad({ mode: 'selected', transactionIds: [] })).status).toBe(400);
    expect((await bad({ statuses: ['bogus'] })).status).toBe(400);
    expect((await bad({ mode: 'selected', transactionIds: [offChain[0]], statuses: ['verified'] })).status).toBe(400);
    const pv = (scope: unknown) => call(page, `/cases/${id}/analyses/scope-preview`, 'POST', { scope });
    expect((await pv({ mode: 'selected', transactionIds: otherIds })).status).toBe(400);
    expect((await pv(undefined)).json).toMatchObject({ inScope: 5, total: 5 });
    expect((await pv({ direction: 'withdrawal' })).json.inScope).toBe(5); // Binance withdrawal headers were detected
    expect((await pv({ direction: 'deposit' })).json.inScope).toBe(0);
    expect((await pv({ statuses: ['off_chain'], from: '2026-03-01T00:00:00Z', to: '2026-04-30T23:59:59Z' })).json.inScope).toBe(2);
    expect((await pv({ wallets: ['TXyz1'] })).json.inScope).toBe(2);

    // --- UI: filter on the Analysis tab, live count ---
    await page.getByRole('tab', { name: 'Analysis' }).click();
    const count = page.getByTestId('scope-count');
    await expect(count).toContainText('5 of 5 transactions will be analysed');
    await page.getByRole('group', { name: 'Scope of the analysis' }).getByRole('button', { name: 'Choose…' }).click();
    await page.getByLabel('Scope timezone').fill('0');
    await page.getByLabel('Scope from date').fill('2026-03-01');
    await page.getByLabel('Scope to date').fill('2026-04-30');
    await expect(count).toContainText('2 of 5 transactions will be analysed');
    await page.getByRole('checkbox', { name: /Off-chain \(3\)/ }).check();
    await expect(count).toContainText('2 of 5 transactions will be analysed');
    await page.getByLabel('Scope maximum amount').fill('15');
    await expect(count).toContainText('1 of 5 transactions will be analysed');
    await page.getByLabel('Scope maximum amount').fill('');
    await expect(count).toContainText('2 of 5 transactions will be analysed');
    await page.screenshot({ path: 'e2e/screenshots/scope-filters.png', fullPage: true });
    await page.getByRole('combobox', { name: 'Hops' }).selectOption('1');
    await page.getByRole('button', { name: 'Run analysis' }).click();
    await expect(page.getByTestId('result-scope')).toContainText('2 of 5 transactions in scope', { timeout: 120_000 });
    await expect(page.getByTestId('result-scope')).toContainText('off chain only, 2026-03-01 → 2026-04-30 (UTC+0)');
    const runs = (await call(page, `/cases/${id}/analyses`)).json as { id: number; scopeSummary: string }[];
    expect(runs[0].scopeSummary).toBe('Scope: off chain only, 2026-03-01 → 2026-04-30 (UTC+0)');
    const full = (await call(page, `/cases/${id}/analyses/${runs[0].id}`)).json;
    expect(full.result.scope).toMatchObject({ inScope: 2, total: 5, summary: runs[0].scopeSummary });
    expect(full.result.scope.applied).toMatchObject({ mode: 'all', statuses: ['off_chain'], tzMin: 0 });
    expect(full.result.totals.rows).toBe(2); // totals cover only the scope
    expect(full.result.totals.claimed).toBe(30);
    await expect(page.getByRole('combobox', { name: 'Analysis run' })).toBeVisible().catch(() => undefined);

    // --- UI: tick rows on the Transactions tab, Analyse selected ---
    await page.getByRole('tab', { name: 'Transactions' }).click();
    await expect(page.getByTestId('selection-bar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Analyse selected' })).toBeDisabled();
    await rowFor(page, '900001').getByRole('checkbox').check();
    await rowFor(page, '900003').getByRole('checkbox').check();
    await expect(page.getByTestId('selection-bar')).toContainText('2 selected');
    await page.getByRole('button', { name: 'Analyse selected' }).click();
    await expect(page.getByRole('tab', { name: 'Analysis', selected: true })).toBeVisible();
    await expect(page.getByTestId('scope-section')).toContainText('2 transactions chosen on the Transactions tab');
    await expect(count).toContainText('2 of 5 transactions will be analysed');
    await page.getByRole('combobox', { name: 'Hops' }).selectOption('1');
    await page.getByRole('button', { name: 'Run analysis' }).click();
    await expect(page.getByTestId('result-scope')).toContainText('Scope: 2 selected transactions · 2 of 5 transactions in scope', { timeout: 120_000 });
    const sel = (await call(page, `/cases/${id}/analyses`)).json as { id: number; scopeSummary: string }[];
    expect(sel[0].scopeSummary).toBe('Scope: 2 selected transactions');
    expect((await call(page, `/cases/${id}/analyses/${sel[0].id}`)).json.result.totals.claimed).toBe(40); // 10 + 30

    // select-all for a filter
    await page.getByRole('tab', { name: 'Transactions' }).click();
    await page.getByLabel('Filter by status').selectOption('off_chain');
    await page.getByRole('button', { name: /Select all 3 matching the filter/ }).click();
    await expect(page.getByTestId('selection-bar')).toContainText('3 selected');
    await page.screenshot({ path: 'e2e/screenshots/scope-selected.png', fullPage: true });

    // --- on-chain scope: only the mismatch row's wallet is a seed (real Tron read) ---
    const run = await call(page, `/cases/${id}/analyses`, 'POST', { hops: 1, fanout: 2, budgetSec: 30, direction: 'forward', scope: { statuses: ['mismatch'] } });
    expect(run.status).toBe(201);
    const done = await waitRun(page, id, run.json.id);
    expect(done.status).toBe('done');
    expect(done.result.scope).toMatchObject({ inScope: 1, total: 5 });
    expect(done.result.wallets.map((w: { address: string }) => w.address)).toEqual([SWAP_TO]); // BRIDGE (verified row) is out of scope: not in the table, not traced
    expect(done.result.totals.wallets).toBe(1);

    // run picker shows the scope; mobile width stays usable
    await page.getByRole('tab', { name: 'Analysis' }).click();
    await expect(page.getByRole('combobox', { name: 'Analysis run' })).toContainText('Scope: mismatch only');
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByTestId('scope-section')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'e2e/screenshots/scope-mobile.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: 'e2e/screenshots/scope-light.png', fullPage: true });
  } finally {
    await call(page, `/cases/${id}`, 'DELETE');
    await call(page, `/cases/${other}`, 'DELETE');
  }
});

const rowFor = (page: Page, text: string | RegExp) => page.getByRole('row').filter({ hasText: text });
