import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** One login per run for the admin; every other actor is an `E2E ` user created through the API. */
const BAD = 'TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz';
const ADMIN = { email: 'admin@example.com', password: 'correct-horse-battery' };
const INITIAL = 'Initial-pass-12345';
const stamp = Date.now();
const shot = (page: Page, n: string) => page.screenshot({ path: `e2e/screenshots/feat-${n}.png`, fullPage: true });

// ---------- RFC 6238 TOTP (SHA1, 30 s, 6 digits), computed here, independent of the backend ----------
function base32(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}
function totp(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30_000);

const sql = (q: string) =>
  execFileSync('C:/Program Files/PostgreSQL/17/bin/psql', ['-h', 'localhost', '-U', 'postgres', '-d', 'usdt_trace', '-tA', '-c', q], { env: { ...process.env, PGPASSWORD: '1234' } }).toString().trim();

let adminCtx: BrowserContext;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext();
  const p = await adminCtx.newPage();
  await p.goto('/login');
  await p.getByLabel('Email').fill(ADMIN.email);
  await p.getByLabel('Password').fill(ADMIN.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL((u) => u.pathname === '/');
  await p.close();
});
test.afterAll(async () => { await adminCtx.close(); });

async function roleId(name: string): Promise<number> {
  const roles = await (await adminCtx.request.get('/api/roles')).json();
  return roles.find((r: { name: string }) => r.name === name).id;
}
async function makeUser(label: string, role: string | number, name = `E2E ${label}`) {
  const email = `e2e-${label}-${stamp}@example.com`;
  const roleId_ = typeof role === 'number' ? role : await roleId(role);
  const r = await adminCtx.request.post('/api/users', { data: { email, name, roleId: roleId_, password: INITIAL } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return email;
}
async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function firstLogin(browser: Browser, email: string, final: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email, INITIAL);
  await page.getByText('Choose a new password').waitFor();
  await page.getByLabel('Current password').fill(INITIAL);
  await page.getByLabel('New password', { exact: true }).fill(final);
  await page.getByLabel('Repeat new password').fill(final);
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByRole('navigation').first().waitFor();
  return { ctx, page };
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: /E2E|Admin/ }).first().click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL('**/login**');
}

// ------------------------------------------------------------------------------------------------
test('2FA: enrol, sign in with a computed TOTP code, sign in with a recovery code, disable; password change from Profile', async ({ browser }) => {
  const email = await makeUser('2fa', 'Analyst', 'E2E TwoFA');
  const pw1 = 'Second-pass-123456';
  const pw2 = 'Third-pass-1234567';
  const { ctx, page } = await firstLogin(browser, email, pw1);

  // Password change from the Profile page
  await page.goto('/profile');
  await page.getByLabel('Current password').fill(pw1);
  await page.getByLabel('New password', { exact: true }).fill(pw2);
  await page.getByLabel('Repeat new password').fill(pw2);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed')).toBeVisible();

  // Wrong current password is refused
  await page.getByLabel('Current password').fill('wrong-wrong-wrong');
  await page.getByLabel('New password', { exact: true }).fill('Fourth-pass-123456');
  await page.getByLabel('Repeat new password').fill('Fourth-pass-123456');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Current password is wrong')).toBeVisible();
  await page.reload();

  // 2FA enrolment
  await page.getByRole('button', { name: 'Set up 2FA' }).click();
  const dlg = page.getByRole('dialog');
  const secret = (await dlg.locator('code.break').first().innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await shot(page, '2fa-enrol');
  // a wrong code is rejected first
  await dlg.getByLabel('Verification code').fill('000000');
  await dlg.getByRole('button', { name: 'Verify and enable' }).click();
  await expect(dlg.getByText(/wrong or expired/i)).toBeVisible();
  await dlg.getByLabel('Verification code').fill(totp(secret, stepNow()));
  await dlg.getByRole('button', { name: 'Verify and enable' }).click();
  await dlg.getByText(/recovery codes/i).first().waitFor();
  const recovery = await dlg.locator('.codes span').allInnerTexts();
  expect(recovery.length).toBeGreaterThanOrEqual(8);
  await dlg.getByRole('button', { name: 'I saved them' }).click();
  await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
  const enrolStep = stepNow();

  // Sign out, sign in with a TOTP code from the *next* 30 s window (the enrolment step cannot be replayed)
  await signOut(page);
  await signIn(page, email, pw2);
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
  await page.getByLabel('Authentication code').fill('111111');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText(/not valid/i)).toBeVisible();
  while (stepNow() === enrolStep) await page.waitForTimeout(1000);
  await page.getByLabel('Authentication code').fill(totp(secret, stepNow()));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  const used = stepNow();

  // Replay of the same code is refused (new session attempt with the same step)
  const probe = await (await browser.newContext()).request.post('/api/auth/login', { data: { email, password: pw2, totp: totp(secret, used) } });
  expect(probe.status()).toBe(401);

  // Recovery code: works once
  await signOut(page);
  await signIn(page, email, pw2);
  await page.getByLabel('Authentication code').fill(recovery[0]);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  const again = await (await browser.newContext()).request.post('/api/auth/login', { data: { email, password: pw2, totp: recovery[0] } });
  expect(again.status()).toBe(401);

  // Disable 2FA from Profile
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Disable 2FA' }).click();
  await page.getByRole('dialog').getByLabel('Confirm your password').fill(pw2);
  await page.getByRole('dialog').getByRole('button', { name: 'Disable 2FA' }).click();
  await expect(page.getByText('2FA disabled')).toBeVisible();
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).totpEnabled).toBe(false);
  await ctx.close();
});

// ------------------------------------------------------------------------------------------------
test('API key: create in the UI, call /v1/screen with X-API-Key, revoke -> 401', async ({ playwright }) => {
  const page = await adminCtx.newPage();
  await page.goto('/admin/api-keys');
  await page.getByRole('button', { name: /Create key/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Create API key' });
  await dlg.getByLabel('Name').fill(`E2E key ${stamp}`);
  await dlg.getByRole('button', { name: 'Create key' }).click();
  const key = (await page.getByRole('dialog', { name: 'Your new API key' }).locator('code').innerText()).trim();
  expect(key).toMatch(/^ut_/);
  await page.getByRole('button', { name: 'I have copied it' }).click();
  await shot(page, 'apikeys');

  const anon = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
  const ok = await anon.get(`/api/v1/screen/${BAD}`, { headers: { 'X-API-Key': key } });
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body.riskLevel).toBe('severe');
  expect(body.frozenByTether).toBeTruthy();
  expect((await anon.get(`/api/v1/screen/${BAD}`)).status()).toBe(401);
  expect((await anon.get(`/api/v1/screen/${BAD}`, { headers: { 'X-API-Key': 'ut_nope' } })).status()).toBe(401);
  // a session cookie must not work on the key route, and a key must not work on session routes
  expect((await anon.get('/api/cases', { headers: { 'X-API-Key': key } })).status()).toBe(401);

  await page.reload();
  const row = page.getByRole('row', { name: new RegExp(`E2E key ${stamp}`) });
  await expect(row.getByText('Active')).toBeVisible();
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(row.getByText('Revoked')).toBeVisible();
  const revoked = await anon.get(`/api/v1/screen/${BAD}`, { headers: { 'X-API-Key': key } });
  expect(revoked.status()).toBe(401);
  await page.close();
});

// ------------------------------------------------------------------------------------------------
test('audit log: action, user and date filters', async () => {
  const page = await adminCtx.newPage();
  await page.goto('/admin/audit');
  await page.getByRole('table', { name: 'Audit log' }).waitFor();
  await page.getByLabel('Action', { exact: true }).fill('apikey');
  await expect(page.getByRole('row').filter({ hasText: 'apikey.create' }).first()).toBeVisible();
  const rows = page.getByRole('table', { name: 'Audit log' }).getByRole('row');
  await expect.poll(async () => (await rows.allInnerTexts()).slice(1).every((t) => /apikey\./.test(t))).toBeTruthy();
  await shot(page, 'audit-action');
  await page.getByLabel('Action', { exact: true }).fill('');
  await page.getByLabel('User', { exact: true }).selectOption({ label: 'Admin' });
  await expect(rows.nth(1)).toBeVisible();
  // a future "from" date matches nothing
  await page.getByLabel('From date').fill('2999-01-01');
  await expect(page.getByText('No entries match')).toBeVisible();
  await page.getByLabel('From date').fill('');
  await page.getByLabel('To date').fill('2000-01-01');
  await expect(page.getByText('No entries match')).toBeVisible();
  await page.close();
});

// ------------------------------------------------------------------------------------------------
test('notification targets: email "send test" lands in Mailpit; webhook receives a signed payload', async () => {
  const page = await adminCtx.newPage();
  await page.goto('/admin/notifications');
  const to = `e2e-notify-${stamp}@example.com`;

  await page.getByRole('button', { name: /Add target/ }).first().click();
  await page.getByRole('dialog').getByLabel('Email address').fill(to);
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Target added')).toBeVisible();
  const mailRow = page.getByRole('row').filter({ hasText: to });
  await mailRow.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText(/Test notification sent/)).toBeVisible();
  await expect.poll(async () => {
    const j = await (await fetch('http://localhost:8025/api/v1/messages')).json();
    return j.messages.some((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === to));
  }, { timeout: 20_000 }).toBeTruthy();

  // Webhook: local listener, signature verified with the secret shown once in the UI
  const got: { body: string; sig?: string }[] = [];
  const srv = createServer((req: IncomingMessage, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { got.push({ body: b, sig: req.headers['x-usdt-trace-signature'] as string }); res.end('ok'); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  await page.getByRole('button', { name: /Add target/ }).first().click();
  await page.getByRole('dialog').getByLabel('Type').selectOption('webhook');
  await page.getByRole('dialog').getByLabel('Webhook URL').fill(`http://127.0.0.1:${port}/hook`);
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  const secret = (await page.getByRole('dialog', { name: 'Webhook signing secret' }).locator('code').innerText()).trim();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('row').filter({ hasText: `127.0.0.1:${port}` }).getByRole('button', { name: 'Send test' }).click();
  await expect.poll(() => got.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(JSON.parse(got[0].body).event).toBe('test');
  expect(got[0].sig).toBe('sha256=' + createHmac('sha256', secret).update(got[0].body).digest('hex'));
  await shot(page, 'notifications');
  srv.close();

  // the list never re-shows the secret
  const list = await (await page.request.get('/api/notify-targets')).json();
  expect(JSON.stringify(list)).not.toContain(secret);

  // delete both
  for (const needle of [to, `127.0.0.1:${port}`]) {
    await page.getByRole('row').filter({ hasText: needle }).getByRole('button', { name: 'Delete target' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Delete/ }).click();
    await expect(page.getByRole('row').filter({ hasText: needle })).toHaveCount(0);
  }
  await page.close();
});

// ------------------------------------------------------------------------------------------------
test('custom role with a subset of permissions: UI and API enforce it', async ({ browser }) => {
  const page = await adminCtx.newPage();
  await page.goto('/admin/roles');
  await page.getByRole('button', { name: /New role/ }).click();
  const name = `E2E Reader ${stamp}`;
  await page.getByLabel('Name').fill(name);
  for (const p of ['View investigations', 'View cases', 'View monitoring']) await page.getByRole('checkbox', { name: new RegExp(p) }).check();
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText('Role created')).toBeVisible();
  await shot(page, 'custom-role');

  // system roles render read-only text, not inputs
  await page.getByRole('option', { name: /^Owner/ }).click();
  await expect(page.getByText('System role, read-only')).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveCount(0);

  const rid = (await (await adminCtx.request.get('/api/roles')).json()).find((r: { name: string }) => r.name === name).id;
  const email = await makeUser('role', rid, 'E2E Role user');
  const pw = 'Role-user-pass-12345';
  const { ctx, page: u } = await firstLogin(browser, email, pw);
  const nav = u.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Cases', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Labels', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  await u.goto('/cases');
  await expect(u.getByRole('button', { name: /New case/ })).toBeDisabled();
  await u.goto('/labels');
  await expect(u.getByText("You don't have permission for this")).toBeVisible();
  // API enforcement
  expect((await u.request.get('/api/cases')).status()).toBe(200);
  expect((await u.request.post('/api/cases', { data: { title: 'E2E nope' } })).status()).toBe(403);
  expect((await u.request.get('/api/labels')).status()).toBe(403);
  expect((await u.request.post('/api/screen', { data: { addresses: [BAD] } })).status()).toBe(403);
  expect((await u.request.get(`/api/address/${BAD}/report.csv`)).status()).toBe(403);
  expect((await u.request.get('/api/users')).status()).toBe(403);
  expect((await u.request.get('/api/audit')).status()).toBe(403);
  expect((await u.request.post('/api/roles', { data: { name: 'E2E x', permissions: [] } })).status()).toBe(403);
  await ctx.close();

  // a role still in use cannot be deleted; unknown permissions are refused
  expect((await adminCtx.request.delete(`/api/roles/${rid}`)).status()).toBe(400);
  expect((await adminCtx.request.post('/api/roles', { data: { name: 'E2E bad', permissions: ['nope.nope'] } })).status()).toBe(400);
  await page.close();
});

// ------------------------------------------------------------------------------------------------
test('alert triage: open -> reviewing -> closed', async () => {
  const BUSY = 'TU4vEruvZwLLkSfV9bNw12EJTPvNr7Pvaa';
  const wl = await (await adminCtx.request.post('/api/watchlists', { data: { name: `E2E triage ${stamp}` } })).json();
  await adminCtx.request.post(`/api/watchlists/${wl.id}/items`, { data: { addresses: [BUSY] } });
  const rule = await (await adminCtx.request.post(`/api/watchlists/${wl.id}/rules`, { data: { type: 'amount_over', params: { amount: 1 } } })).json();
  const detail = await (await adminCtx.request.get(`/api/watchlists/${wl.id}`)).json();
  sql(`INSERT INTO "Alert"("orgId","watchItemId","ruleId","dedupKey",chain,address,counterparty,amount,"txHash",detail,status,"createdAt","updatedAt")
       SELECT w."orgId",${detail.items[0].id},${rule.id},'e2e-${stamp}','tron','${BUSY}','${BAD}',123456,'e2e-hash','E2E triage alert','open',now(),now() FROM "Watchlist" w WHERE w.id=${wl.id}`);
  const page = await adminCtx.newPage();
  await page.goto('/alerts');
  await page.getByRole('row').filter({ hasText: `E2E triage ${stamp}` }).first().click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: 'Start review' }).click();
  await expect.poll(() => sql(`SELECT status FROM "Alert" WHERE "dedupKey"='e2e-${stamp}'`)).toBe('reviewing');
  // the open inbox no longer shows it; it is under Reviewing
  await expect(page.getByRole('row').filter({ hasText: `E2E triage ${stamp}` })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reviewing', exact: true }).click();
  await page.getByRole('row').filter({ hasText: `E2E triage ${stamp}` }).first().click();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => sql(`SELECT status FROM "Alert" WHERE "dedupKey"='e2e-${stamp}'`)).toBe('closed');
  await shot(page, 'alert-triage');
  // invalid status is rejected by the API
  const id = sql(`SELECT id FROM "Alert" WHERE "dedupKey"='e2e-${stamp}'`);
  expect((await adminCtx.request.patch(`/api/alerts/${id}`, { data: { status: 'nonsense' } })).status()).toBe(400);
  await adminCtx.request.delete(`/api/watchlists/${wl.id}`);
  await page.close();
});

// ------------------------------------------------------------------------------------------------
test('case files: upload, download, reject bad type/content, delete', async () => {
  const c = await (await adminCtx.request.post('/api/cases', { data: { title: `E2E files ${stamp}` } })).json();
  const page = await adminCtx.newPage();
  await page.goto(`/cases/${c.id}`);
  await page.getByRole('tab', { name: /Files/ }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'E2E evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E evidence content') });
  await expect(page.getByText('File uploaded')).toBeVisible();
  await expect(page.getByRole('link', { name: 'E2E evidence.txt' })).toBeVisible();
  await shot(page, 'case-files');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'E2E evidence.txt' }).click()]);
  expect(dl.suggestedFilename()).toBe('E2E evidence.txt');
  expect(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8')).toBe('E2E evidence content');
  // bad extension / spoofed content / html are refused
  const up = (name: string, data: string) => adminCtx.request.post(`/api/cases/${c.id}/files`, { multipart: { file: { name, mimeType: 'application/octet-stream', buffer: Buffer.from(data) } } });
  expect((await up('evil.html', '<script>alert(1)</script>')).status()).toBe(400);
  expect((await up('evil.exe', 'MZ')).status()).toBe(400);
  expect((await up('fake.pdf', 'not a pdf')).status()).toBe(400);
  expect((await up('..%2F..%2Fescape.txt', 'x')).ok()).toBeTruthy(); // name is sanitised, never used as a path
  const files = (await (await adminCtx.request.get(`/api/cases/${c.id}`)).json()).files;
  expect(files.every((f: { name: string }) => !f.name.includes('/'))).toBeTruthy();
  // delete via the UI
  await page.reload();
  await page.getByRole('tab', { name: /Files/ }).click();
  await page.getByRole('row').filter({ hasText: 'E2E evidence.txt' }).getByRole('button', { name: 'Delete file' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Delete/ }).click();
  await expect(page.getByText('File deleted')).toBeVisible();
  await expect(page.getByRole('link', { name: 'E2E evidence.txt' })).toHaveCount(0);
  await adminCtx.request.delete(`/api/cases/${c.id}`);
  await page.close();
});

// ------------------------------------------------------------------------------------------------
test('attribution: temporary exchange label, clustering run, accept and reject suggestions', async () => {
  const lab = await (await adminCtx.request.post('/api/labels', { data: { address: BAD, name: `E2E Exchange ${stamp}`, category: 'exchange' } })).json();
  const orgId = sql(`SELECT "orgId" FROM "Label" WHERE id=${lab.id}`);
  const page = await adminCtx.newPage();
  await page.goto('/attribution');
  await page.getByRole('button', { name: 'Run clustering' }).click();
  await expect(page.getByText('Clustering started')).toBeVisible();
  await expect.poll(() => sql(`SELECT status FROM "Job" WHERE type='cluster' ORDER BY id DESC LIMIT 1`), { timeout: 180_000 }).toMatch(/done|failed/);
  expect(sql(`SELECT status FROM "Job" WHERE type='cluster' ORDER BY id DESC LIMIT 1`)).toBe('done');

  // Real evidence may or may not produce suggestions; seed two so accept/reject are always exercised.
  const A1 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
  const A2 = 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy';
  for (const a of [A1, A2]) {
    sql(`INSERT INTO "ClusterSuggestion"("orgId",chain,address,name,category,confidence,evidence,status,"createdAt") VALUES (${orgId},'tron','${a}','E2E Exchange deposit','exchange',0.8,'{"hotWallet":"${BAD}","outToHot":900,"totalOut":950,"depositors":4}','pending',now())`);
  }
  await page.reload();
  const r1 = page.getByRole('row').filter({ hasText: A1.slice(0, 6) });
  await r1.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Label created')).toBeVisible();
  expect(sql(`SELECT count(*) FROM "Label" WHERE address='${A1}' AND source='cluster'`)).toBe('1');
  const r2 = page.getByRole('row').filter({ hasText: A2.slice(0, 6) });
  await r2.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Suggestion rejected')).toBeVisible();
  expect(sql(`SELECT count(*) FROM "Label" WHERE address='${A2}'`)).toBe('0');
  expect(sql(`SELECT status FROM "ClusterSuggestion" WHERE address='${A2}' AND "orgId"=${orgId}`)).toBe('rejected');
  // accepted twice -> API refuses
  const sid = sql(`SELECT id FROM "ClusterSuggestion" WHERE address='${A1}' AND "orgId"=${orgId}`);
  expect((await adminCtx.request.post(`/api/attribution/suggestions/${sid}/accept`)).status()).toBe(400);
  await shot(page, 'attribution');

  // cleanup of this test's data
  sql(`DELETE FROM "Label" WHERE source='cluster' AND address IN ('${A1}','${A2}')`);
  sql(`DELETE FROM "ClusterSuggestion" WHERE address IN ('${A1}','${A2}') OR name LIKE 'E2E Exchange%'`);
  await adminCtx.request.delete(`/api/labels/${lab.id}`);
  await page.close();
});

// ------------------------------------------------------------------------------------------------
test('security posture: cross-origin / non-JSON state changes refused, cookie flags, headers', async ({ playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: 'http://localhost:4000' });
  // login is JSON-only: a plain HTML form post (urlencoded / text) is refused
  expect((await anon.post('/api/auth/login', { form: { email: ADMIN.email, password: ADMIN.password } })).status()).toBe(415);
  expect((await anon.post('/api/auth/login', { headers: { 'content-type': 'text/plain' }, data: JSON.stringify(ADMIN) })).status()).toBe(415);
  // cross-origin JSON is refused even with valid credentials
  expect((await anon.post('/api/auth/login', { headers: { Origin: 'https://evil.example' }, data: ADMIN })).status()).toBe(403);
  const cookies = await adminCtx.cookies();
  const sid = cookies.find((c) => c.name === 'sid')!;
  expect(sid.httpOnly).toBe(true);
  expect(sid.sameSite).toBe('Lax');
  // authenticated state change from another origin is refused
  const withCookie = await playwright.request.newContext({ baseURL: 'http://localhost:4000', extraHTTPHeaders: { cookie: `sid=${sid.value}`, Origin: 'https://evil.example' } });
  expect((await withCookie.post('/api/cases', { data: { title: 'E2E csrf' } })).status()).toBe(403);
  const h = (await anon.get('/api/health')).headers();
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-powered-by']).toBeUndefined();
  expect(sql(`SELECT count(*) FROM "Case" WHERE title='E2E csrf'`)).toBe('0');
});
