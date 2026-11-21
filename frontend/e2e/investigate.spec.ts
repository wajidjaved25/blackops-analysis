import { expect, Page, test } from '@playwright/test';

// Phase 9A. Public Tron swap transaction already used by other specs (read-only chain data); everything else is created and removed by cleanup.ts ("E2E …" titles).
const TX = '987c9423fb154a4acc0eac1d936ec8be8978e7967770d70e630c89f8decf4ba1';
const TR = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

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

test('bulk case addresses: validation, skip report, limit, audit-safe errors', async ({ page }) => {
  await login(page);
  const id = (await call(page, '/cases', 'POST', { title: `E2E bulk ${Date.now()}` })).json.id as number;
  const bulk = (addresses: unknown, extra: object = {}) => call(page, `/cases/${id}/addresses/bulk`, 'POST', { addresses, ...extra });
  expect((await bulk([])).status).toBe(400);
  const bad = await bulk([{ address: TR }, { address: 'not-an-address' }]);
  expect(bad.status).toBe(400);
  expect(bad.json.message).toContain('addresses[1]');
  expect((await bulk([{ address: TR, role: 'wizard' }])).status).toBe(400);
  expect((await call(page, `/cases/${id}`)).json.addresses).toHaveLength(0); // all-or-nothing: the valid first row was not stored
  expect((await bulk(Array.from({ length: 501 }, (_, i) => ({ address: `0x${i.toString(16).padStart(40, '0')}` })))).status).toBe(400);
  const ok = await bulk([{ address: TR, role: 'suspect', note: 'n1' }, { address: TR }, { address: '0x00000000000000000000000000000000000000aa', chain: 'bsc' }], { role: 'victim' });
  expect(ok.json).toMatchObject({ added: 2, skipped: 0 }); // the duplicate inside the request counts once
  const again = await bulk([{ address: TR }, { address: '0x00000000000000000000000000000000000000bb' }]);
  expect(again.json).toMatchObject({ added: 1, skipped: 1, skippedAddresses: [TR] });
  const c = (await call(page, `/cases/${id}`)).json;
  expect(c.addresses.map((a: { role: string; chain: string }) => `${a.chain}:${a.role}`).sort()).toEqual(['bsc:victim', 'eth:other', 'tron:suspect']);
  expect((await call(page, '/cases/999999999/addresses/bulk', 'POST', { addresses: [{ address: TR }] })).status).toBe(404); // org-scoped
  const direction = await call(page, `/cases/${id}/analyses`, 'POST', { direction: 'sideways' });
  expect(direction.status).toBe(400); // bad direction refused (before the "no transactions" check would matter)
});

test('investigate one transaction: case + addresses + analysis (both directions) + add analysis wallets to the case', async ({ page }) => {
  test.setTimeout(600_000);
  await login(page);
  await page.goto(`/tx/tron/${TX}`);
  await page.getByRole('button', { name: 'Investigate this transaction' }).click();
  const dlg = page.getByRole('dialog', { name: 'Investigate this transaction' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('option', { name: '+ Create new case…' }).waitFor({ state: 'attached' });
  await dlg.getByLabel('Case', { exact: true }).selectOption('new');
  await dlg.getByLabel('New case title').fill(`E2E investigate ${Date.now()}`);
  const roles = dlg.getByLabel(/^Role for /);
  await expect(roles).toHaveCount(2); // sender + receiver
  await expect(roles.nth(0)).toHaveValue('suspect');
  await expect(roles.nth(1)).toHaveValue('intermediary');
  await dlg.getByRole('button', { name: 'Start investigation' }).click();
  await page.waitForURL(/\/cases\/\d+\?tab=analysis/, { timeout: 240_000 });
  const id = Number(page.url().match(/cases\/(\d+)/)![1]);

  const c = (await call(page, `/cases/${id}`)).json;
  expect(c.addresses.map((a: { role: string }) => a.role).sort()).toEqual(['intermediary', 'suspect']);
  expect((await call(page, `/cases/${id}/transactions`)).json.rows[0].hash).toBe(TX);

  await expect(page.getByRole('tab', { name: 'Analysis', selected: true })).toBeVisible();
  const results = page.getByTestId('analysis-results');
  // the public Tron API is rate limited when several people share an IP: a run that failed on a 429 proves the flow up to here, not the results
  await expect.poll(async () => (await call(page, `/cases/${id}/analyses`)).json[0]?.status, { timeout: 420_000, intervals: [3000] }).toMatch(/done|failed/);
  const last = (await call(page, `/cases/${id}/analyses`)).json[0];
  if (last.status === 'failed' && /429|rate limit/i.test(last.error)) {
    test.info().annotations.push({ type: 'skipped-part', description: `analysis failed upstream: ${last.error}` });
    return;
  }
  expect(last.status).toBe('done');
  await expect(results).toBeVisible({ timeout: 30_000 });
  const run = (await call(page, `/cases/${id}/analyses`)).json[0];
  expect(run.params.direction).toBe('both');
  const full = (await call(page, `/cases/${id}/analyses/${run.id}`)).json.result;
  expect(full.direction).toBe('both');
  expect(full.sources).not.toBeNull(); // the backward trace ran and reported (endpoints may legitimately be empty)
  await expect(results.getByTestId('sources-section')).toBeVisible();
  expect(full.chart.edges.some((e: { dir?: string }) => e.dir === 'forward' || e.dir === 'backward')).toBe(true);

  // analysis wallets -> case: the recipient is already a case address, so "Add all" skips it and says so
  const bar = results.getByTestId('adder-wallets');
  await bar.getByLabel('Role for wallets').selectOption('victim');
  await bar.getByRole('button', { name: /Add all/ }).click();
  await expect(page.getByText(/already in the case, skipped/)).toBeVisible();
  expect((await call(page, `/cases/${id}`)).json.addresses).toHaveLength(2);
  // per-row add of a wallet that is not in the case yet (first source/endpoint wallet when one exists)
  const extra = [...full.sources.endpoints, ...full.endpoints].find((e: { address: string }) => !c.addresses.some((a: { address: string }) => a.address === e.address));
  if (extra) {
    await results.getByRole('button', { name: `Add ${extra.address} to case` }).first().click();
    await expect(page.getByText(/Added 1 address/)).toBeVisible();
    const after = (await call(page, `/cases/${id}`)).json.addresses.find((a: { address: string }) => a.address === extra.address);
    expect(after.note).toContain(`analysis run #${run.id}`);
  }
});
