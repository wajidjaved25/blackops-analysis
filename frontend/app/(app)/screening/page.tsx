'use client';
import { Download, ScanSearch, Upload } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useRef, useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { AddressLink, CategoryChip, RiskBadge } from '@/components/Risk';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Notice, PageHeader, Segmented, SkeletonRows, Textarea, Input, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { detectChain } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Job { id: number; name: string; status: 'queued' | 'running' | 'done' | 'failed'; progress: number; total: number; createdAt: string; error?: string }
interface Row { chain: string; address: string; score: number; level: string; frozen: boolean; labels: { name: string; category: string }[]; reasons: string[]; error?: string }
interface Detail { id: number; status: string; progress: number; total: number; error?: string; rows: Row[] }

const tone = (s: string) => (s === 'done' ? 'good' : s === 'failed' ? 'severe' : 'info');

function Screening() {
  const { can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const job = sp.get('job');
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [lvl, setLvl] = useState('all');
  const jobs = useApi<Job[]>('/screen', (d) => (d.some((j) => j.status === 'queued' || j.status === 'running') ? 3000 : false));
  const detail = useApi<Detail>(job ? `/screen/${job}` : null, (d) => (d.status === 'queued' || d.status === 'running' ? 2500 : false));

  const parsed = useMemo(() => {
    const toks = (text + '\n' + csv).split(/[\s,;"']+/).filter(Boolean);
    const ok = [...new Set(toks.filter((t) => detectChain(t)))];
    return { ok, bad: toks.filter((t) => !detectChain(t) && /^(T|0x)/i.test(t)).length };
  }, [text, csv]);
  const canRun = can('screen.run');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!parsed.ok.length) return setErr('Paste at least one valid address.');
    if (parsed.ok.length > 1000) return setErr('A job can hold at most 1,000 addresses.');
    setBusy(true); setErr('');
    try {
      const r = await api<{ id: number; total: number }>('/screen', { body: { name: name.trim() || undefined, addresses: parsed.ok } });
      toast.success(`Screening started for ${r.total} addresses`);
      setText(''); setCsv(''); setName(''); jobs.reload(); router.push(`/screening?job=${r.id}`);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  const rows = (detail.data?.rows ?? []).filter((r) => lvl === 'all' || r.level === lvl);
  return (
    <div className="page stack" style={{ gap: 20 }}>
      <PageHeader title="Screening" sub="Check many wallets at once for sanctions, Tether freezes, risky labels and exposure." crumbs={[{ label: 'Compliance' }, { label: 'Screening' }]} />
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <Card title="New screening job">
          <form className="stack" onSubmit={submit}>
            <Field label="Job name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer batch 14" /></Field>
            <Field label="Addresses" hint="One per line, or comma separated. Tron and Ethereum can be mixed.">
              <Textarea className="mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'TU4vEruvZwLLkSfV9bNw12EJTPvNr7Pvaa\n0x…'} disabled={!canRun} />
            </Field>
            <div className="row">
              <input ref={file} type="file" accept=".csv,.txt,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); e.target.value = ''; }} />
              <Button disabled={!canRun} onClick={() => file.current?.click()}><Upload size={14} />Upload CSV</Button>
              {csv && <Badge tone="info">CSV loaded <button className="copy" aria-label="Clear CSV" onClick={() => setCsv('')}>✕</button></Badge>}
              <span className="muted small end">{parsed.ok.length} valid{parsed.bad ? <span className="bad"> · {parsed.bad} invalid ignored</span> : null}</span>
            </div>
            {err && <Notice tone="error">{err}</Notice>}
            {!canRun && <Notice tone="warn">Your role cannot start screening jobs (requires screen.run). You can still view results.</Notice>}
            <Button variant="primary" type="submit" busy={busy} disabled={!canRun || !parsed.ok.length}><ScanSearch size={15} />Screen {parsed.ok.length || ''} address{parsed.ok.length === 1 ? '' : 'es'}</Button>
          </form>
        </Card>
        <Card title="Jobs" flush>
          {jobs.loading ? <SkeletonRows /> : jobs.error ? <ErrorState error={jobs.error} status={jobs.status} onRetry={jobs.reload} /> : (
            <Table caption="Screening jobs" rows={jobs.data ?? []} rowKey={(j) => j.id} pageSize={8} onRowClick={(j) => router.push(`/screening?job=${j.id}`)}
              empty={<EmptyState icon={<ScanSearch size={22} />} title="No jobs yet">Paste addresses on the left to run your first screening.</EmptyState>}
              cols={[
                { key: 'n', header: 'Name', cell: (j) => <span style={{ fontWeight: 600 }}>{j.name || `Job #${j.id}`}</span> },
                { key: 's', header: 'Status', cell: (j) => <Badge tone={tone(j.status)}>{j.status}</Badge> },
                { key: 'p', header: 'Progress', cell: (j) => <div style={{ width: 90 }}><div className="progress"><i style={{ width: `${j.total ? (j.progress / j.total) * 100 : 0}%` }} /></div><span className="xs muted">{j.progress}/{j.total}</span></div> },
                { key: 'c', header: 'Created', sort: (j) => Date.parse(j.createdAt), cell: (j) => <Time t={j.createdAt} /> },
              ]} initialSort={{ key: 'c', dir: 'desc' }} />
          )}
        </Card>
      </div>

      {job && (
        <Card title={`Results · job #${job}`} flush actions={
          <div className="row">
            {detail.data && <Badge tone={tone(detail.data.status)}>{detail.data.status === 'running' ? `${detail.data.progress}/${detail.data.total}` : detail.data.status}</Badge>}
            <Segmented label="Risk filter" value={lvl} onChange={setLvl} options={[{ id: 'all', label: 'All' }, { id: 'severe', label: 'Severe' }, { id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' }, { id: 'low', label: 'Low' }]} />
            {can('export.data') ? <a className="btn sm" href={`/api/screen/${job}/csv`} download><Download size={14} />CSV</a> : <Button sm disabled title="Requires export.data"><Download size={14} />CSV</Button>}
          </div>}>
          {detail.loading ? <SkeletonRows /> : detail.error ? <ErrorState error={detail.error} status={detail.status} onRetry={detail.reload} /> : (
            <>
              {detail.data?.status === 'failed' && <div style={{ padding: 16 }}><Notice tone="error">Job failed: {detail.data.error}</Notice></div>}
              {detail.data && (detail.data.status === 'running' || detail.data.status === 'queued') && <div style={{ padding: '12px 16px' }}><div className="progress"><i style={{ width: `${detail.data.total ? (detail.data.progress / detail.data.total) * 100 : 0}%` }} /></div><span className="xs muted">Screening… results appear when done and update live.</span></div>}
              <Table caption="Screening results" rows={rows} rowKey={(r) => r.address} pageSize={25} initialSort={{ key: 's', dir: 'desc' }}
                empty={<EmptyState title="No results to show">{detail.data?.rows?.length ? 'No rows match this filter.' : 'Results will appear here as addresses are checked.'}</EmptyState>}
                cols={[
                  { key: 'a', header: 'Address', cell: (r) => <AddressLink address={r.address} /> },
                  { key: 'c', header: 'Chain', cell: (r) => <span className="muted">{r.chain}</span> },
                  { key: 's', header: 'Score', num: true, sort: (r) => r.score, cell: (r) => r.error ? '—' : r.score },
                  { key: 'l', header: 'Risk', sort: (r) => r.score, cell: (r) => (r.error ? <Badge tone="outline">Error</Badge> : <span className="row nw"><RiskBadge level={r.level} />{r.frozen && <Badge tone="severe">Frozen</Badge>}</span>) },
                  { key: 'lb', header: 'Labels', wrap: true, cell: (r) => <span className="row">{r.labels?.map((l, i) => <CategoryChip key={i} category={l.category} name={l.name} />)}</span> },
                  { key: 'r', header: 'Reasons', wrap: true, cell: (r) => <span className="small muted">{r.error ?? r.reasons?.slice(0, 2).join('; ')}</span> },
                ]} />
            </>
          )}
        </Card>
      )}
    </div>
  );
}
export default function Page() { return <RequirePerm perm="investigate.view"><Suspense><Screening /></Suspense></RequirePerm>; }
