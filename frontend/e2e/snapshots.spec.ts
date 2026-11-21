import { expect, Page, test } from '@playwright/test';

// Phase 9B: named graph snapshots with remarks, and the risk_change monitoring rule's UI.
// Synthetic graphs only; wallets are plain valid Tron addresses (no on-chain activity is needed).
const A = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const B = 'TWPziSAroSacAjDuL52ByQzU86s9mP2gPr';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const elements = (extra = false) => ({
  chain: 'tron',
  nodes: [{ data: { id: A, root: true, expanded: true } }, { data: { id: B, expanded: false } }, ...(extra ? [{ data: { id: 'TJ5ohbJcqpL2cKmsBPAqiDnaqbNLWmYTuc', expanded: false } }] : [])],
  edges: [{ data: { id: `${A}>${B}`, source: A, target: B, amount: 5, count: 1, asset: 'usdt' } }],
});

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

test('graph snapshots: save never overwrites, list / view / rename / remarks / delete, timeline and report use them all', async ({ page }) => {
  await login(page);
  const c = await call(page, '/cases', 'POST', { title: `E2E snapshots ${Date.now()}` });
  const caseId = c.json.id as number;
  try {
    // two snapshots through the API (different graphs); the old PUT now also saves a NEW snapshot instead of replacing
    const s1 = await call(page, `/cases/${caseId}/graphs`, 'POST', { name: 'First look', remarks: 'Line one\nLine two', elements: elements(), png: PNG, depth: 2, filters: { fanout: 8, asset: 'usdt' } });
    expect(s1.status).toBe(201);
    expect(s1.json).toMatchObject({ name: 'First look', remarks: 'Line one\nLine two', rootAddress: A, nodeCount: 2, edgeCount: 1, chain: 'tron', depth: 2 });
    const s2 = await call(page, `/cases/${caseId}/graphs`, 'POST', { name: 'Wider view', elements: elements(true), png: PNG });
    expect(s2.json).toMatchObject({ nodeCount: 3, remarks: '' });
    expect((await call(page, `/cases/${caseId}/graphs`, 'POST', { elements: elements() })).status).toBe(400); // a name is required
    expect((await call(page, `/cases/${caseId}/graph`, 'PUT', { elements: elements(), png: PNG })).status).toBe(200);
    const list = await call(page, `/cases/${caseId}/graphs`);
    expect(list.json).toHaveLength(3);
    expect(list.json[0].graphJson).toBeUndefined(); // the list carries no graph JSON
    expect(list.json.every((g: { author: string }) => !!g.author)).toBe(true);

    // timeline: partial-data shape, snapshot wallets de-duplicated (A, B, J5 across three snapshots)
    const tl = await call(page, `/cases/${caseId}/timeline`);
    expect(tl.status).toBe(200);
    expect(Array.isArray(tl.json.transfers)).toBe(true);
    expect(Array.isArray(tl.json.warnings)).toBe(true);

    // Graph tab
    await page.goto(`/cases/${caseId}`);
    await page.getByRole('tab', { name: /^Graph/ }).click();
    const tab = page.getByTestId('case-graphs');
    await expect(tab.getByText('First look')).toBeVisible();
    await expect(tab.getByText('Line two')).toBeVisible();
    await expect(tab.getByText('Wider view')).toBeVisible();
    await expect(tab.getByText('3 wallets · 1 links').first()).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/case-graph-snapshots.png' });

    // view (read-only picture)
    await tab.getByRole('row').filter({ hasText: 'First look' }).getByRole('button', { name: 'View' }).click();
    await expect(page.getByRole('dialog').getByRole('img', { name: /First look/ })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();

    // rename + edit remarks
    await tab.getByRole('button', { name: 'Edit First look' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Renamed look');
    await page.getByRole('dialog').getByLabel('Remarks').fill('Edited remarks');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(tab.getByText('Renamed look')).toBeVisible();
    await expect(tab.getByText('Edited remarks')).toBeVisible();
    await expect(tab.getByText('First look')).toHaveCount(0);

    // open in the workspace, then "Save to case" makes a NEW snapshot with a suggested name; the original stays
    await page.goto(`/graph?case=${caseId}&snapshot=${s2.json.id}`);
    await expect(page.getByText(/Saved snapshot “Wider view”/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Save to case' }).first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByLabel('Snapshot name')).toHaveValue(/·\s\d{4}-\d{2}-\d{2}$/); // suggested from the root wallet + date
    await expect(dlg.getByLabel('Case')).toHaveValue(String(caseId));
    await dlg.getByLabel('Snapshot name').fill('Saved from workspace');
    await dlg.getByLabel('Remarks (optional)').fill('Second pass\nwith detail');
    await dlg.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForURL(`**/cases/${caseId}`);
    const after = await call(page, `/cases/${caseId}/graphs`);
    expect(after.json).toHaveLength(4);
    expect(after.json.map((g: { name: string }) => g.name)).toEqual(expect.arrayContaining(['Wider view', 'Renamed look', 'Saved from workspace']));
    expect(after.json.find((g: { name: string }) => g.name === 'Saved from workspace').remarks).toBe('Second pass\nwith detail');

    // report lists the snapshots with names and remarks
    await page.goto(`/cases/${caseId}/report`);
    await expect(page.getByRole('heading', { name: /Fund-flow graphs \(4 saved\)/ })).toBeVisible({ timeout: 60_000 });
    const rep = page.getByTestId('report-graph');
    await expect(rep).toHaveCount(4);
    await expect(page.getByRole('heading', { name: 'Saved from workspace' })).toBeVisible();
    await expect(page.getByText('Second pass')).toBeVisible();

    // delete one (UI), the others stay
    await page.goto(`/cases/${caseId}`);
    await page.getByRole('tab', { name: /^Graph/ }).click();
    await page.getByTestId('case-graphs').getByRole('button', { name: 'Delete Wider view' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Delete|Confirm/ }).last().click();
    await expect(page.getByTestId('case-graphs').getByText('Wider view')).toHaveCount(0);
    expect((await call(page, `/cases/${caseId}/graphs`)).json).toHaveLength(3);

    // another org's / unknown graph is a 404
    expect((await call(page, '/case-graphs/99999999')).status).toBe(404);
  } finally {
    await call(page, `/cases/${caseId}`, 'DELETE'); // cascades to the snapshots
  }
});

test('monitoring: Risk change rule can be added, toggled and shows in the rules list', async ({ page }) => {
  await login(page);
  const w = await call(page, '/watchlists', 'POST', { name: `E2E risk ${Date.now()}` });
  try {
    await call(page, `/watchlists/${w.json.id}/items`, 'POST', { addresses: [A] });
    await page.goto(`/monitoring/${w.json.id}`);
    await page.getByLabel('Rule type').selectOption('risk_change');
    await expect(page.getByText(/Re-scores each watched wallet about once an hour/)).toBeVisible();
    await expect(page.getByText('Rule watches')).toHaveCount(0); // no asset choice: it scores the wallet as a whole
    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByText('re-scored hourly')).toBeVisible();
    const sw = page.getByRole('switch', { name: 'Enable Risk change' });
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(sw).not.toBeChecked();
    await page.screenshot({ path: 'e2e/screenshots/monitoring-risk-change.png' });
    expect(((await call(page, `/watchlists/${w.json.id}`)).json.rules as { type: string; params: { asset: string } }[])[0]).toMatchObject({ type: 'risk_change', params: { minWeight: 50, asset: 'all' } });
  } finally {
    await call(page, `/watchlists/${w.json.id}`, 'DELETE');
  }
});
