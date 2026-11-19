'use client';
import { Bell, Network } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { Drawer } from '@/components/Modal';
import { AddressLink, TxLink } from '@/components/Risk';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, DateTime, EmptyState, ErrorState, LinkButton, PageHeader, Segmented, Select, SkeletonRows, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { num } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Alert { id: number; chain: string; address: string; counterparty?: string; amount: number; txHash?: string; detail?: string; status: string; createdAt: string; rule?: { type: string }; watchItem?: { note?: string; watchlist?: { id: number; name: string } } }
const RULE: Record<string, string> = { amount_over: 'Large transfer', flagged_counterparty: 'Flagged counterparty', volume_spike: 'Volume spike' };
const tone = (s: string) => (s === 'open' ? 'severe' : s === 'reviewing' ? 'medium' : 'good');

export default function Alerts() {
  const { can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const [wl, setWl] = useState('');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<string | number>>(new Set());
  const [open, setOpen] = useState<Alert | null>(null);
  const lists = useApi<{ id: number; name: string }[]>('/watchlists');
  const qs = `status=${status === 'all' ? '' : status}&watchlistId=${wl}&page=${page}`;
  const { data, loading, error, status: st, reload } = useApi<{ rows: Alert[]; total: number; pageSize: number }>(`/alerts?${qs}`);
  const triage = can('alerts.triage');

  async function setS(ids: number[], s: string) {
    const r = await Promise.allSettled(ids.map((id) => api(`/alerts/${id}`, { method: 'PATCH', body: { status: s } })));
    const bad = r.filter((x) => x.status === 'rejected').length;
    if (bad) toast.error(`${bad} update${bad > 1 ? 's' : ''} failed`); else toast.success(`${ids.length} alert${ids.length > 1 ? 's' : ''} marked ${s}`);
    setSel(new Set()); setOpen(null); reload();
  }
  return (
    <RequirePerm perm="monitor.view">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="Alerts" sub="Triage activity flagged by your watchlist rules." crumbs={[{ label: 'Compliance' }, { label: 'Alerts' }]} />
        <Card flush actions={undefined} title={
          <span className="row">
            <Segmented label="Status" value={status} onChange={(v) => { setStatus(v); setPage(0); setSel(new Set()); }} options={[{ id: 'open', label: 'Open' }, { id: 'reviewing', label: 'Reviewing' }, { id: 'closed', label: 'Closed' }, { id: 'all', label: 'All' }]} />
            <Select sm style={{ width: 190 }} aria-label="Watchlist" value={wl} onChange={(e) => { setWl(e.target.value); setPage(0); }}><option value="">All watchlists</option>{(lists.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
            {sel.size > 0 && <span className="row"><span className="muted small">{sel.size} selected</span>
              <Button sm disabled={!triage} onClick={() => setS([...sel] as number[], 'reviewing')}>Mark reviewing</Button>
              <Button sm disabled={!triage} onClick={() => setS([...sel] as number[], 'closed')}>Close</Button>
              <Button sm disabled={!triage} onClick={() => setS([...sel] as number[], 'open')}>Reopen</Button></span>}
          </span>}>
          {loading ? <SkeletonRows /> : error ? <ErrorState error={error} status={st} onRetry={reload} /> : (
            <Table caption="Alerts" rows={data?.rows ?? []} rowKey={(a) => a.id} pageSize={50} selectable={triage ? { selected: sel, onChange: setSel } : undefined}
              server={{ page, total: data?.total ?? 0, pageSize: data?.pageSize ?? 50, onPage: setPage }} onRowClick={setOpen}
              empty={<EmptyState icon={<Bell size={22} />} title={status === 'open' ? 'Inbox zero' : 'No alerts here'} action={<LinkButton href="/monitoring" sm>Manage watchlists &amp; rules</LinkButton>}>No {status === 'all' ? '' : status} alerts match. New activity on watched wallets will show up here.</EmptyState>}
              cols={[
                { key: 's', header: 'Status', cell: (a) => <Badge tone={tone(a.status)}>{a.status}</Badge> },
                { key: 'r', header: 'Rule', cell: (a) => RULE[a.rule?.type ?? ''] ?? '—' },
                { key: 'a', header: 'Address', cell: (a) => <AddressLink address={a.address} noCopy /> },
                { key: 'm', header: 'Amount', num: true, cell: (a) => `${num(a.amount)} USDT` },
                { key: 'w', header: 'Watchlist', cell: (a) => <span className="muted">{a.watchItem?.watchlist?.name}</span> },
                { key: 't', header: 'When', cell: (a) => <Time t={a.createdAt} /> },
              ]} />
          )}
        </Card>
        {open && (
          <Drawer title={`Alert #${open.id}`} onClose={() => setOpen(null)}>
            <div className="stack">
              <div className="row"><Badge tone={tone(open.status)}>{open.status}</Badge><strong>{RULE[open.rule?.type ?? ''] ?? 'Alert'}</strong></div>
              <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
                <dt>Watched address</dt><dd><AddressLink address={open.address} /></dd>
                {open.counterparty && <><dt>Counterparty</dt><dd><AddressLink address={open.counterparty} /></dd></>}
                <dt>Amount</dt><dd>{num(open.amount)} USDT</dd>
                {open.txHash && <><dt>Transaction</dt><dd><TxLink hash={open.txHash} chain={open.chain} /></dd></>}
                <dt>Watchlist</dt><dd>{open.watchItem?.watchlist ? <Link href={`/monitoring/${open.watchItem.watchlist.id}`}>{open.watchItem.watchlist.name}</Link> : '—'}</dd>
                <dt>Raised</dt><dd><DateTime t={open.createdAt} /></dd>
              </dl>
              {open.detail && <p className="muted small">{open.detail}</p>}
              <div className="row"><LinkButton href={`/address/${open.address}`} sm>Address</LinkButton><LinkButton href={`/graph?addr=${open.address}`} sm><Network size={13} />Graph</LinkButton>{open.txHash && <LinkButton href={`/tx/${open.chain}/${open.txHash}`} sm>Transaction</LinkButton>}</div>
              <hr style={{ width: '100%', border: 0, borderTop: '1px solid var(--border)' }} />
              <div className="row">{(['open', 'reviewing', 'closed'] as const).map((s) => <Button key={s} sm variant={open.status === s ? 'primary' : undefined} disabled={!triage || open.status === s} onClick={() => setS([open.id], s)}>{s === 'open' ? 'Reopen' : s === 'reviewing' ? 'Start review' : 'Close'}</Button>)}</div>
              {!triage && <span className="xs muted">Requires alerts.triage to change status.</span>}
            </div>
          </Drawer>
        )}
      </div>
    </RequirePerm>
  );
}
