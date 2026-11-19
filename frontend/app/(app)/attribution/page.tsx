'use client';
import { Check, Fingerprint, X } from 'lucide-react';
import { useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { AddressLink, CategoryChip } from '@/components/Risk';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, ErrorState, Notice, PageHeader, Select, SkeletonRows, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { num } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Job { id: number; status: string; progress: number; total: number; createdAt: string; error?: string }
interface Sug { id: number; chain: string; address: string; name: string; category: string; confidence: number; evidence: { hotWallet?: string; outToHot?: number; totalOut?: number; depositors?: number }; status: string; createdAt: string }

export default function Attribution() {
  const { can } = useAuth();
  const toast = useToast();
  const jobs = useApi<Job[]>('/attribution/jobs', (d) => (d.some((j) => j.status === 'queued' || j.status === 'running') ? 3000 : false));
  const sugs = useApi<Sug[]>('/attribution/suggestions?status=pending');
  const exchanges = useApi<{ rows: { id: number; name: string; address: string }[] }>('/labels?category=exchange');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const run = can('attribution.run'), review = can('attribution.review');

  async function act(id: number, what: 'accept' | 'reject') {
    try { await api(`/attribution/suggestions/${id}/${what}`, { method: 'POST' }); toast.success(what === 'accept' ? 'Label created' : 'Suggestion rejected'); sugs.reload(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <RequirePerm perm={['attribution.run', 'attribution.review']}>
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="Attribution" sub="Cluster exchange deposit addresses from on-chain behaviour and review the suggestions." crumbs={[{ label: 'Intelligence' }, { label: 'Attribution' }]} />
        <Card title="Run clustering">
          <div className="row">
            <Select style={{ width: 280 }} aria-label="Exchange label" value={label} onChange={(e) => setLabel(e.target.value)} disabled={!run}>
              <option value="">All visible exchange labels (max 20)</option>
              {(exchanges.data?.rows ?? []).map((l) => <option key={l.id} value={l.id}>{l.name} · {l.address.slice(0, 8)}…</option>)}
            </Select>
            <Button variant="primary" busy={busy} disabled={!run} title={run ? '' : 'Requires attribution.run'} onClick={async () => {
              setBusy(true);
              try { await api('/attribution/run', { body: label ? { labelId: Number(label) } : {} }); toast.success('Clustering started'); jobs.reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
            }}><Fingerprint size={15} />Run clustering</Button>
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>Finds addresses that sweep their funds into a known exchange hot wallet, a strong sign they are that exchange&apos;s deposit addresses.</p>
        </Card>
        <div className="grid g-main" style={{ alignItems: 'start' }}>
          <Card title="Suggestions to review" flush>
            {sugs.loading ? <SkeletonRows /> : sugs.error ? <ErrorState error={sugs.error} status={sugs.status} onRetry={sugs.reload} /> : (
              <Table caption="Attribution suggestions" rows={sugs.data ?? []} rowKey={(s) => s.id} pageSize={15} initialSort={{ key: 'c', dir: 'desc' }}
                empty={<EmptyState icon={<Fingerprint size={22} />} title="Nothing to review">Run clustering to generate suggestions.</EmptyState>}
                cols={[
                  { key: 'a', header: 'Address', wrap: true, cell: (s) => <AddressLink address={s.address} /> },
                  { key: 'n', header: 'Suggested label', cell: (s) => <CategoryChip category={s.category} name={s.name} /> },
                  { key: 'c', header: 'Confidence', num: true, sort: (s) => s.confidence, cell: (s) => `${Math.round(s.confidence <= 1 ? s.confidence * 100 : s.confidence)}%` },
                  { key: 'e', header: 'Evidence', wrap: true, cell: (s) => <span className="small muted">{num(s.evidence?.outToHot)} of {num(s.evidence?.totalOut)} USDT sent to the hot wallet; {s.evidence?.depositors ?? '?'} depositors</span> },
                  { key: 'x', header: '', cell: (s) => <span className="row nw"><Button sm variant="primary" disabled={!review} aria-label="Accept" onClick={() => act(s.id, 'accept')}><Check size={13} />Accept</Button><Button sm disabled={!review} aria-label="Reject" onClick={() => act(s.id, 'reject')}><X size={13} />Reject</Button></span> },
                ]} />
            )}
            {!review && <div style={{ padding: 12 }}><Notice tone="warn">Reviewing requires the attribution.review permission.</Notice></div>}
          </Card>
          <Card title="Jobs" flush>
            {jobs.loading ? <SkeletonRows rows={3} /> : jobs.error ? <ErrorState error={jobs.error} status={jobs.status} onRetry={jobs.reload} /> : (
              <Table caption="Clustering jobs" rows={jobs.data ?? []} rowKey={(j) => j.id} pageSize={8} empty={<EmptyState title="No jobs yet" />}
                cols={[
                  { key: 's', header: 'Status', cell: (j) => <Badge tone={j.status === 'done' ? 'good' : j.status === 'failed' ? 'severe' : 'info'} title={j.error}>{j.status}</Badge> },
                  { key: 'p', header: 'Progress', cell: (j) => <div style={{ width: 80 }}><div className="progress"><i style={{ width: `${j.total ? (j.progress / j.total) * 100 : j.status === 'done' ? 100 : 0}%` }} /></div></div> },
                  { key: 't', header: 'Started', cell: (j) => <Time t={j.createdAt} /> },
                ]} />
            )}
          </Card>
        </div>
      </div>
    </RequirePerm>
  );
}
