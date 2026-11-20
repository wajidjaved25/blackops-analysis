'use client';
import { Link2, Plus, RefreshCw, Search, Tag, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { AddLabelModal } from '@/components/AddressActions';
import { RequirePerm } from '@/components/Guard';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { AddressLink, CategoryChip } from '@/components/Risk';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, SkeletonRows, Stat, Textarea, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { num } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';

interface Label { id: number; orgId: number; chain: string; address: string; name: string; category: string; source: string; sourceUrl?: string | null; confidence?: number; createdAt: string }
interface St { counts: Record<string, number>; ofacLastSync?: string; tetherLastSync?: string; circleLastSync?: string; etherscanKey?: boolean; categories: string[] }
interface Dry { total: number; valid: number; errors: { line: number; address: string; error: string }[]; preview?: unknown[] }

export default function Labels() {
  const { can } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [src, setSrc] = useState('');
  const [page, setPage] = useState(0);
  const dq = useDebounced(q);
  const st = useApi<St>('/labels/status');
  const list = useApi<{ rows: Label[]; total: number; pageSize: number }>(`/labels?q=${encodeURIComponent(dq)}&category=${cat}&source=${src}&page=${page}`);
  const [add, setAdd] = useState(false);
  const [imp, setImp] = useState<'csv' | 'url' | null>(null);
  const [del, setDel] = useState<Label | null>(null);
  const [sync, setSync] = useState('');
  const manage = can('labels.manage'), canSync = can('labels.sync');

  async function runSync(source: 'ofac' | 'tether' | 'circle') {
    setSync(source);
    try { await api('/labels/sync', { body: { source } }); toast.success(`${source.toUpperCase()} sync finished`); st.reload(); list.reload(); }
    catch (e) { toast.error((e as Error).message); } finally { setSync(''); }
  }
  const SyncCard = ({ s, title, last }: { s: 'ofac' | 'tether' | 'circle'; title: string; last?: string }) => (
    <Card><div className="row nw"><div className="grow"><div className="muted small">{title}</div><div style={{ fontSize: 20, fontWeight: 650 }}>{st.data ? num(st.data.counts[s] ?? 0) : '…'} <span className="muted small" style={{ fontWeight: 400 }}>labels</span></div><div className="xs muted">Last sync: {last ? <Time t={last} /> : 'never'}</div></div>
      <Button busy={sync === s} disabled={!canSync || !!sync} title={canSync ? '' : 'Requires labels.sync'} onClick={() => runSync(s)}><RefreshCw size={14} />Sync</Button></div>
      {(s === 'tether' || s === 'circle') && sync === s && <p className="xs muted" style={{ marginTop: 8 }}>A full {s === 'circle' ? 'Circle' : 'Tether'} sync can take several minutes. You can leave this page open.</p>}
    </Card>
  );
  return (
    <RequirePerm perm="labels.view">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="Labels" sub="Known wallets: sanctions, freezes, exchanges and your own tags." crumbs={[{ label: 'Intelligence' }, { label: 'Labels' }]}
          actions={<>
            <Button disabled={!canSync} title={canSync ? '' : 'Requires labels.sync'} onClick={() => setImp('url')}><Link2 size={14} />Import from URL</Button>
            <Button disabled={!manage} title={manage ? '' : 'Requires labels.manage'} onClick={() => setImp('csv')}><Upload size={14} />Import CSV</Button>
            <Button variant="primary" disabled={!manage} title={manage ? '' : 'Requires labels.manage'} onClick={() => setAdd(true)}><Plus size={15} />Add label</Button>
          </>} />
        <div className="grid g3">
          <SyncCard s="ofac" title="OFAC sanctions list" last={st.data?.ofacLastSync} />
          <SyncCard s="tether" title="Tether frozen wallets (USDT)" last={st.data?.tetherLastSync} />
          <SyncCard s="circle" title="Circle blacklisted wallets (USDC)" last={st.data?.circleLastSync} />
          <Stat label="Manual · import · cluster" value={st.data ? `${num(st.data.counts.manual ?? 0)} · ${num(st.data.counts.import ?? 0)} · ${num(st.data.counts.cluster ?? 0)}` : '…'} sub={st.data && !st.data.etherscanKey ? 'Etherscan key not set: ERC20 data limited' : undefined} />
        </div>
        <Card flush title={<span className="row">
          <span style={{ position: 'relative' }}><Search size={14} style={{ position: 'absolute', left: 10, top: 8, color: 'var(--faint)' }} aria-hidden /><Input sm style={{ paddingLeft: 30, width: 240 }} placeholder="Search name or address" aria-label="Search labels" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} /></span>
          <Select sm style={{ width: 150 }} aria-label="Category" value={cat} onChange={(e) => { setCat(e.target.value); setPage(0); }}><option value="">All categories</option>{(st.data?.categories ?? []).map((c) => <option key={c}>{c}</option>)}</Select>
          <Select sm style={{ width: 130 }} aria-label="Source" value={src} onChange={(e) => { setSrc(e.target.value); setPage(0); }}><option value="">All sources</option>{['ofac', 'tether', 'circle', 'official', 'manual', 'import', 'cluster'].map((c) => <option key={c}>{c}</option>)}</Select>
        </span>}>
          {list.loading ? <SkeletonRows /> : list.error ? <ErrorState error={list.error} status={list.status} onRetry={list.reload} /> : (
            <Table caption="Labels" rows={list.data?.rows ?? []} rowKey={(l) => l.id} pageSize={100} server={{ page, total: list.data?.total ?? 0, pageSize: list.data?.pageSize ?? 100, onPage: setPage }}
              empty={<EmptyState icon={<Tag size={22} />} title="No labels match" action={manage ? <Button variant="primary" onClick={() => setAdd(true)}>Add a label</Button> : undefined}>Try a different filter, sync a source, or add your own.</EmptyState>}
              cols={[
                { key: 'a', header: 'Address', cell: (l) => <AddressLink address={l.address} /> },
                { key: 'n', header: 'Name', cell: (l) => <span style={{ fontWeight: 550 }}>{l.name}</span> },
                { key: 'c', header: 'Category', cell: (l) => <CategoryChip category={l.category} /> },
                { key: 's', header: 'Source', cell: (l) => <span className="row nw" style={{ gap: 6 }}><Badge tone="outline">{l.source}{l.orgId === 0 ? ' · global' : ''}</Badge>{l.sourceUrl && <a href={l.sourceUrl} target="_blank" rel="noreferrer" className="xs" title={l.sourceUrl}>source page</a>}</span> },
                { key: 'k', header: 'Conf.', num: true, cell: (l) => (l.confidence != null ? `${Math.round(l.confidence <= 1 ? l.confidence * 100 : l.confidence)}%` : '—') },
                { key: 'x', header: '', cell: (l) => l.orgId !== 0 && manage ? <Button sm variant="ghost" icon aria-label={`Delete label ${l.name}`} onClick={() => setDel(l)}><Trash2 size={14} /></Button> : null },
              ]} />
          )}
        </Card>
        {add && <AddLabelModal onClose={() => setAdd(false)} onDone={() => { list.reload(); st.reload(); }} />}
        {imp && <ImportModal mode={imp} onClose={() => setImp(null)} onDone={() => { list.reload(); st.reload(); }} />}
        {del && <ConfirmDialog title="Delete label" onClose={() => setDel(null)} onConfirm={async () => {
          try { await api(`/labels/${del.id}`, { method: 'DELETE' }); toast.success('Label deleted'); list.reload(); st.reload(); } catch (e) { toast.error((e as Error).message); }
          setDel(null);
        }}>Delete the label <b>{del.name}</b> from <span className="mono">{del.address}</span>?</ConfirmDialog>}
      </div>
    </RequirePerm>
  );
}

function ImportModal({ mode, onClose, onDone }: { mode: 'csv' | 'url'; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [url, setUrl] = useState('');
  const [dry, setDry] = useState<Dry | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const call = (dryRun: boolean) => (mode === 'csv' ? api<Dry & { inserted?: number; skipped?: number }>('/labels/import', { body: { csv, dryRun } }) : api<Dry & { inserted?: number; skipped?: number }>('/labels/import-url', { body: { url, dryRun } }));
  const input = mode === 'csv' ? csv : url;
  return (
    <Modal wide title={mode === 'csv' ? 'Import labels from CSV' : 'Import labels from URL'} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button busy={busy} disabled={!input.trim()} onClick={async () => { setBusy(true); setErr(''); try { setDry(await call(true)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>Preview (dry run)</Button>
      <Button variant="primary" busy={busy} disabled={!dry || !dry.valid} onClick={async () => { setBusy(true); try { const r = await call(false); toast.success(`Imported ${r.inserted ?? 0}, skipped ${r.skipped ?? 0}`); onDone(); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>Import {dry?.valid ?? ''} valid</Button></>}>
      <div className="stack">
        <p className="muted small">Columns: <code>address,name,category[,confidence[,chain]]</code>. Add <code>bsc</code> as the chain for a 0x address on BNB Chain (default Ethereum). Categories include <code>bridge</code> and <code>dex</code>, which the cross-chain tools use. Run a dry run first to see problems before anything is saved.</p>
        {mode === 'csv' ? (
          <>
            <Textarea className="mono" rows={6} value={csv} onChange={(e) => { setCsv(e.target.value); setDry(null); }} placeholder={'address,name,category\nT…,My exchange,exchange'} />
            <div><input ref={file} type="file" accept=".csv,.txt" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setDry(null); } e.target.value = ''; }} /><Button onClick={() => file.current?.click()}><Upload size={14} />Choose file</Button></div>
          </>
        ) : <Field label="CSV URL" hint="Imported as global labels (source: import)."><Input value={url} onChange={(e) => { setUrl(e.target.value); setDry(null); }} placeholder="https://…/labels.csv" /></Field>}
        {err && <Notice tone="error">{err}</Notice>}
        {dry && (
          <div className="stack sm">
            <div className="row"><Badge tone="good">{dry.valid} valid</Badge><Badge tone={dry.errors.length ? 'severe' : 'outline'}>{dry.errors.length} errors</Badge><span className="muted small">of {dry.total} rows</span></div>
            {dry.errors.length > 0 && <div className="card" style={{ maxHeight: 180, overflow: 'auto' }}><table className="tbl"><thead><tr><th>Line</th><th>Address</th><th>Problem</th></tr></thead><tbody>{dry.errors.map((x, i) => <tr key={i}><td>{x.line}</td><td className="mono small break">{x.address}</td><td className="bad small">{x.error}</td></tr>)}</tbody></table></div>}
          </div>
        )}
      </div>
    </Modal>
  );
}
