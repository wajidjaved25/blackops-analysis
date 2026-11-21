// Playwright globalTeardown: delete the "E2E ..." cases the specs leave behind (cascades to their transactions, analyses and stored uploads).
export default async function teardown() {
  const base = `${process.env.E2E_BASE ?? process.env.PW_BASE_URL ?? 'http://localhost:3000'}/api`;
  try {
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse-battery' }) });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    if (!login.ok || !cookie) return;
    const cases: { id: number; title: string }[] = await (await fetch(`${base}/cases`, { headers: { cookie } })).json();
    for (const c of cases.filter((x) => x.title.startsWith('E2E '))) await fetch(`${base}/cases/${c.id}`, { method: 'DELETE', headers: { cookie } });
  } catch {
    /* cleanup is best effort: the servers may already be stopped */
  }
}
