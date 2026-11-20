'use client';
import { Bell, Briefcase, ScanSearch, Search, Tag } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AddressLink } from '@/components/Risk';
import { Badge, Button, Card, EmptyState, Input, LinkButton, PageHeader, SkeletonRows, Stat, Time } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { ChainChoice } from '@/components/Assets';
import { addrHref, Chain, detectChain, detectTx, num, short } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Alert { id: number; chain: string; address: string; counterparty?: string; amount: number; status: string; createdAt: string; rule?: { type: string }; watchItem?: { watchlist?: { name: string } } }
interface CaseRow { id: number; title: string; status: string; updatedAt: string; addresses: number }
interface Job { id: number; name: string; status: string; progress: number; total: number; createdAt: string }
interface LabelStatus { counts: Record<string, number> }

const RULE: Record<string, string> = { amount_over: 'Large transfer', flagged_counterparty: 'Flagged counterparty', volume_spike: 'Volume spike' };

export default function Dashboard() {
  const { can, me } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [evm, setEvm] = useState<'eth' | 'bsc'>('eth');
  const [err, setErr] = useState('');
  const alerts = useApi<{ rows: Alert[]; total: number }>(can('monitor.view') ? '/alerts?status=open' : null);
  const cases = useApi<CaseRow[]>(can('cases.view') ? '/cases' : null);
  const jobs = useApi<Job[]>(can('investigate.view') ? '/screen' : null);
  const labels = useApi<LabelStatus>(can('labels.view') ? '/labels/status' : null);
  const week = Date.now() - 7 * 864e5;
  const activeCases = cases.data?.filter((c) => c.status === 'open').length;
  const weekJobs = jobs.data?.filter((j) => Date.parse(j.createdAt) > week).length;
  const labelTotal = labels.data ? Object.values(labels.data.counts).reduce((a, b) => a + b, 0) : undefined;
  const v = (r: { loading: boolean; error: string }, x: number | undefined) => (r.loading ? '…' : r.error || x === undefined ? '—' : x.toLocaleString());

  function go(e: React.FormEvent) {
    e.preventDefault();
    const s = q.trim();
    const tx = detectTx(s);
    if (detectChain(s)) router.push(addrHref(s, evm));
    else if (tx) router.push(`/tx/${tx === 'eth' ? evm : tx}/${s}`);
    else setErr('Enter a valid Tron (T…) or Ethereum / BNB Chain (0x…) address, or a transaction hash.');
  }

  return (
    <div className="page stack" style={{ gap: 20 }}>
      <PageHeader title={`Welcome back${me?.name ? `, ${me.name.split(' ')[0]}` : ''}`} sub="Trace USDT and USDC flows, screen wallets and monitor risk on Tron, Ethereum and BNB Chain." />
      {can('investigate.view') && (
        <form className="card card-b stack sm" onSubmit={go} role="search" style={{ background: 'linear-gradient(135deg, var(--accent-soft), transparent 60%), var(--surface)' }}>
          <h2>Investigate a wallet or transaction</h2>
          <div className="row nw">
            <div className="grow" style={{ position: 'relative' }}>
              <Input className="mono" style={{ height: 44, fontSize: 14 }} value={q} onChange={(e) => { setQ(e.target.value); setErr(''); }} placeholder="T… / 0x… address or transaction hash" aria-label="Address or transaction hash" spellCheck={false} aria-invalid={!!err} />
            </div>
            <Button variant="primary" type="submit" style={{ height: 44 }}><Search size={16} />Investigate</Button>
          </div>
          <ChainChoice addr={/^0x[0-9a-fA-F]{64}$/.test(q.trim()) ? '0x' + q.trim().slice(-40) : q} value={evm as Chain} onChange={setEvm} />
          {err ? <span className="small bad" role="alert">{err}</span> : <span className="xs muted">Tron is detected automatically; for 0x input pick Ethereum or BNB Chain. Try the Graph workspace for a visual trace.</span>}
        </form>
      )}
      <div className="kpis">
        {can('monitor.view') && <Stat href="/alerts" icon={<Bell size={14} />} label="Open alerts" value={v(alerts, alerts.data?.total)} tone={alerts.data?.total ? 'var(--severe)' : undefined} sub="Needs triage" />}
        {can('cases.view') && <Stat href="/cases" icon={<Briefcase size={14} />} label="Active cases" value={v(cases, activeCases)} sub={cases.data ? `${cases.data.length} total` : undefined} />}
        {can('investigate.view') && <Stat href="/screening" icon={<ScanSearch size={14} />} label="Screenings this week" value={v(jobs, weekJobs)} sub="Bulk screening jobs" />}
        {can('labels.view') && <Stat href="/labels" icon={<Tag size={14} />} label="Labels" value={v(labels, labelTotal)} sub={labels.data ? Object.entries(labels.data.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${num(n)}`).join(' · ') : undefined} />}
      </div>
      <div className="grid g3">
        {can('monitor.view') && (
          <Card title="Recent alerts" flush actions={<LinkButton href="/alerts" sm variant="ghost">View all</LinkButton>}>
            {alerts.loading ? <SkeletonRows rows={4} /> : alerts.error ? <EmptyState title="Alerts unavailable">{alerts.error}</EmptyState> : !alerts.data?.rows.length ? (
              <EmptyState title="No open alerts" action={<LinkButton href="/monitoring" sm>Set up monitoring</LinkButton>}>Add wallets to a watchlist and rules to get alerted on new activity.</EmptyState>
            ) : alerts.data.rows.slice(0, 6).map((a) => (
              <Link key={a.id} href="/alerts" className="row nw" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', color: 'inherit' }}>
                <div className="grow"><div className="small" style={{ fontWeight: 600 }}>{RULE[a.rule?.type ?? ''] ?? 'Alert'} · {num(a.amount)} USDT</div><div className="xs muted mono">{short(a.address)} · {a.watchItem?.watchlist?.name}</div></div>
                <span className="xs muted"><Time t={a.createdAt} /></span>
              </Link>
            ))}
          </Card>
        )}
        {can('cases.view') && (
          <Card title="Recent cases" flush actions={<LinkButton href="/cases" sm variant="ghost">View all</LinkButton>}>
            {cases.loading ? <SkeletonRows rows={4} /> : cases.error ? <EmptyState title="Cases unavailable">{cases.error}</EmptyState> : !cases.data?.length ? (
              <EmptyState title="No cases yet" action={can('cases.manage') ? <LinkButton href="/cases?new=1" sm variant="primary">Create a case</LinkButton> : undefined}>Cases hold the addresses, graph and notes of an investigation.</EmptyState>
            ) : cases.data.slice(0, 6).map((c) => (
              <Link key={c.id} href={`/cases/${c.id}`} className="row nw" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', color: 'inherit' }}>
                <div className="grow trunc"><div className="small trunc" style={{ fontWeight: 600 }}>{c.title}</div><div className="xs muted">{c.addresses} {c.addresses === 1 ? 'address' : 'addresses'} · <Time t={c.updatedAt} /></div></div>
                <Badge tone={c.status === 'open' ? 'info' : undefined}>{c.status}</Badge>
              </Link>
            ))}
          </Card>
        )}
        {can('investigate.view') && (
          <Card title="Recent screening jobs" flush actions={<LinkButton href="/screening" sm variant="ghost">View all</LinkButton>}>
            {jobs.loading ? <SkeletonRows rows={4} /> : jobs.error ? <EmptyState title="Screening unavailable">{jobs.error}</EmptyState> : !jobs.data?.length ? (
              <EmptyState title="No screenings yet" action={<LinkButton href="/screening" sm variant="primary">Screen addresses</LinkButton>}>Check up to 1,000 wallets against sanctions, freezes and risky exposure.</EmptyState>
            ) : jobs.data.slice(0, 6).map((j) => (
              <Link key={j.id} href={`/screening?job=${j.id}`} className="row nw" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', color: 'inherit' }}>
                <div className="grow trunc"><div className="small trunc" style={{ fontWeight: 600 }}>{j.name || `Job #${j.id}`}</div><div className="xs muted">{j.total} {j.total === 1 ? 'address' : 'addresses'} · <Time t={j.createdAt} /></div></div>
                <Badge tone={j.status === 'done' ? 'good' : j.status === 'failed' ? 'severe' : 'info'}>{j.status === 'running' ? `${j.progress}/${j.total}` : j.status}</Badge>
              </Link>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
