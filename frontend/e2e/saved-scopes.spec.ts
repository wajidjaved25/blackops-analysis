import { expect, Page, test } from '@playwright/test';

// Phase 10C: saved analysis scopes. Synthetic statement built here with ExcelJS; every row is an exchange-internal ("Off-chain transfer") row,
// so nothing needs chain access and no real data is involved.
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
const rowFor = (page: Page, text: string | RegExp) => page.getByRole('row').filter({ hasText: text });

test('saved scopes: save from filters, apply and run, rename, delete, save a selection', async ({ page }) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExcelJS = require('../../backend/node_modules/exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Withdrawals').addRows([
    HEADER,
    ['2026-03-05 09:00:00', 'USDT', 'TRX', 10, 0, 'TXyz1', 'Off-chain transfer 900001', 'Completed'],
    ['2026-03-20 09:00:00', 'USDT', 'TRX', 20, 0, 'TXyz2', 'Off-chain transfer 900002', 'Completed'],
    ['2026-05-02 09:00:00', 'USDT', 'TRX', 30, 0, 'TXyz1', 'Off-chain transfer 900003', 'Completed'],
    ['2026-05-03 09:00:00', 'USDT', 'TRX', 40, 0, 'TXyz2', 'Off-chain transfer 900004', 'Completed'],
  ]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  await login(page);
  const id = await newCase(page, 'E2E saved scopes');
  const other = await newCase(page, 'E2E saved scopes other');
  try {
    await page.goto(`/cases/${id}`);
    await page.getByRole('tab', { name: 'Transactions' }).click();
    await page.getByRole('button', { name: 'Import statement' }).click();
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'synthetic.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await page.getByRole('button', { name: /Import 4 rows/ }).click();
    await expect(page.getByText(/Imported 4 rows/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

    // --- save a scope from filters ---
    await page.getByRole('tab', { name: 'Analysis' }).click();
    const count = page.getByTestId('scope-count');
    const picker = page.getByRole('combobox', { name: 'Saved scopes' });
    await expect(picker).toContainText('No saved scopes yet');
    await expect(page.getByRole('button', { name: 'Save this scope…' })).toBeDisabled(); // nothing chosen yet
    await page.getByRole('group', { name: 'Scope of the analysis' }).getByRole('button', { name: 'Choose…' }).click();
    await expect(page.getByRole('button', { name: 'Save this scope…' })).toBeDisabled(); // choose mode but no filter
    await page.getByLabel('Scope timezone').fill('0');
    await page.getByLabel('Scope from date').fill('2026-03-01');
    await page.getByLabel('Scope to date').fill('2026-04-30');
    await expect(count).toContainText('2 of 4 transactions will be analysed');
    await page.getByRole('button', { name: 'Save this scope…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Save scope' });
    await expect(dlg.getByRole('button', { name: 'Save scope' })).toBeDisabled(); // name required
    await dlg.getByLabel('Scope name').fill('Spring rows');
    await dlg.getByLabel('Scope description').fill('March and April only');
    await dlg.getByRole('button', { name: 'Save scope' }).click();
    await expect(picker).toContainText('Spring rows (2 of 4)');
    await expect(page.getByTestId('saved-scopes')).toContainText('March and April only');

    // --- API rules ---
    const list = (await call(page, `/cases/${id}/scopes`)).json as { id: number; name: string; inScope: number; total: number; scope: { from: string } }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Spring rows', inScope: 2, total: 4 });
    const springId = list[0].id;
    const dup = await call(page, `/cases/${id}/scopes`, 'POST', { name: 'spring ROWS', scope: { statuses: ['verified'] } });
    expect(dup.status).toBe(409); // names are unique per case, ignoring case
    expect((await call(page, `/cases/${other}/scopes`, 'POST', { name: 'Spring rows', scope: { statuses: ['verified'] } })).status).toBe(201); // another case may reuse the name
    const txIds = ((await call(page, `/cases/${id}/transactions?limit=50`)).json.rows as { id: number }[]).map((t) => t.id);
    await call(page, `/cases/${other}/transactions`, 'POST', { hashes: '987c9423fb154a4acc0eac1d936ec8be8978e7967770d70e630c89f8decf4ba1' });
    const foreign = ((await call(page, `/cases/${other}/transactions`)).json.rows as { id: number }[]).map((t) => t.id);
    const bad = (body: unknown) => call(page, `/cases/${id}/scopes`, 'POST', body);
    let r = await bad({ name: 'Foreign', scope: { mode: 'selected', transactionIds: [txIds[0], ...foreign] } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/does not belong to this case/);
    expect((await bad({ name: 'x'.repeat(81), scope: { statuses: ['verified'] } })).status).toBe(400);
    expect((await bad({ name: 'Long description', description: 'x'.repeat(501), scope: { statuses: ['verified'] } })).status).toBe(400);
    expect((await bad({ name: 'Everything', scope: {} })).status).toBe(400);
    expect((await bad({ name: 'Bogus', scope: { statuses: ['bogus'] } })).status).toBe(400);
    expect((await bad({ name: '', scope: { statuses: ['verified'] } })).status).toBe(400);
    expect((await call(page, `/cases/${id}/analyses`, 'POST', { scopeId: springId, scope: { statuses: ['verified'] } })).status).toBe(400); // one or the other
    const foreignScope = ((await call(page, `/cases/${other}/scopes`)).json as { id: number }[])[0].id;
    expect((await call(page, `/cases/${id}/analyses`, 'POST', { scopeId: foreignScope })).status).toBe(404); // another case's scope
    expect((await call(page, '/case-scopes/99999999', 'PATCH', { name: 'x' })).status).toBe(404);

    // --- apply it from the dropdown after a reload, and run ---
    await page.reload();
    await page.getByRole('tab', { name: 'Analysis' }).click();
    await expect(picker).toContainText('Spring rows (2 of 4)');
    await picker.selectOption({ label: 'Spring rows (2 of 4)' });
    await expect(page.getByLabel('Scope from date')).toHaveValue('2026-03-01');
    await expect(page.getByLabel('Scope to date')).toHaveValue('2026-04-30');
    await expect(count).toContainText('2 of 4 transactions will be analysed');
    await page.screenshot({ path: 'e2e/screenshots/saved-scope-applied.png', fullPage: true });
    await page.getByRole('combobox', { name: 'Hops' }).selectOption('1');
    await page.getByRole('button', { name: 'Run analysis' }).click();
    await expect(page.getByTestId('result-scope')).toContainText('Scope: Spring rows (saved)', { timeout: 120_000 });
    await expect(page.getByTestId('result-scope')).toContainText('2 of 4 transactions in scope');
    let runs = (await call(page, `/cases/${id}/analyses`)).json as { id: number; scopeSummary: string; params: { scopeId?: number; scopeName?: string; scope: { from: string } } }[];
    expect(runs[0].scopeSummary).toMatch(/^Scope: Spring rows \(saved\): /);
    expect(runs[0].params).toMatchObject({ scopeId: springId, scopeName: 'Spring rows' });
    const firstRun = runs[0].id;

    // --- editing a filter after applying makes it an ordinary scope again: sent inline, no saved name ---
    await page.getByLabel('Scope to date').fill('2026-03-31');
    await expect(picker).toHaveValue('');
    await expect(count).toContainText('2 of 4 transactions will be analysed');
    await page.getByLabel('Scope to date').fill('2026-04-30');
    await expect(picker).not.toHaveValue(''); // equal again

    // --- rename (past run keeps the name it ran under) ---
    await page.getByRole('button', { name: 'Rename / description' }).click();
    const edit = page.getByRole('dialog', { name: 'Rename saved scope' });
    await edit.getByLabel('Scope name').fill('Spring rows v2');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toContainText('Spring rows v2 (2 of 4)');
    runs = (await call(page, `/cases/${id}/analyses`)).json;
    expect(runs.find((x) => x.id === firstRun)!.scopeSummary).toMatch(/^Scope: Spring rows \(saved\): /);
    await page.getByRole('button', { name: 'Rename / description' }).click();
    await page.getByRole('dialog', { name: 'Rename saved scope' }).getByLabel('Scope name').fill('');
    await expect(page.getByRole('dialog', { name: 'Rename saved scope' }).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByRole('dialog', { name: 'Rename saved scope' }).getByRole('button', { name: 'Cancel' }).click();

    // --- delete (past run is unaffected) ---
    await page.getByRole('button', { name: /Delete saved scope Spring rows v2/ }).click();
    await page.getByRole('dialog', { name: 'Delete saved scope' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(picker).toContainText('No saved scopes yet');
    expect(((await call(page, `/cases/${id}/scopes`)).json as unknown[]).length).toBe(0);
    const old = (await call(page, `/cases/${id}/analyses/${firstRun}`)).json;
    expect(old.scopeSummary).toMatch(/^Scope: Spring rows \(saved\): /);
    expect(old.result.scope).toMatchObject({ savedName: 'Spring rows', inScope: 2, total: 4 });
    expect(old.result.scope.applied.from).toBe(list[0].scope.from); // the run's own copy
    expect((await call(page, `/cases/${id}/analyses`, 'POST', { scopeId: springId })).status).toBe(404);

    // --- save a selection from the Transactions tab ---
    await page.getByRole('tab', { name: 'Transactions' }).click();
    await expect(page.getByRole('button', { name: 'Save selection as scope' })).toBeDisabled();
    await rowFor(page, '900002').getByRole('checkbox').check();
    await rowFor(page, '900004').getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Save selection as scope' }).click();
    const sd = page.getByRole('dialog', { name: 'Save scope' });
    await expect(sd).toContainText('2 selected transactions');
    await sd.getByLabel('Scope name').fill('Two picks');
    await sd.getByRole('button', { name: 'Save scope' }).click();
    await expect(page.getByText('Scope "Two picks" saved')).toBeVisible();
    const sel = (await call(page, `/cases/${id}/scopes`)).json as { id: number; name: string; inScope: number; scope: { mode: string; transactionIds: number[] } }[];
    expect(sel[0]).toMatchObject({ name: 'Two picks', inScope: 2 });
    expect(sel[0].scope.mode).toBe('selected');
    expect(sel[0].scope.transactionIds).toHaveLength(2);
    await page.getByRole('tab', { name: 'Analysis' }).click();
    await picker.selectOption({ label: 'Two picks (2 of 4)' });
    await expect(page.getByTestId('scope-section')).toContainText('2 transactions chosen on the Transactions tab');
    await page.getByRole('combobox', { name: 'Hops' }).selectOption('1');
    await page.getByRole('button', { name: 'Run analysis' }).click();
    await expect(page.getByTestId('result-scope')).toContainText('Scope: Two picks (saved): 2 selected transactions', { timeout: 120_000 });
    await expect(page.getByRole('combobox', { name: 'Analysis run' })).toContainText('Scope: Two picks (saved)');

    // --- mobile width and light theme stay usable ---
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByTestId('saved-scopes')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'e2e/screenshots/saved-scope-mobile.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: 'e2e/screenshots/saved-scope-light.png', fullPage: true });
  } finally {
    await call(page, `/cases/${id}`, 'DELETE');
    await call(page, `/cases/${other}`, 'DELETE');
  }
});
