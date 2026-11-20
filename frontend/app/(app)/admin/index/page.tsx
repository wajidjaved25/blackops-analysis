'use client';
import { Database, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { ConfirmDialog } from '@/components/Modal';
import { AddressLink } from '@/components/Risk';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, SkeletonRows, Stat, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useApi } from '@/lib/hooks';

type St = 'pending' | 'backfilling' | 'complete' | 'capped' | 'error';
interface Status {
  transfers: { count: number; approx: boolean };
  addresses: Partial<Record<St, number>>;
  tailer: { chain: string; enabled: boolean; cursorTs: number | null; lagMs: number | null; rowsTotal: number; rowsPerMin: number; error: string | null; needs: string | null }[];
  reads: { db: number; sync: number; api: number };
  upstream: { calls: number; byHost: Record<string, number> };
  config: { maxPerAddress: number; freshSec: number };
}
interface Row { id: number; chain: 'tron' | 'eth'; address: string; status: St; reason: string; rowCount: number; oldestTs: number | null; newestTs: number | null; lastSyncAt: string | null; error: string | null }

const TONE: Record<St, 'good' | 'medium' | 'info' | 'severe'> = { complete: 'good', capped: 'medium', backfilling: 'info', pending: 'info', error: 'severe' };
const PAGE = 50;
const lag = (ms: number | null) => (ms === null ? '—' : ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

export default function DataIndex() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(0);
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState('');
  const [rm, setRm] = useState<Row | null>(null);
  const status = useApi<Status>('/index/status', (s) => ((s.addresses.backfilling ?? 0) + (s.addresses.pending ?? 0) > 0 || s.tailer.some((t) => t.enabled) ? 5000 : false));
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (q.trim()) qs.set('q', q.trim());
  if (state) qs.set('status', state);
  const list = useApi<{ rows: Row[]; total: number }>(`/index/addresses?${qs}`, (l) => (l.rows.some((r) => r.status === 'backfilling' || r.status === 'pending') ? 4000 : false));
  const s = status.data;

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); toast.success(ok); status.reload(); list.reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(''); }
  }
  const enc = encodeURIComponent;
  const done = (s?.addresses.complete ?? 0) + (s?.addresses.capped ?? 0);
  const queued = (s?.addresses.pending ?? 0) + (s?.addresses.backfilling ?? 0);
  const reads = s ? s.reads.db + s.reads.sync + s.reads.api : 0;

  return (
    <RequirePerm perm="index.manage">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="Data index" sub="Our own copy of the chain: wallets we have downloaded in full are read from Postgres instead of the rate-limited explorer API." crumbs={[{ label: 'Admin' }, { label: 'Data index' }]} />

        {status.error ? <div className="card"><ErrorState error={status.error} status={status.status} onRetry={status.reload} /></div> : (
          <div className="kpis">
            <Stat icon={<Database size={14} />} label="Stored transfers" value={s ? `${s.transfers.approx ? '≈ ' : ''}${s.transfers.count.toLocaleString()}` : '…'} sub="USDT, all chains" />
            <Stat label="Indexed wallets" value={s ? done.toLocaleString() : '…'} sub={s ? <>{s.addresses.capped ?? 0} capped · {queued} queued · {s.addresses.error ?? 0} failed</> : undefined} />
            <Stat label="Reads since start" value={s ? reads.toLocaleString() : '…'} sub={s ? <>{s.reads.db} index · {s.reads.sync} synced · {s.reads.api} live API</> : undefined} />
            <Stat label="Explorer API calls" value={s ? s.upstream.calls.toLocaleString() : '…'} sub="real HTTP calls since start" />
          </div>
        )}

        <Card title="Full-chain tailer" actions={<span className="muted small">Set <code>INDEX_TAIL</code> in backend/.env</span>}>
          {!s ? <SkeletonRows rows={2} /> : (
            <div className="stack">
              {!s.tailer.some((t) => t.enabled) && (
                <Notice>The tailer is <b>off</b> (default). With it on, every USDT transfer is stored as it happens, but free TronGrid is rate-limited and cannot be relied on to keep up with roughly 2–3 million transfers a day. Use a paid key or your own node before turning it on for real.</Notice>
              )}
              <Table caption="Tailer status" rows={s.tailer} rowKey={(t) => t.chain} pageSize={5} cols={[
                { key: 'c', header: 'Chain', cell: (t) => <b>{t.chain === 'tron' ? 'Tron' : 'Ethereum'}</b> },
                { key: 's', header: 'State', cell: (t) => (t.error ? <Badge tone="severe" title={t.error}>Error</Badge> : t.needs ? <Badge tone="medium" title={`${t.needs} is not set`}>Needs {t.needs}</Badge> : t.enabled ? <Badge tone="good">Running</Badge> : <Badge tone="outline">Off</Badge>) },
                { key: 'l', header: 'Lag', num: true, cell: (t) => (t.enabled && t.lagMs !== null ? lag(t.lagMs) : '—') },
                { key: 'r', header: 'Rows / min', num: true, cell: (t) => (t.enabled ? num(t.rowsPerMin) : '—') },
                { key: 't', header: 'Rows stored', num: true, cell: (t) => (t.rowsTotal ? t.rowsTotal.toLocaleString() : '—') },
                { key: 'e', header: 'Newest data', hideSm: true, cell: (t) => <Time t={t.cursorTs} /> },
              ]} />
            </div>
          )}
        </Card>

        <Card flush title={<span className="row">
          <Input sm style={{ width: 240 }} aria-label="Search wallets" placeholder="Search address" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          <Select sm style={{ width: 150 }} aria-label="Status" value={state} onChange={(e) => { setState(e.target.value); setPage(0); }}>
            <option value="">All statuses</option>
            {(['complete', 'capped', 'backfilling', 'pending', 'error'] as St[]).map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        </span>} actions={<form className="row" onSubmit={(e) => { e.preventDefault(); if (add.trim()) act('add', () => api('/index/addresses', { body: { address: add.trim() } }).then(() => setAdd('')), 'Backfill queued'); }}>
          <Field><Input sm style={{ width: 280 }} aria-label="Wallet to index" placeholder="Tron or Ethereum address to backfill" value={add} onChange={(e) => setAdd(e.target.value)} /></Field>
          <Button sm variant="primary" type="submit" busy={busy === 'add'} disabled={!add.trim()}><Plus size={14} />Backfill</Button>
        </form>}>
          {list.loading ? <SkeletonRows rows={6} /> : list.error ? <ErrorState error={list.error} status={list.status} onRetry={list.reload} /> : (
            <Table caption="Indexed wallets" rows={list.data?.rows ?? []} rowKey={(r) => r.id} pageSize={PAGE} server={{ page, total: list.data?.total ?? 0, pageSize: PAGE, onPage: setPage }}
              empty={<EmptyState icon={<Database size={22} />} title={q || state ? 'No wallets match' : 'No wallets indexed yet'}>Searching an address queues a background backfill automatically.</EmptyState>}
              cols={[
                { key: 'a', header: 'Wallet', wrap: true, cell: (r) => <AddressLink address={r.address} /> },
                { key: 's', header: 'Status', cell: (r) => <Badge tone={TONE[r.status]} title={r.error ?? undefined}>{r.status}</Badge> },
                { key: 'n', header: 'Transfers', num: true, cell: (r) => r.rowCount.toLocaleString() },
                { key: 'o', header: 'Oldest', hideSm: true, cell: (r) => <Time t={r.oldestTs} /> },
                { key: 'w', header: 'Newest', hideSm: true, cell: (r) => <Time t={r.newestTs} /> },
                { key: 'y', header: 'Last sync', hideSm: true, cell: (r) => <Time t={r.lastSyncAt} /> },
                { key: 'r', header: 'Reason', hideSm: true, cell: (r) => <Badge tone="outline">{r.reason}</Badge> },
                { key: 'x', header: '', cell: (r) => (
                  <span className="row nw" style={{ justifyContent: 'flex-end' }}>
                    <Button sm title="Fetch only transfers newer than the newest stored" disabled={r.status !== 'complete' && r.status !== 'capped'} busy={busy === `s${r.id}`} onClick={() => act(`s${r.id}`, () => api(`/index/addresses/${enc(r.address)}/sync`, { method: 'POST', body: {} }), 'Synced')}><RefreshCw size={13} />Re-sync</Button>
                    <Button sm title="Download the full history again" disabled={r.status === 'backfilling'} busy={busy === `b${r.id}`} onClick={() => act(`b${r.id}`, () => api('/index/addresses', { body: { address: r.address } }), 'Backfill queued')}>Backfill</Button>
                    <Button sm variant="danger" aria-label={`Remove ${r.address}`} disabled={r.status === 'backfilling'} onClick={() => setRm(r)}><Trash2 size={13} /></Button>
                  </span>
                ) },
              ]} />
          )}
        </Card>
        {s && <p className="muted small">Wallets above {s.config.maxPerAddress.toLocaleString()} transfers are marked <b>capped</b> (newest kept). Covered wallets are re-synced after {s.config.freshSec / 60} min; watched wallets on every monitoring poll.</p>}

        {rm && <ConfirmDialog title="Remove from index" confirmLabel="Remove" onClose={() => setRm(null)} onConfirm={async () => {
          const r = rm; setRm(null);
          await act(`d${r.id}`, () => api(`/index/addresses/${enc(r.address)}`, { method: 'DELETE' }), 'Removed');
        }}>Reads for <b className="mono">{rm.address}</b> go back to the live explorer API. Stored transfers are kept because other wallets&apos; histories share them.</ConfirmDialog>}
      </div>
    </RequirePerm>
  );
}
