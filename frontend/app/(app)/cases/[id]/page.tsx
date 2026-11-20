'use client';
import { Download, FileText, Network, Plus, Printer, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ROLES } from '@/components/AddressActions';
import { RequirePerm } from '@/components/Guard';
import { ConfirmDialog } from '@/components/Modal';
import { AddressLink, RiskBadge, TxLink } from '@/components/Risk';
import { Table } from '@/components/Table';
import { TransactionsTab } from '@/components/CaseTransactions';
import { useToast } from '@/components/Toast';
import { RadialHeatmap } from '@/components/charts';
import { Badge, Button, Card, DateTime, EmptyState, ErrorState, Field, Input, LinkButton, Notice, PageHeader, Select, SkeletonRows, Tabs, Textarea, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { AssetTag, ChainChoice } from '@/components/Assets';
import { Chain, chainQ, detectChain, money, short } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface CA { id: number; chain: string; address: string; role: string; note?: string }
interface Case { id: number; title: string; description?: string; status: string; createdAt: string; updatedAt: string; graphJson?: unknown; graphPng?: string; addresses: CA[]; notes: { id: number; body: string; author?: { name?: string; email?: string } | string; createdAt: string }[]; files: { id: number; name: string; size: number; mime: string; createdAt: string }[] }
interface TL { hash: string; from: string; to: string; amount: number; asset?: string; timestamp: number; hop: number | null }
type Tab = 'overview' | 'addresses' | 'transactions' | 'graph' | 'timeline' | 'notes' | 'files';
const authorName = (a: Case['notes'][number]['author']) => (typeof a === 'string' ? a : a?.name || a?.email || 'Unknown');
const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const { data: c, loading, error, status, reload } = useApi<Case>(`/cases/${id}`);
  const [tab, setTab] = useState<Tab>('overview');
  const manage = can('cases.manage');
  const [edit, setEdit] = useState<{ title: string; description: string } | null>(null);
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    try { await fn(); if (ok) toast.success(ok); reload(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <RequirePerm perm="cases.view">
      <div className="page stack" style={{ gap: 16 }}>
        <PageHeader title={<span className="row" style={{ gap: 10 }}>{c?.title ?? 'Case'}{c && <Badge tone={c.status === 'open' ? 'info' : undefined}>{c.status}</Badge>}</span>}
          crumbs={[{ label: 'Casework' }, { label: 'Cases', href: '/cases' }, { label: c?.title ?? '…' }]} sub={c && <>Updated <Time t={c.updatedAt} /></>}
          actions={c && <>
            <LinkButton href={`/cases/${id}/report`}><FileText size={14} />Report</LinkButton>
            <Button disabled={!manage} onClick={() => act(() => api(`/cases/${id}`, { method: 'PATCH', body: { status: c.status === 'open' ? 'closed' : 'open' } }), c.status === 'open' ? 'Case closed' : 'Case reopened')}>{c.status === 'open' ? 'Close case' : 'Reopen'}</Button>
            <Button variant="danger" disabled={!can('cases.delete')} title={can('cases.delete') ? '' : 'Requires cases.delete'} onClick={() => setDel(true)}><Trash2 size={14} />Delete</Button>
          </>} />
        {loading && <div className="card"><SkeletonRows /></div>}
        {error && <div className="card"><ErrorState error={error} status={status} onRetry={reload} /></div>}
        {c && (
          <>
            <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'addresses', label: 'Addresses', count: c.addresses.length }, { id: 'transactions', label: 'Transactions' }, { id: 'graph', label: 'Graph' }, { id: 'timeline', label: 'Timeline' }, { id: 'notes', label: 'Notes', count: c.notes.length }, { id: 'files', label: 'Files', count: c.files.length }]} />
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === 'overview' && (
                <Card title="Overview" actions={manage && !edit && <Button sm onClick={() => setEdit({ title: c.title, description: c.description ?? '' })}>Edit</Button>}>
                  {edit ? (
                    <div className="stack">
                      <Field label="Title"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
                      <Field label="Description"><Textarea rows={5} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
                      <div className="row"><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" disabled={!edit.title.trim()} onClick={async () => { await act(() => api(`/cases/${id}`, { method: 'PATCH', body: edit }), 'Case updated'); setEdit(null); }}>Save</Button></div>
                    </div>
                  ) : (
                    <div className="stack">
                      <p style={{ whiteSpace: 'pre-wrap' }} className={c.description ? '' : 'muted'}>{c.description || 'No description yet.'}</p>
                      <dl className="kv"><dt>Created</dt><dd><DateTime t={c.createdAt} /></dd><dt>Addresses</dt><dd>{c.addresses.length}</dd><dt>Notes</dt><dd>{c.notes.length}</dd><dt>Files</dt><dd>{c.files.length}</dd></dl>
                    </div>
                  )}
                </Card>
              )}
              {tab === 'addresses' && <Addresses c={c} manage={manage} act={act} />}
              {tab === 'transactions' && <TransactionsTab id={id} />}
              {tab === 'graph' && (
                <Card title="Graph snapshot" actions={<LinkButton href={`/graph?case=${id}`} variant="primary" sm disabled={!c.graphJson}><Network size={14} />Open in graph</LinkButton>}>
                  {c.graphPng ? <img src={c.graphPng} alt="Saved fund-flow graph" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)' }} /> : <EmptyState icon={<Network size={22} />} title="No graph saved" action={<LinkButton href="/graph" sm>Open graph workspace</LinkButton>}>Build a graph in the workspace and use “Save to case”.</EmptyState>}
                </Card>
              )}
              {tab === 'timeline' && <Timeline id={id} addrs={c.addresses} />}
              {tab === 'notes' && <Notes c={c} manage={manage} act={act} />}
              {tab === 'files' && <Files c={c} manage={manage} act={act} />}
            </div>
          </>
        )}
        {del && <ConfirmDialog title="Delete case" busy={busy} onClose={() => setDel(false)} onConfirm={async () => {
          setBusy(true);
          try { await api(`/cases/${id}`, { method: 'DELETE' }); toast.success('Case deleted'); router.push('/cases'); } catch (e) { toast.error((e as Error).message); setBusy(false); }
        }}>Permanently delete <b>{c?.title}</b> with all its addresses, notes, files and graph?</ConfirmDialog>}
      </div>
    </RequirePerm>
  );
}

type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function Addresses({ c, manage, act }: { c: Case; manage: boolean; act: Act }) {
  const [f, setF] = useState({ address: '', role: 'suspect', note: '' });
  const [evm, setEvm] = useState<'eth' | 'bsc'>('eth'); // a case remembers the chain per address
  const [risk, setRisk] = useState<Record<string, { level: string; score: number } | 'loading'>>({});
  const [del, setDel] = useState<CA | null>(null);
  const bad = f.address && !detectChain(f.address.trim()) ? 'Not a valid Tron, Ethereum or BNB Chain address' : '';
  const check = async (a: string, chain: string) => {
    setRisk((r) => ({ ...r, [a]: 'loading' }));
    try { const x = await api<{ level: string; score: number }>(`/risk/${a}?${chainQ(chain)}`); setRisk((r) => ({ ...r, [a]: x })); } catch { setRisk((r) => { const n = { ...r }; delete n[a]; return n; }); }
  };
  return (
    <div className="stack">
      {manage && (
        <Card title="Add address">
          <form className="row" style={{ alignItems: 'flex-start' }} onSubmit={async (e) => { e.preventDefault(); if (bad || !f.address) return; await act(() => api(`/cases/${c.id}/addresses`, { body: { address: f.address.trim(), chain: evm === 'bsc' ? 'bsc' : undefined, role: f.role, note: f.note || undefined } }), 'Address added'); setF({ address: '', role: 'suspect', note: '' }); }}>
            <Field className="grow" error={bad}><Input className="mono" aria-label="Address" placeholder="T… or 0x…" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
            <ChainChoice addr={f.address} value={evm as Chain} onChange={setEvm} />
            <Select aria-label="Role" style={{ width: 150 }} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</Select>
            <Input aria-label="Note" style={{ width: 220 }} placeholder="Note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
            <Button variant="primary" type="submit" disabled={!f.address || !!bad}><Plus size={14} />Add</Button>
          </form>
        </Card>
      )}
      <Card flush>
        <Table caption="Case addresses" rows={c.addresses} rowKey={(a) => a.id}
          empty={<EmptyState title="No addresses yet">Add the suspect, victim and intermediary wallets of this case.</EmptyState>}
          cols={[
            { key: 'a', header: 'Address', wrap: true, cell: (a) => <AddressLink address={a.address} chain={a.chain} /> },
            { key: 'ch', header: 'Chain', cell: (a) => <span className="muted">{a.chain}</span> },
            { key: 'r', header: 'Role', cell: (a) => manage ? <Select sm aria-label="Role" style={{ width: 130 }} value={a.role} onChange={(e) => act(() => api(`/case-addresses/${a.id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated')}>{ROLES.map((r) => <option key={r}>{r}</option>)}</Select> : <Badge>{a.role}</Badge> },
            { key: 'n', header: 'Note', wrap: true, cell: (a) => <span className="muted small">{a.note || '—'}</span> },
            { key: 'k', header: 'Risk', cell: (a) => { const r = risk[a.address]; return r === 'loading' ? <span className="muted small">Checking…</span> : r ? <RiskBadge level={r.level} score={r.score} /> : <Button sm variant="ghost" onClick={() => check(a.address, a.chain)}>Check risk</Button>; } },
            { key: 'x', header: '', cell: (a) => <Button sm variant="ghost" icon aria-label="Remove address" disabled={!manage} onClick={() => setDel(a)}><Trash2 size={14} /></Button> },
          ]} />
      </Card>
      {del && <ConfirmDialog title="Remove address" confirmLabel="Remove" onClose={() => setDel(null)} onConfirm={async () => { await act(() => api(`/case-addresses/${del.id}`, { method: 'DELETE' }), 'Address removed'); setDel(null); }}>Remove <b className="mono">{short(del.address)}</b> from this case?</ConfirmDialog>}
    </div>
  );
}

function Timeline({ id, addrs }: { id: string; addrs: CA[] }) {
  const { can } = useAuth();
  const { data: all, loading, error, status, reload } = useApi<TL[]>(`/cases/${id}/timeline`);
  const [full, setFull] = useState(false);
  const data = all && !full ? all.slice(0, 80) : all;
  if (loading) return <div className="card"><SkeletonRows /></div>;
  if (error) return <div className="card"><ErrorState error={error} status={status} onRetry={reload} /></div>;
  if (!data?.length) return <div className="card"><EmptyState title="No transfers between the case addresses yet">The storyline shows USDT and USDC moving between the wallets in this case (and its saved graph), oldest first. Add more addresses or save a graph.</EmptyState></div>;
  const hops = [...new Set(data.map((t) => t.hop))].sort((a, b) => (a ?? 1e9) - (b ?? 1e9));
  return (
    <div className="grid g-main" style={{ alignItems: 'start' }}>
      <Card title="Storyline" actions={can('export.data') && <a className="btn sm" href={`/api/cases/${id}/transfers.csv`} download><Download size={14} />CSV</a>}>
        <div className="stack">
          <p className="muted small">Money movement in order. “Hop” counts how many steps a wallet is from the first victim or suspect.</p>
          {hops.map((h) => (
            <section key={h} className="stack sm">
              <h3>{h === null ? 'Not connected to the starting wallet' : h <= 1 ? 'Hop 1: touching the starting wallet' : `Hop ${h}: ${h} steps away`}</h3>
              {data.filter((t) => t.hop === h).map((t, i) => (
                <div key={i} className="row" style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 12, marginLeft: 4, gap: 6 }}>
                  <span className="muted small"><DateTime t={t.timestamp} /></span><AddressLink address={t.from} /><span className="muted small">sent</span><strong>{money(t.amount, t.asset)}</strong> <AssetTag asset={t.asset} /><span className="muted small">to</span><AddressLink address={t.to} />
                  <span className="end"><TxLink hash={t.hash} chain={addrs.find((a) => a.address === t.from || a.address === t.to)?.chain ?? detectChain(t.from) ?? 'tron'} /></span>
                </div>
              ))}
            </section>
          ))}
          {all && all.length > 80 && !full && <Button onClick={() => setFull(true)}>Show all {all.length} transfers</Button>}
        </div>
      </Card>
      <Card title="When did it happen?"><RadialHeatmap transfers={all ?? []} /></Card>
    </div>
  );
}

function Notes({ c, manage, act }: { c: Case; manage: boolean; act: Act }) {
  const [body, setBody] = useState('');
  return (
    <div className="stack">
      {manage && <Card><div className="stack sm"><Textarea aria-label="New note" placeholder="Write a note…" value={body} onChange={(e) => setBody(e.target.value)} /><div><Button variant="primary" disabled={!body.trim()} onClick={async () => { await act(() => api(`/cases/${c.id}/notes`, { body: { body: body.trim() } }), 'Note added'); setBody(''); }}>Add note</Button></div></div></Card>}
      {c.notes.length === 0 ? <div className="card"><EmptyState title="No notes">Record findings, decisions and next steps.</EmptyState></div> : c.notes.map((n) => (
        <Card key={n.id}><div className="row nw" style={{ alignItems: 'flex-start' }}><div className="grow"><p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p><div className="xs muted" style={{ marginTop: 6 }}>{authorName(n.author)} · <Time t={n.createdAt} /></div></div>{manage && <Button sm variant="ghost" icon aria-label="Delete note" onClick={() => act(() => api(`/case-notes/${n.id}`, { method: 'DELETE' }), 'Note deleted')}><Trash2 size={14} /></Button>}</div></Card>
      ))}
    </div>
  );
}

function Files({ c, manage, act }: { c: Case; manage: boolean; act: Act }) {
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<Case['files'][number] | null>(null);
  return (
    <Card title="Files" flush actions={manage && (
      <label className={`btn sm primary${busy ? '' : ''}`} style={{ cursor: 'pointer' }}><Upload size={14} />{busy ? 'Uploading…' : 'Upload file'}
        <input type="file" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setBusy(true); const fd = new FormData(); fd.append('file', f); await act(() => api(`/cases/${c.id}/files`, { form: fd }), 'File uploaded'); setBusy(false); }} />
      </label>)}>
      <Table caption="Case files" rows={c.files} rowKey={(f) => f.id} empty={<EmptyState title="No files">Attach evidence: pdf, images, docx, xlsx, txt, csv, json, md (max 20 MB each).</EmptyState>}
        cols={[
          { key: 'n', header: 'Name', cell: (f) => <a href={`/api/case-files/${f.id}`} download>{f.name}</a> },
          { key: 's', header: 'Size', num: true, cell: (f) => size(f.size) },
          { key: 't', header: 'Uploaded', cell: (f) => <Time t={f.createdAt} /> },
          { key: 'x', header: '', cell: (f) => <Button sm variant="ghost" icon aria-label="Delete file" disabled={!manage} onClick={() => setDel(f)}><Trash2 size={14} /></Button> },
        ]} />
      {del && <ConfirmDialog title="Delete file" onClose={() => setDel(null)} onConfirm={async () => { await act(() => api(`/case-files/${del.id}`, { method: 'DELETE' }), 'File deleted'); setDel(null); }}>Delete <b>{del.name}</b>?</ConfirmDialog>}
    </Card>
  );
}
