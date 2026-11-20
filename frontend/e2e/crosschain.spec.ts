import { expect, Page, test } from '@playwright/test';

// Real Tron swap: wallet TGrqwm… sold 23 USDT and received 73.99327 TRX in the same tx (SunSwap Universal Router),
// found on TronGrid on 2026-11-20. Real Tron deposit into the Allbridge Core USDT OFT interface (seeded official bridge label).
const SWAP_TX = '987c9423fb154a4acc0eac1d936ec8be8978e7967770d70e630c89f8decf4ba1';
const BRIDGE = 'TWPziSAroSacAjDuL52ByQzU86s9mP2gPr';
const DEPOSIT_TX = 'd99920edd28a93615e3be3177078c616d9bdfaad16f495a3fd513ddb415e4371';
const SENDER = 'TRteGWYcwkuNqBbHfqCHXUuEjiYFM1z9e5';
const CRAFTED_DEST = '0x' + 'ab'.repeat(20); // crafted Ethereum recipient for the mocked candidate (not a real wallet)

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

test('tx page: shows the detected swap with its evidence (real Tron tx)', async ({ page }) => {
  await login(page);
  await page.goto(`/tx/tron/${SWAP_TX}`);
  const card = page.getByTestId('swap-card');
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card.getByText('Sold 23 USDT, received 73.99327 TRX in the same transaction')).toBeVisible();
  await expect(card.getByText(/Left USDT here → TRX/)).toBeVisible();
  await expect(card.getByText(/not an identity claim/)).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/tx-swap.png', fullPage: true });
});

test('graph: bridge node action, hop finder (real: no labels on the other chains), accepted hop saved to a case', async ({ page }) => {
  await login(page);
  // The graph is mocked (a real graph of a bridge wallet would queue a huge backfill); the hop search and the case writes are real.
  await page.route('**/api/graph/**', (route) =>
    route.fulfill({
      json: {
        chain: 'tron', asset: 'all',
        nodes: [
          { id: BRIDGE, root: true, expanded: true, in: 2700, out: 2698.11, label: 'Allbridge Core USDT OFT interface', category: 'bridge', volume: 5398 },
          { id: SENDER, expanded: false, volume: 2700 },
        ],
        edges: [{ id: `${SENDER}>${BRIDGE}`, source: SENDER, target: BRIDGE, amount: 2700, count: 1, asset: 'usdt', transfers: [{ hash: DEPOSIT_TX, amount: 2700, timestamp: 1795151196000, asset: 'usdt' }] }],
      },
    }),
  );
  const created = await call(page, '/cases', 'POST', { title: `e2e crosschain ${Date.now()}` });
  expect(created.status).toBeLessThan(300);
  const caseId = created.json.id as number;
  try {
    await page.goto(`/graph?addr=${BRIDGE}`);
    await expect(page.getByText(/2 wallets/).first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Find cross-chain continuation' }).click();
    const modal = page.getByTestId('hop-modal');
    await expect(modal.getByLabel('Time window (min)')).toHaveValue('60');
    await expect(modal.getByLabel('Fee tolerance (%)')).toHaveValue('1');

    // 1) real search: no wallet is labelled bridge on Ethereum / BNB Chain, and the UI says so instead of "nothing found"
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(modal.getByText(/no wallet is labelled "bridge" on this chain/).first()).toBeVisible({ timeout: 90_000 });
    await expect(modal.getByTestId('hop-none')).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/hop-none.png' });

    // 2) crafted candidate (what the API returns when the other side has labels and data)
    await page.route('**/api/crosschain/hops**', (route) =>
      route.fulfill({
        json: {
          source: { chain: 'tron', hash: DEPOSIT_TX, bridge: BRIDGE, bridgeName: 'Allbridge Core USDT OFT interface', amount: 2700, asset: 'usdt', timestamp: 1795151196000 },
          params: { windowMin: 60, tolerancePct: 1 },
          sides: [{ chain: 'eth', status: 'ok', bridges: 1, scanned: 3, truncated: false }, { chain: 'bsc', status: 'no_bridge_labels', bridges: 0, scanned: 0, truncated: false }],
          candidates: [{ chain: 'eth', hash: '0x' + 'cd'.repeat(32), bridge: '0x' + 'ef'.repeat(20), bridgeName: 'Allbridge Core (Ethereum)', to: CRAFTED_DEST, amount: 2698.5, asset: 'usdt', ts: 1795151256000, amountDelta: 1.5, amountDeltaPct: 0.06, timeDeltaSec: 60, bridgePair: { from: 'Allbridge Core USDT OFT interface', to: 'Allbridge Core (Ethereum)' }, confidence: 0.93, level: 'high', reasons: ['Amount: crafted', 'Time: crafted', 'Same bridge protocol on both sides', 'Only candidate within the window and tolerance'] }],
          note: 'Candidates are heuristic matches on time, amount and bridge. They are not proof that the funds are the same; nothing here is asserted.',
        },
      }),
    );
    await page.getByRole('button', { name: 'Search' }).click();
    const table = modal.getByTestId('hop-candidates');
    await expect(table).toBeVisible();
    await expect(table.getByText('93% · high')).toBeVisible();
    await expect(table.getByText('Allbridge Core USDT OFT interface → Allbridge Core (Ethereum)')).toBeVisible();
    await expect(table.getByText('60s')).toBeVisible();

    // save to a case from the candidate row (cases.manage, real write)
    await table.getByRole('button', { name: 'Save to case' }).click();
    const save = page.getByTestId('save-hop');
    await expect(save.getByText(/HEURISTIC candidate/)).toBeVisible();
    await page.getByRole('dialog').filter({ has: save }).getByLabel('Case').selectOption({ value: String(caseId) });
    await page.getByRole('dialog').filter({ has: save }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Hop saved to case')).toBeVisible();
    const c = await call(page, `/cases/${caseId}`);
    const addr = (c.json.addresses as { chain: string; address: string; note: string; role: string }[]).find((a) => a.address === CRAFTED_DEST);
    expect(addr?.chain).toBe('eth');
    expect(addr?.note).toContain('HEURISTIC');

    // accept into the graph: dashed cross-chain edge with evidence, saved with the graph
    await table.getByRole('button', { name: 'Add to graph' }).click();
    await expect(page.getByText(/dashed heuristic link/)).toBeVisible();
    await expect(page.getByText(/3 wallets/).first()).toBeVisible();
    await page.getByText('Legend').click();
    await expect(page.getByText('Dashed link = cross-chain (heuristic)')).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/graph-crosschain.png' });
    await page.getByRole('button', { name: 'Save to case' }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Case').selectOption({ value: String(caseId) });
    await dlg.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForURL(`**/cases/${caseId}`);
    const saved = await call(page, `/cases/${caseId}`);
    const gj = typeof saved.json.graphJson === 'string' ? saved.json.graphJson : JSON.stringify(saved.json.graphJson);
    expect(gj).toContain('"xchain":true');
    expect(gj).toContain(`"id":"eth:${CRAFTED_DEST}"`); // foreign-chain node ids carry the chain; the old bare ids are untouched
    expect(gj).toContain(`"id":"${BRIDGE}"`);
  } finally {
    await call(page, `/cases/${caseId}`, 'DELETE');
  }
});

test('labels: bridge and dex categories, official seeds show their source page', async ({ page }) => {
  await login(page);
  await page.goto('/labels');
  await page.getByLabel('Category').selectOption('bridge');
  const row = page.getByRole('row').filter({ hasText: 'Allbridge Core USDT OFT interface' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('official')).toBeVisible();
  await expect(row.getByRole('link', { name: 'source page' })).toHaveAttribute('href', /docs-core\.allbridge\.io/);
  await page.getByLabel('Category').selectOption('dex');
  await expect(page.getByRole('row').filter({ hasText: 'SunSwap Universal Router' })).toBeVisible();
});
