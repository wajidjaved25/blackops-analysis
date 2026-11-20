import { expect, Page, test } from '@playwright/test';

// Phase 8A. The chain side is real Tron (public txs also used in crosschain.spec.ts); the statement is SYNTHETIC, built here with ExcelJS.
const SWAP_TX = '987c9423fb154a4acc0eac1d936ec8be8978e7967770d70e630c89f8decf4ba1'; // pays 23 USDT to SWAP_TO
const SWAP_TO = 'TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ';
const DEPOSIT_TX = 'd99920edd28a93615e3be3177078c616d9bdfaad16f495a3fd513ddb415e4371'; // 2700 USDT to BRIDGE at 2026-11-20 05:06:36 UTC
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
const rowFor = (page: Page, text: string | RegExp) => page.getByRole('row').filter({ hasText: text });

test('paste hashes: verified against the chain, duplicates and junk reported', async ({ page }) => {
  await login(page);
  const id = await newCase(page, 'E2E tx paste');
  await page.goto(`/cases/${id}`);
  await page.getByRole('tab', { name: 'Transactions' }).click();
  await expect(page.getByText('No transactions yet')).toBeVisible();
  await page.getByRole('button', { name: 'Paste hashes' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Hashes', exact: true }).fill(`${SWAP_TX}\n${SWAP_TX}\nnot-a-hash`);
  await page.getByRole('button', { name: 'Add and verify' }).click();
  await expect(page.getByText(/Not added: not-a-hash/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  const row = rowFor(page, '987c94');
  await expect(row.getByText('Verified')).toBeVisible({ timeout: 90_000 });
  await expect(row.getByText('23 USDT')).toBeVisible();
  // pasting the same hash again adds nothing
  const again = await call(page, `/cases/${id}/transactions`, 'POST', { hashes: SWAP_TX });
  expect(again.json.added).toBe(0);
  await page.screenshot({ path: 'e2e/screenshots/tx-paste.png', fullPage: true });
  await call(page, `/cases/${id}`, 'DELETE');
});

test('import a synthetic Binance-style xlsx: detect, preview problems, verify, wallets, off-chain note, totals', async ({ page }) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExcelJS = require('../../backend/node_modules/exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Summary').addRow(['Total', 3]);
  wb.addWorksheet('Withdrawals').addRows([
    HEADER,
    ['2026-11-20 10:06:36', 'USDT', 'TRX', 2700, 1.5, BRIDGE, DEPOSIT_TX, 'Completed'], // matches the chain
    ['2026-11-20 08:15:09', 'USDT', 'TRX', 25, 1, SWAP_TO, SWAP_TX, 'Completed'], // chain says 23: mismatch
    ['2026-11-20 09:00:00', 'USDT', 'TRX', 10, 0, 'TXyz', 'Off-chain transfer 900001', 'Completed'], // exchange-internal
    ['2026-11-20 09:30:00', 'USDT', 'TRX', 1, 1, SWAP_TO, 'zz-not-a-hash', 'Completed'], // row problem
  ]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  await login(page);
  const id = await newCase(page, 'E2E tx import');
  await page.goto(`/cases/${id}`);
  await page.getByRole('tab', { name: 'Transactions' }).click();
  await page.getByRole('button', { name: 'Import statement' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.locator('input[type=file]').setInputFiles({ name: 'synthetic.xlsx', mimeType: 'application/octet-stream', buffer });
  await expect(dlg.getByText('Binance withdrawal history')).toBeVisible();
  await expect(dlg.getByText(/4 rows: 2 on-chain, 1 off-chain, 1 with problems/)).toBeVisible();
  await expect(dlg.getByText('Not a valid tron transaction hash')).toBeVisible();
  await expect(dlg.getByText('Read from the Time column header.')).toBeVisible();
  await dlg.getByLabel('Add destination wallets to the case as').selectOption('intermediary');
  await page.screenshot({ path: 'e2e/screenshots/tx-import-preview.png', fullPage: true });
  await dlg.getByRole('button', { name: 'Import 3 rows' }).click();
  await expect(dlg.getByText(/Imported 3 rows \(1 off-chain records\)/)).toBeVisible();
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();

  await expect(rowFor(page, '987c94').getByText('Mismatch')).toBeVisible({ timeout: 90_000 });
  await expect(rowFor(page, '987c94').getByText(/Amount differs: statement 25 \(net, fee 1 separate\), on-chain 23/)).toBeVisible();
  await expect(rowFor(page, 'd99920').getByText('Verified')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Internal exchange transfer — no on-chain trace; request records from the exchange')).toBeVisible();
  await expect(page.getByText('Claimed by statement')).toBeVisible();
  await expect(page.getByText('2,735 USDT').or(page.getByText('2,735 USD'))).toBeVisible(); // claimed 2700 + 25 + 10
  await expect(page.getByText('2,700 USD').first()).toBeVisible(); // verified
  await page.screenshot({ path: 'e2e/screenshots/tx-tab.png', fullPage: true });

  const c = (await call(page, `/cases/${id}`)).json;
  expect(c.files.map((f: { name: string }) => f.name)).toEqual(['synthetic.xlsx']); // statement kept as evidence
  expect(c.addresses.map((a: { address: string; role: string }) => [a.address, a.role]).sort()).toEqual([[BRIDGE, 'intermediary'], [SWAP_TO, 'intermediary']].sort());
  expect(c.addresses.every((a: { note: string }) => a.note.includes('synthetic.xlsx'))).toBeTruthy();

  // mobile width: the table scrolls inside its wrapper, the page does not
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await page.getByRole('tab', { name: 'Transactions' }).click();
  await expect(page.getByText('Claimed by statement')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  await page.screenshot({ path: 'e2e/screenshots/tx-mobile.png', fullPage: true });

  // report has a transactions section
  await page.goto(`/cases/${id}/report`);
  await expect(page.getByRole('heading', { name: /Transactions \(statement/ })).toBeVisible({ timeout: 150_000 }); // the report also computes live risk for each case wallet
  await call(page, `/cases/${id}`, 'DELETE');
});

test('import: CSV with generic columns, and the upload guards', async ({ page }) => {
  await login(page);
  const id = await newCase(page, 'E2E tx csv');
  const post = (name: string, data: string | Buffer, extra: Record<string, string> = {}, what = 'preview') =>
    page.request.post(`/api/cases/${id}/transactions/${what}`, { multipart: { file: { name, mimeType: 'application/octet-stream', buffer: Buffer.from(data) }, ...extra } });
  // unknown headers => generic, user maps the columns
  const csv = `when,hash,to,amt\n2026-11-20 05:06:36,${DEPOSIT_TX},${BRIDGE},2700\n`;
  expect((await post('x.csv', csv)).status()).toBe(400); // hash/amount columns not detected
  const p = await (await post('x.csv', csv, { mapping: JSON.stringify({ time: 0, hash: 1, address: 2, amount: 3 }), tz: 'UTC+0', defaultChain: 'tron' })).json();
  expect([p.format, p.counts.onChain, p.counts.withProblems]).toEqual(['generic', 1, 0]);
  expect(p.rows[0].claimedAt).toBe('2026-11-20T05:06:36.000Z');
  // guards
  expect((await post('old.xls', 'x')).status()).toBe(400);
  expect((await post('evil.xlsx', 'this is not a zip')).status()).toBe(400);
  expect((await post('evil.html', '<b>x</b>')).status()).toBe(400);
  expect((await post('big.csv', Buffer.alloc(5 * 1024 * 1024 + 10, 97))).status()).toBeGreaterThanOrEqual(400);
  const many = 'hash,amount,address\n' + Array.from({ length: 5001 }, () => `${DEPOSIT_TX},1,${BRIDGE}`).join('\n');
  expect((await (await post('many.csv', many, { mapping: JSON.stringify({ hash: 0, amount: 1, address: 2 }), defaultChain: 'tron' })).json()).message).toMatch(/Too many rows/);
  // nothing was stored by previews or rejected uploads
  expect((await call(page, `/cases/${id}`)).json.files).toEqual([]);
  await call(page, `/cases/${id}`, 'DELETE');
});
