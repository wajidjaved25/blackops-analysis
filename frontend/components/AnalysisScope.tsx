'use client';
// Scope picker for a case analysis (Phase 10B): all transactions, or the part chosen by filters / by rows ticked on the Transactions tab.
import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, Notice, Segmented, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';

export interface ScopeForm {
  choose: boolean; selectedIds: number[] | null; from: string; to: string; tz: string; statuses: string[]; chains: string[]; assets: string[]; fileIds: number[]; pasted: boolean;
  wallets: string[]; min: string; max: string; direction: '' | 'withdrawal' | 'deposit';
}
export const EMPTY_SCOPE: ScopeForm = { choose: false, selectedIds: null, from: '', to: '', tz: '', statuses: [], chains: [], assets: [], fileIds: [], pasted: false, wallets: [], min: '', max: '', direction: '' };
export interface ScopePreview {
  inScope: number; total: number; summary: string; undatedExcluded: number;
  facets: { statuses: Record<string, number>; chains: Record<string, number>; assets: Record<string, number>; files: { id: number; name: string; count: number }[]; pasted: number; wallets: { address: string; count: number }[]; walletsTotal: number };
}
export interface ResultScope { applied: unknown; summary: string; inScope: number; total: number; undatedExcluded?: number }

const STATUS_LABEL: Record<string, string> = { verified: 'Verified', mismatch: 'Mismatch', not_found: 'Not found', off_chain: 'Off-chain', pending: 'Pending', error: 'Error' };
const CHAIN_LABEL: Record<string, string> = { tron: 'Tron', eth: 'Ethereum', bsc: 'BNB Chain' };
export const browserTz = () => String(-new Date().getTimezoneOffset() / 60);
const tzName = (h: number) => `UTC${h < 0 ? '-' : '+'}${Math.floor(Math.abs(h))}${Math.abs(h) % 1 ? ':' + String(Math.round((Math.abs(h) % 1) * 60)).padStart(2, '0') : ''}`;

/** Form -> the `scope` the API takes, or undefined for "all transactions". Dates are whole days in the chosen timezone. */
export function buildScope(f: ScopeForm): Record<string, unknown> | undefined {
  if (!f.choose) return undefined;
  if (f.selectedIds) return { mode: 'selected', transactionIds: f.selectedIds };
  const tzMin = Math.round((Number(f.tz) || 0) * 60);
  const edge = (d: string, add: number) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + add) - tzMin * 60_000 - (add ? 1 : 0)).toISOString(); };
  const s: Record<string, unknown> = {
    ...(f.from && { from: edge(f.from, 0) }), ...(f.to && { to: edge(f.to, 1) }), ...((f.from || f.to) && { tzMin }),
    ...(f.statuses.length && { statuses: f.statuses }), ...(f.chains.length && { chains: f.chains }), ...(f.assets.length && { assets: f.assets }),
    ...(f.fileIds.length && { fileIds: f.fileIds }), ...(f.pasted && { pasted: true }), ...(f.wallets.length && { wallets: f.wallets }),
    ...(f.min !== '' && { minAmount: Number(f.min) }), ...(f.max !== '' && { maxAmount: Number(f.max) }), ...(f.direction && { direction: f.direction }),
  };
  return Object.keys(s).length ? s : undefined;
}

/** Live count: asks the server (same filter code as the run) how many rows the scope keeps. */
export function useScopePreview(caseId: string, scope: Record<string, unknown> | undefined) {
  const key = useDebounced(JSON.stringify(scope ?? null));
  const [state, setState] = useState<{ data: ScopePreview | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api<ScopePreview>(`/cases/${caseId}/analyses/scope-preview`, { body: { scope: JSON.parse(key) ?? undefined } })
      .then((data) => live && setState({ data, error: '', loading: false }))
      .catch((e: Error) => live && setState((s) => ({ ...s, error: e.message, loading: false })));
    return () => { live = false; };
  }, [caseId, key]);
  return state;
}

function Checks<T extends string | number>({ label, options, value, onChange }: { label: string; options: { id: T; label: string; n?: number }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <legend className="small muted" style={{ padding: 0, marginBottom: 4 }}>{label}</legend>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {options.length === 0 && <span className="faint small">none in this case</span>}
        {options.map((o) => (
          <label key={String(o.id)} className="row small" style={{ gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} />
            {o.label}{o.n !== undefined && <span className="muted"> ({o.n})</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ScopeSection({ caseId, f, setF, preview, disabled }: { caseId: string; f: ScopeForm; setF: (f: ScopeForm) => void; preview: ReturnType<typeof useScopePreview>; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const p = preview.data;
  const fx = p?.facets;
  const tz = f.tz === '' ? browserTz() : f.tz;
  const set = (patch: Partial<ScopeForm>) => setF({ ...f, ...patch });
  const wallets = useMemo(() => (fx?.wallets ?? []).filter((w) => w.address.toLowerCase().includes(q.trim().toLowerCase())), [fx, q]);
  return (
    <div className="stack sm" data-testid="scope-section">
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span className="small" style={{ fontWeight: 600 }}>Scope</span>
        <Segmented label="Scope of the analysis" value={f.choose ? 'choose' : 'all'} onChange={(v) => setF({ ...f, choose: v === 'choose' })} options={[{ id: 'all', label: 'All transactions' }, { id: 'choose', label: 'Choose…' }]} />
        <span className="small" aria-live="polite" data-testid="scope-count">
          {preview.error ? <span style={{ color: 'var(--high)' }}>{preview.error}</span> : p ? <><b>{p.inScope}</b> of {p.total} transactions will be analysed</> : 'Counting…'}
        </span>
      </div>
      {f.choose && f.selectedIds && (
        <Notice tone="info" action={<Button sm onClick={() => set({ selectedIds: null })}>Use filters instead</Button>}>
          <b>{f.selectedIds.length}</b> transaction{f.selectedIds.length === 1 ? '' : 's'} chosen on the Transactions tab. Only these are analysed.
        </Notice>
      )}
      {f.choose && !f.selectedIds && (
        <div className="stack sm" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="From (date)"><Input type="date" aria-label="Scope from date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} /></Field>
            <Field label="To (date, inclusive)"><Input type="date" aria-label="Scope to date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} /></Field>
            <Field label="Timezone (UTC offset, h)" hint={`Days are read in ${tzName(Number(tz) || 0)}${f.tz === '' ? ' (your browser)' : ''}.`}><Input type="number" step={0.5} min={-12} max={14} aria-label="Scope timezone" style={{ width: 110 }} value={tz} onChange={(e) => set({ tz: e.target.value })} /></Field>
            <Field label="Amount min"><Input type="number" min={0} aria-label="Scope minimum amount" style={{ width: 110 }} value={f.min} onChange={(e) => set({ min: e.target.value })} /></Field>
            <Field label="Amount max"><Input type="number" min={0} aria-label="Scope maximum amount" style={{ width: 110 }} value={f.max} onChange={(e) => set({ max: e.target.value })} /></Field>
          </div>
          <Checks label="Status" value={f.statuses} onChange={(statuses) => set({ statuses })} options={Object.keys(STATUS_LABEL).map((k) => ({ id: k, label: STATUS_LABEL[k], n: fx?.statuses[k] ?? 0 }))} />
          <Checks label="Chain" value={f.chains} onChange={(chains) => set({ chains })} options={Object.entries(fx?.chains ?? {}).map(([k, n]) => ({ id: k, label: CHAIN_LABEL[k] ?? k, n }))} />
          <Checks label="Asset" value={f.assets} onChange={(assets) => set({ assets })} options={Object.entries(fx?.assets ?? {}).map(([k, n]) => ({ id: k, label: k, n }))} />
          <div className="stack sm">
            <Checks label="Source (statement files)" value={f.fileIds} onChange={(fileIds) => set({ fileIds })} options={(fx?.files ?? []).map((x) => ({ id: x.id, label: x.name, n: x.count }))} />
            <label className="row small" style={{ gap: 5, cursor: 'pointer' }}><input type="checkbox" checked={f.pasted} onChange={(e) => set({ pasted: e.target.checked })} />Pasted hashes and investigated transactions<span className="muted"> ({fx?.pasted ?? 0})</span></label>
          </div>
          <Field label="Direction of statement rows" hint="Only rows from a recognised Binance withdrawal or deposit history have a direction; other rows are left out when one is chosen.">
            <Select aria-label="Scope direction" style={{ width: 200 }} value={f.direction} onChange={(e) => set({ direction: e.target.value as ScopeForm['direction'] })}>
              <option value="">Any</option><option value="withdrawal">Withdrawals</option><option value="deposit">Deposits</option>
            </Select>
          </Field>
          <details>
            <summary style={{ cursor: 'pointer' }} className="small">Recipient wallets{f.wallets.length ? ` (${f.wallets.length} chosen)` : ''} <span className="muted">of {fx?.walletsTotal ?? 0} in the case</span></summary>
            <div className="stack sm" style={{ marginTop: 8 }}>
              <Input sm aria-label="Search wallets" placeholder="Search an address" style={{ maxWidth: 320 }} value={q} onChange={(e) => setQ(e.target.value)} />
              <div style={{ maxHeight: 180, overflow: 'auto' }} className="stack sm">
                {wallets.map((w) => (
                  <label key={w.address} className="row small" style={{ gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={f.wallets.includes(w.address)} onChange={(e) => set({ wallets: e.target.checked ? [...f.wallets, w.address] : f.wallets.filter((x) => x !== w.address) })} />
                    <span className="mono" style={{ wordBreak: 'break-all' }}>{w.address}</span><span className="muted">({w.count})</span>
                  </label>
                ))}
                {(fx?.walletsTotal ?? 0) > (fx?.wallets.length ?? 0) && <span className="muted small">Showing the {fx?.wallets.length} busiest wallets.</span>}
              </div>
            </div>
          </details>
          <div className="row"><Button sm disabled={disabled} onClick={() => setF({ ...EMPTY_SCOPE, choose: true })}>Clear filters</Button><span className="muted small">A row that lacks the filtered field (for example no date) is left out.</span></div>
        </div>
      )}
      {f.choose && p && p.inScope === 0 && <Notice tone="warn">No transactions match this scope. Widen the filters or choose other transactions.</Notice>}
      {f.choose && p && p.undatedExcluded > 0 && <Notice tone="info">{p.undatedExcluded} transaction{p.undatedExcluded === 1 ? ' has' : 's have'} no date (still pending or off-chain without a time) and {p.undatedExcluded === 1 ? 'is' : 'are'} left out by the date range.</Notice>}
    </div>
  );
}
