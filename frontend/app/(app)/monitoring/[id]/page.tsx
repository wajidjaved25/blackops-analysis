'use client';
import { Play, Plus, Trash2, Upload } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { AssetChips, ChainChoice } from '@/components/Assets';
import { RequirePerm } from '@/components/Guard';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { AddressLink } from '@/components/Risk';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, SkeletonRows, Switch, Textarea, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { AssetFilter, assetSym, Chain, detectChain, isEvmAddr } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Item { id: number; chain: string; address: string; note?: string; lastSeenTs?: number; lastCheckedAt?: string; _count?: { alerts: number } }
interface Rule { id: number; type: string; params: Record<string, number | string>; enabled: boolean }
interface WL { id: number; name: string; items: Item[]; rules: Rule[] }
const RULES: Record<string, { label: string; desc: string; param: string; pl: string; def: number }> = {
  amount_over: { label: 'Large transfer', desc: 'Alert when a single transfer exceeds an amount.', param: 'amount', pl: 'Amount (USD)', def: 10000 },
  flagged_counterparty: { label: 'Flagged counterparty', desc: 'Alert when the wallet transacts with a risky address.', param: 'minWeight', pl: 'Minimum risk weight (0–100)', def: 50 },
  volume_spike: { label: 'Volume spike', desc: 'Alert when activity jumps versus its usual level.', param: 'factor', pl: 'Spike factor (×)', def: 5 },
};

export default function WatchlistDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const { data: wl, loading, error, status, reload } = useApi<WL>(`/watchlists/${id}`);
  const manage = can('monitor.manage');
  const [add, setAdd] = useState(false);
  const [text, setText] = useState('');
  const [csv, setCsv] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [del, setDel] = useState<Item | null>(null);
  const [rt, setRt] = useState('amount_over');
  const [rv, setRv] = useState('10000');
  const [ra, setRa] = useState<AssetFilter>('all'); // which asset a new rule watches
  const [evm, setEvm] = useState<'eth' | 'bsc'>('eth'); // chain for the 0x addresses being added
  const [running, setRunning] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const valid = useMemo(() => [...new Set((text + '\n' + csv).split(/[\s,;"']+/).filter((t) => detectChain(t)))], [text, csv]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast.success(ok); reload(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <RequirePerm perm="monitor.view">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title={wl?.name ?? 'Watchlist'} crumbs={[{ label: 'Compliance' }, { label: 'Monitoring', href: '/monitoring' }, { label: wl?.name ?? '…' }]}
          actions={<>
            <Button busy={running} disabled={!manage} title={manage ? 'Poll all watchlists now' : 'Requires monitor.manage'} onClick={async () => {
              setRunning(true);
              try { const r = await api<{ checked: number; alerts: number }>('/monitor/run', { method: 'POST' }); toast.success(`Checked ${r.checked} addresses, ${r.alerts} new alert${r.alerts === 1 ? '' : 's'}`); reload(); } catch (e) { toast.error((e as Error).message); } finally { setRunning(false); }
            }}><Play size={14} />Run check now</Button>
            <Button variant="primary" disabled={!manage} onClick={() => setAdd(true)}><Plus size={15} />Add addresses</Button>
          </>} />
        {loading && <div className="card"><SkeletonRows /></div>}
        {error && <div className="card"><ErrorState error={error} status={status} onRetry={reload} /></div>}
        {wl && (
          <div className="grid g-main" style={{ alignItems: 'start' }}>
            <Card title={`Watched addresses (${wl.items.length})`} flush>
              <Table caption="Watched addresses" rows={wl.items} rowKey={(i) => i.id}
                empty={<EmptyState title="No addresses yet" action={manage ? <Button variant="primary" onClick={() => setAdd(true)}>Add addresses</Button> : undefined}>Paste addresses or upload a CSV. The first check records a baseline; alerts start from the next new transfer.</EmptyState>}
                cols={[
                  { key: 'a', header: 'Address', wrap: true, cell: (i) => <AddressLink address={i.address} chain={i.chain} /> },
                  { key: 'ch', header: 'Chain', cell: (i) => <span className="muted">{i.chain}</span> },
                  { key: 'n', header: 'Note', cell: (i) => <span className="muted">{i.note || '—'}</span> },
                  { key: 'c', header: 'Last checked', sort: (i) => (i.lastCheckedAt ? Date.parse(i.lastCheckedAt) : 0), cell: (i) => <Time t={i.lastCheckedAt} /> },
                  { key: 'al', header: 'Alerts', num: true, cell: (i) => i._count?.alerts ?? 0 },
                  { key: 'x', header: '', cell: (i) => <Button sm variant="ghost" icon aria-label="Remove address" disabled={!manage} onClick={() => setDel(i)}><Trash2 size={14} /></Button> },
                ]} />
            </Card>
            <Card title="Rules">
              <div className="stack">
                {wl.rules.length === 0 && <Notice tone="warn">No rules yet, so nothing will raise an alert. Add one below.</Notice>}
                {wl.rules.map((r) => {
                  const m = RULES[r.type];
                  return (
                    <div key={r.id} className="row nw" style={{ gap: 12, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
                      <div className="grow"><div style={{ fontWeight: 600 }}>{m?.label ?? r.type}</div><div className="xs muted">{m ? `${m.pl}: ` : ''}{r.params?.[m?.param ?? ''] ?? ''} · {r.params?.asset && r.params.asset !== 'all' ? assetSym(String(r.params.asset)) : 'USDT + USDC'}</div></div>
                      <Switch label={`Enable ${m?.label ?? r.type}`} checked={r.enabled} disabled={!manage} onChange={(v) => act(() => api(`/rules/${r.id}`, { method: 'PATCH', body: { enabled: v } }), v ? 'Rule enabled' : 'Rule disabled')} />
                      <Button sm variant="ghost" icon aria-label="Delete rule" disabled={!manage} onClick={() => act(() => api(`/rules/${r.id}`, { method: 'DELETE' }), 'Rule deleted')}><Trash2 size={14} /></Button>
                    </div>
                  );
                })}
                {manage && (
                  <div className="stack sm">
                    <h3>Add a rule</h3>
                    <Select aria-label="Rule type" value={rt} onChange={(e) => { setRt(e.target.value); setRv(String(RULES[e.target.value].def)); }}>{Object.entries(RULES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
                    <span className="xs muted">{RULES[rt].desc}</span>
                    <Field label={RULES[rt].pl}><Input type="number" min="0" value={rv} onChange={(e) => setRv(e.target.value)} /></Field>
                    <AssetChips label="Rule watches" value={ra} onChange={setRa} />
                    <Button variant="primary" disabled={!rv} onClick={() => act(() => api(`/watchlists/${id}/rules`, { body: { type: rt, params: { [RULES[rt].param]: Number(rv), asset: ra } } }), 'Rule added')}>Add rule</Button>
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}
        {add && (
          <Modal wide title="Add addresses" onClose={() => setAdd(false)} footer={<><Button onClick={() => setAdd(false)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!valid.length} onClick={async () => {
            setBusy(true); setErr('');
            try { const r = await api<{ added: number; skipped: number }>(`/watchlists/${id}/items`, { body: { addresses: valid, note: note || undefined, chain: evm === 'bsc' ? 'bsc' : undefined } }); toast.success(`Added ${r.added}, skipped ${r.skipped}`); setAdd(false); setText(''); setCsv(''); reload(); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>Add {valid.length || ''}</Button></>}>
            <div className="stack">
              <Field label="Addresses" hint="Paste addresses (any separator) or upload a CSV."><Textarea className="mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} autoFocus /></Field>
              <div className="row"><input ref={file} type="file" accept=".csv,.txt" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); e.target.value = ''; }} /><Button onClick={() => file.current?.click()}><Upload size={14} />Upload CSV</Button>{csv && <Badge tone="info">CSV loaded</Badge>}<span className="muted small end">{valid.length} valid address{valid.length === 1 ? '' : 'es'}</span></div>
              <ChainChoice addr={valid.find(isEvmAddr) ?? ''} value={evm as Chain} onChange={setEvm} />
              <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              {err && <Notice tone="error">{err}</Notice>}
            </div>
          </Modal>
        )}
        {del && <ConfirmDialog title="Remove address" onClose={() => setDel(null)} confirmLabel="Remove" onConfirm={async () => { await act(() => api(`/watch-items/${del.id}`, { method: 'DELETE' }), 'Address removed'); setDel(null); }}>Stop watching <b className="mono">{del.address}</b> and delete its alerts?</ConfirmDialog>}
      </div>
    </RequirePerm>
  );
}
