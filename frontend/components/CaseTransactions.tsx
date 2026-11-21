'use client';
import { Download, FileSpreadsheet, ListPlus, Microscope, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { ROLES } from '@/components/AddressActions';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { AddressLink, TxLink } from '@/components/Risk';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, DateTime, EmptyState, ErrorState, Field, Input, Notice, Segmented, Select, SkeletonRows, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money, short } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';

export const OFF_CHAIN_NOTE = 'Internal exchange transfer — no on-chain trace; request records from the exchange';
export interface Tx {
  id: number; chain: string | null; hash: string | null; source: string; claimedAt: string | null; coin: string | null; network: string | null; amount: number | null; fee: number | null;
  address: string | null; ref: string | null; status: string; onFrom: string | null; onTo: string | null; onAmount: number | null; onAsset: string | null; onAt: string | null; reasons: string[];
}
export interface TxSummary { total: number; pending: number; byStatus: Record<string, { count: number; amount: number }>; claimed: number; verified: number }
export interface TxList { summary: TxSummary; count: number; rows: Tx[] }

export const STATUS: Record<string, { label: string; tone?: 'good' | 'high' | 'medium' | 'info' | 'severe' | 'outline' }> = {
  verified: { label: 'Verified', tone: 'good' }, mismatch: { label: 'Mismatch', tone: 'high' }, not_found: { label: 'Not found', tone: 'medium' },
  off_chain: { label: 'Off-chain', tone: 'info' }, error: { label: 'Error', tone: 'severe' }, pending: { label: 'Pending', tone: 'outline' },
};
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={STATUS[s]?.tone}>{STATUS[s]?.label ?? s}</Badge>;
const amt = (n: number | null, coin?: string | null) => (n === null ? '—' : money(n, coin ?? 'usdt'));
const PAGE = 100;

const MAX_SELECTED = 5000; // the API limit for an Analyse-selected scope

export function TransactionsTab({ id, onAnalyse }: { id: string; onAnalyse?: (ids: number[]) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('cases.manage');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [limit, setLimit] = useState(PAGE);
  const [modal, setModal] = useState<'paste' | 'import' | null>(null);
  const [del, setDel] = useState<Tx | null>(null);
  const [sel, setSel] = useState<Set<string | number>>(new Set());
  const path = `/cases/${id}/transactions?limit=${limit}${status ? `&status=${status}` : ''}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`;
  const { data, loading, error, status: http, reload } = useApi<TxList>(path, (d) => (d.summary.pending > 0 ? 2000 : false)); // poll while the verification job runs
  const s = data?.summary;
  const offChain = s?.byStatus.off_chain?.count ?? 0;
  const verifiable = s ? s.total - offChain : 0;
  const ids = [...sel].map(Number);
  const selectAll = async () => {
    try {
      const r = await api<{ ids: number[] }>(`/cases/${id}/transactions?idsOnly=1${status ? `&status=${status}` : ''}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`);
      setSel(new Set(r.ids));
    } catch (e) { toast.error((e as Error).message); }
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast.success(ok); reload(); } catch (e) { toast.error((e as Error).message); } };

  if (loading && !data) return <div className="card"><SkeletonRows /></div>;
  if (error && !data) return <div className="card"><ErrorState error={error} status={http} onRetry={reload} /></div>;
  return (
    <div className="stack">
      <Card title="Transactions" actions={
        <div className="row" style={{ gap: 8 }}>
          {manage && <Button sm onClick={() => setModal('paste')}><ListPlus size={14} />Paste hashes</Button>}
          {manage && <Button sm variant="primary" onClick={() => setModal('import')}><Upload size={14} />Import statement</Button>}
          {manage && <Button sm disabled={!verifiable || (s?.pending ?? 0) > 0} onClick={() => act(() => api(`/cases/${id}/transactions/verify`, { body: {} }), 'Verification started')}><RefreshCw size={14} />Re-verify</Button>}
          {can('export.data') && <a className="btn sm" href={`/api/cases/${id}/transactions.csv`} download><Download size={14} />CSV</a>}
        </div>}>
        {s && s.total > 0 ? (
          <div className="stack">
            <div className="grid g3">
              <div className="stat"><div className="k">Claimed by statement</div><div className="v">{money(s.claimed)}</div><div className="s">{s.total} rows, {offChain} off-chain</div></div>
              <div className="stat"><div className="k">Verified on-chain</div><div className="v" style={{ color: 'var(--low)' }}>{money(s.verified)}</div><div className="s">{s.byStatus.verified?.count ?? 0} row(s) match the chain</div></div>
              <div className="stat"><div className="k">Not verified</div><div className="v">{money(s.claimed - s.verified)}</div><div className="s">mismatch, not found, error, off-chain, pending</div></div>
            </div>
            {s.pending > 0 && (
              <div role="status" aria-label="Verification progress">
                <div className="row small muted" style={{ marginBottom: 4 }}>Verifying against the chain: {Math.max(0, verifiable - s.pending)} of {verifiable} checked</div>
                <div className="progress"><i style={{ width: `${verifiable ? Math.round(((verifiable - s.pending) / verifiable) * 100) : 0}%` }} /></div>
              </div>
            )}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Select aria-label="Filter by status" sm style={{ width: 170 }} value={status} onChange={(e) => { setStatus(e.target.value); setLimit(PAGE); }}>
                <option value="">All statuses ({s.total})</option>
                {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label} ({s.byStatus[k]?.count ?? 0})</option>)}
              </Select>
              <Input sm aria-label="Search transactions" style={{ width: 260 }} placeholder="Search hash, address or reference" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
            </div>
          </div>
        ) : null}
      </Card>
      <Card flush>
        {manage && data && data.count > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', padding: '8px 12px' }} data-testid="selection-bar">
            <span className="small" aria-live="polite"><b>{ids.length}</b> selected</span>
            <Button sm variant="primary" disabled={!ids.length || ids.length > MAX_SELECTED} title={ids.length > MAX_SELECTED ? `At most ${MAX_SELECTED} transactions` : ''} onClick={() => onAnalyse?.(ids)}><Microscope size={14} />Analyse selected</Button>
            <Button sm onClick={selectAll}>Select all {data.count} matching{status || dq ? ' the filter' : ''}</Button>
            {ids.length > 0 && <Button sm variant="ghost" onClick={() => setSel(new Set())}>Clear</Button>}
            <span className="muted small">Tick rows, then analyse only those.</span>
          </div>
        )}
        <Table caption="Case transactions" rows={data?.rows ?? []} rowKey={(t) => t.id} pageSize={PAGE} selectable={manage ? { selected: sel, onChange: setSel } : undefined}
          empty={<EmptyState title={s?.total ? 'No transactions match the filter' : 'No transactions yet'}>Paste transaction hashes, or import an exchange statement (Binance withdrawal or deposit history, .xlsx or .csv) and every on-chain row is checked against the chain.</EmptyState>}
          cols={[
            { key: 's', header: 'Status', cell: (t) => <StatusBadge s={t.status} /> },
            { key: 't', header: 'Time', cell: (t) => <DateTime t={t.claimedAt ?? t.onAt} /> },
            { key: 'h', header: 'Transaction', cell: (t) => (t.hash && t.chain ? <TxLink hash={t.hash} chain={t.chain} /> : <span className="muted small">{t.ref ?? 'no hash'}</span>) },
            { key: 'a', header: 'To (claimed)', cell: (t) => (t.address && t.chain ? <AddressLink address={t.address} chain={t.chain} /> : <span className="faint">—</span>) },
            { key: 'c', header: 'Claimed', num: true, cell: (t) => <>{amt(t.amount, t.coin)}{t.fee ? <div className="xs muted">fee {t.fee}</div> : null}</> },
            { key: 'o', header: 'On-chain', num: true, cell: (t) => (t.onAmount === null ? <span className="faint">—</span> : amt(t.onAmount, t.onAsset)) },
            { key: 'd', header: 'Details', wrap: true, cell: (t) => (t.status === 'off_chain' ? <span className="small">{OFF_CHAIN_NOTE}</span> : t.reasons.length ? <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>{t.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul> : t.onFrom ? <span className="muted small">from {short(t.onFrom)}</span> : <span className="faint">—</span>) },
            { key: 'x', header: '', cell: (t) => <Button sm variant="ghost" icon aria-label="Delete transaction" disabled={!manage} onClick={() => setDel(t)}><Trash2 size={14} /></Button> },
          ]} />
        {data && data.count > data.rows.length && <div className="row" style={{ padding: 12 }}><Button onClick={() => setLimit(limit + 500)}>Show more ({data.rows.length} of {data.count})</Button></div>}
      </Card>
      {modal === 'paste' && <PasteDialog id={id} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'import' && <ImportWizard id={id} onClose={() => setModal(null)} onDone={reload} />}
      {del && <ConfirmDialog title="Delete transaction" onClose={() => setDel(null)} onConfirm={async () => { await act(() => api(`/case-transactions/${del.id}`, { method: 'DELETE' }), 'Transaction deleted'); setDel(null); }}>Remove <b className="mono">{del.hash ? short(del.hash) : del.ref}</b> from this case?</ConfirmDialog>}
    </div>
  );
}

function PasteDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [chain, setChain] = useState<'eth' | 'bsc'>('eth');
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<{ value: string; reason: string }[]>([]);
  return (
    <Modal title="Paste transaction hashes" onClose={onClose} footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" busy={busy} disabled={!text.trim()} onClick={async () => {
      setBusy(true);
      try {
        const r = await api<{ added: number; skipped: { value: string; reason: string }[] }>(`/cases/${id}/transactions`, { body: { hashes: text, chain } });
        setSkipped(r.skipped); onDone();
        if (!r.skipped.length) { toast.success(`${r.added} transaction${r.added === 1 ? '' : 's'} added, verifying`); onClose(); } else { setText(''); toast.success(`${r.added} added`); }
      } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
    }}>Add and verify</Button></>}>
      <div className="stack">
        <Field label="Hashes" hint="One per line. Tron: 64 hex characters. Ethereum or BNB Chain: 0x… (66 characters).">
          <Textarea className="mono" rows={7} placeholder="Transaction hashes" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="row"><span className="muted small">For 0x hashes</span><Segmented label="Chain for 0x hashes" value={chain} onChange={setChain} options={[{ id: 'eth', label: 'Ethereum' }, { id: 'bsc', label: 'BNB Chain' }]} /></div>
        {skipped.length > 0 && <Notice tone="warn">Not added: {skipped.map((s) => `${short(s.value)} (${s.reason})`).join('; ')}</Notice>}
      </div>
    </Modal>
  );
}

interface PreviewRow { row: number; chain: string | null; hash: string | null; ref: string | null; offChain: boolean; address: string | null; amount: number | null; fee: number | null; coin: string | null; claimedAt: string | null; problems: string[] }
interface Preview {
  file: string; format: 'binance_withdrawal' | 'binance_deposit' | 'generic'; sheet: string | null; headers: string[]; mapping: Record<string, number>; tz: number; tzDetected: boolean;
  counts: { rows: number; onChain: number; offChain: number; withProblems: number }; claimed: number; wallets: number; rows: PreviewRow[];
}
const FORMAT = { binance_withdrawal: 'Binance withdrawal history', binance_deposit: 'Binance deposit history', generic: 'Unknown format: map the columns below' };
const FIELDS: [string, string, boolean][] = [['hash', 'Transaction hash', true], ['amount', 'Amount (net)', true], ['address', 'Address', true], ['time', 'Time', false], ['coin', 'Coin', false], ['network', 'Network', false], ['fee', 'Fee', false], ['status', 'Status', false]];
const tzLabel = (m: number) => `UTC${m < 0 ? '-' : '+'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? ':' + String(Math.abs(m) % 60).padStart(2, '0') : ''}`;
const TZ = Array.from({ length: 27 }, (_, i) => (i - 12) * 60);
const STEPS = ['Upload', 'Check and map', 'Verification'];

function ImportWizard({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [p, setP] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | ''> | null>(null);
  const [tz, setTz] = useState('');
  const [chain, setChain] = useState('');
  const [role, setRole] = useState('none');
  const [tol, setTol] = useState('2');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ imported: number; offChain: number; alreadyInCase: number; skipped: number; wallets: number; jobId: number | null } | null>(null);
  const [err, setErr] = useState('');

  const form = (f: File, m: typeof mapping, z: string, c: string) => {
    const fd = new FormData();
    fd.append('file', f);
    if (m) fd.append('mapping', JSON.stringify(m));
    if (z) fd.append('tz', z);
    if (c) fd.append('defaultChain', c);
    return fd;
  };
  async function preview(f: File, m: typeof mapping = null, z = tz, c = chain) {
    setBusy(true); setErr('');
    try {
      const r = await api<Preview>(`/cases/${id}/transactions/preview`, { form: form(f, m, z, c) });
      setP(r); setMapping(m ?? (r.mapping as Record<string, number>));
    } catch (e) { setErr((e as Error).message); setP(null); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!file || !p) return;
    setBusy(true);
    try {
      const fd = form(file, mapping, tz || (p.tzDetected ? '' : tzLabel(p.tz)), chain);
      fd.append('walletRole', role); fd.append('timeTolMin', String(Math.round(Number(tol) * 60)));
      setDone(await api(`/cases/${id}/transactions/import`, { form: fd })); onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const step = done ? 2 : p ? 1 : 0;
  const bad = p?.rows.filter((r) => r.problems.length) ?? [];
  const sample = p?.rows.filter((r) => !r.problems.length).slice(0, 6) ?? [];
  const change = (z: string, c: string, m = mapping) => { setTz(z); setChain(c); if (file) preview(file, m, z, c); };
  return (
    <Modal wide title="Import exchange statement" onClose={onClose} footer={done ? <Button variant="primary" onClick={onClose}>Close</Button> : <>
      <Button onClick={onClose}>Cancel</Button>
      {p && <Button variant="primary" busy={busy} disabled={!p.counts.onChain && !p.counts.offChain} onClick={confirm}><FileSpreadsheet size={14} />Import {p.counts.onChain + p.counts.offChain} rows</Button>}</>}>
      <div className="stack">
        <ol className="row small muted" style={{ gap: 14, listStyle: 'none', padding: 0, margin: 0, flexWrap: 'wrap' }} aria-label="Steps">
          {STEPS.map((s, i) => <li key={s} aria-current={i === step ? 'step' : undefined} style={{ fontWeight: i === step ? 700 : 500, color: i === step ? 'var(--text)' : undefined }}>{i + 1}. {s}</li>)}
        </ol>
        {err && <Notice tone="error">{err}</Notice>}
        {!p && !done && (
          <Field label="Statement file" hint="Binance withdrawal or deposit history, or any spreadsheet with hash, address and amount columns. .xlsx or .csv, up to 5 MB and 5,000 rows. The original file is stored with the case as evidence.">
            <Input type="file" accept=".xlsx,.csv" disabled={busy} onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f) preview(f); }} />
          </Field>
        )}
        {p && !done && (
          <>
            <Notice tone={p.format === 'generic' ? 'warn' : 'success'}>Detected: <b>{FORMAT[p.format]}</b>{p.sheet ? <> (sheet “{p.sheet}”)</> : null}. {p.counts.rows} rows: {p.counts.onChain} on-chain, {p.counts.offChain} off-chain, {p.counts.withProblems} with problems (not imported). Claimed total {money(p.claimed)}, {p.wallets} destination wallets.</Notice>
            <div className="row" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <Field label="Statement timezone" hint={p.tzDetected ? 'Read from the Time column header.' : 'Not in the header: choose it, times are compared with the chain.'}>
                <Select value={tz || tzLabel(p.tz)} onChange={(e) => change(e.target.value, chain)}>{TZ.map((m) => <option key={m}>{tzLabel(m)}</option>)}</Select>
              </Field>
              <Field label="Time tolerance (hours)" hint="Statement vs on-chain time."><Input type="number" min={0.5} step={0.5} style={{ width: 110 }} value={tol} onChange={(e) => setTol(e.target.value)} /></Field>
              <Field label="Add destination wallets to the case as" hint="With a note linking back to this file."><Select value={role} onChange={(e) => setRole(e.target.value)}><option value="none">Do not add wallets</option>{ROLES.map((r) => <option key={r}>{r}</option>)}</Select></Field>
              <Field label="Chain when no network column"><Select value={chain} onChange={(e) => change(tz, e.target.value)}><option value="">Detect from hash</option><option value="tron">Tron</option><option value="eth">Ethereum</option><option value="bsc">BNB Chain</option></Select></Field>
            </div>
            {p.format === 'generic' && mapping && (
              <div className="grid g3">{FIELDS.map(([k, label, req]) => (
                <Field key={k} label={label + (req ? ' *' : '')}>
                  <Select value={mapping[k] ?? ''} onChange={(e) => { const m = { ...mapping, [k]: e.target.value === '' ? ('' as const) : Number(e.target.value) }; setMapping(m); if (file) preview(file, m); }}>
                    <option value="">— none —</option>{p.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                  </Select>
                </Field>))}</div>
            )}
            {bad.length > 0 && (
              <Card title={`Rows with problems (${bad.length}), these are skipped`} flush>
                <Table caption="Rows with problems" rows={bad} rowKey={(r) => r.row} pageSize={8} cols={[
                  { key: 'r', header: 'Row', num: true, cell: (r) => r.row },
                  { key: 'p', header: 'Problem', wrap: true, cell: (r) => r.problems.join('; ') },
                ]} />
              </Card>
            )}
            {sample.length > 0 && (
              <Card title="Preview of importable rows" flush>
                <Table caption="Importable rows preview" rows={sample} rowKey={(r) => r.row} pageSize={6} cols={[
                  { key: 'r', header: 'Row', num: true, cell: (r) => r.row },
                  { key: 't', header: 'Time (UTC)', cell: (r) => (r.claimedAt ? r.claimedAt.slice(0, 19).replace('T', ' ') : '—') },
                  { key: 'h', header: 'Transaction', cell: (r) => (r.hash ? short(r.hash) : <span className="muted small">{r.ref}</span>) },
                  { key: 'a', header: 'Address', cell: (r) => (r.address ? short(r.address) : '—') },
                  { key: 'm', header: 'Amount', num: true, cell: (r) => amt(r.amount, r.coin) },
                ]} />
              </Card>
            )}
          </>
        )}
        {done && (
          <Notice tone="success">
            Imported {done.imported} rows ({done.offChain} off-chain records){done.alreadyInCase ? `, ${done.alreadyInCase} already in the case` : ''}{done.skipped ? `, ${done.skipped} skipped for problems` : ''}; {done.wallets} wallets added to the case.{' '}
            {done.imported - done.offChain > 0 ? 'Verification runs in the background: progress is shown on the Transactions tab.' : 'Nothing to verify on-chain.'}
          </Notice>
        )}
      </div>
    </Modal>
  );
}
