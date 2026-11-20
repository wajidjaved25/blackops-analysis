'use client';
import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import { AlertTriangle, ChevronDown, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RadialHeatmap } from '@/components/charts';
import { AddressLink, RiskBadge, TxLink } from '@/components/Risk';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, DateTime, EmptyState, ErrorState, Field, Input, Notice, Select, SkeletonRows, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { compact, money, num } from '@/lib/format';
import { buildStyle, iconFor, ICON_URI, nodeColor, readTheme } from '@/lib/graphStyle';
import { useApi } from '@/lib/hooks';

export interface Evidence { kind: 'tx' | 'wallet'; chain?: string | null; hash?: string | null; ref?: string | null; address?: string | null; amount?: number | null; at?: number | null; note?: string }
export interface Finding { type: string; severity: 'high' | 'medium' | 'low' | 'info'; title: string; statement: string; evidence: Evidence[]; evidenceTotal: number }
interface WalletR {
  chain: string; address: string; total: number; verified: number; count: number; first: number | null; last: number | null; share: number; balance: number | null; traced: boolean; stopReason: string | null; error: string | null;
  labels: { name: string; category: string; source: string }[]; risk: { score: number | null; level: string | null; reasons: string[]; frozen?: boolean } | null;
}
export interface Result {
  params: Record<string, number | number[]>;
  bounds: { hops: number; fanout: number; maxWallets: number; maxSeeds: number; budgetSec: number; busyTransfers: number };
  totals: { rows: number; claimed: number; verified: number; offChain: { count: number; amount: number }; onChain: { count: number; amount: number }; wallets: number; byStatus: Record<string, { count: number; amount: number }> };
  wallets: WalletR[];
  trace: { walletsTotal: number; walletsTraced: number; failed: number; notFollowed: number; seedsTotal: number; seedsTraced: number; hit: string[]; partial: boolean; durationMs: number };
  findings: Finding[];
  findingsBySeverity: Record<string, number>;
  endpoints: { kind: string; chain: string; address: string; name: string | null; category: string | null; source: string | null; reason: string | null; hop: number; amount: number | null; path: string }[];
  chart: { nodes: { id: string; label: string; kind: string; chain?: string; address?: string; category?: string; hop?: number }[]; edges: { id: string; source: string; target: string; amount: number; count: number }[] };
  notes: string[];
  points: [number, number, number][];
  timeline: { at: number; chain: string | null; hash: string | null; ref: string | null; address: string | null; amount: number; coin: string; status: string; offChain: boolean }[];
  timelineTotal: number;
}
export interface Analysis { id: number; status: string; stage: string; params: Record<string, number | number[]>; progress: number; total: number; error: string | null; createdAt: string; finishedAt: string | null; result?: Result | null }

const SEV: Record<string, 'high' | 'medium' | 'low' | 'info'> = { high: 'high', medium: 'medium', low: 'low', info: 'info' };
const KIND_LABEL: Record<string, string> = { exchange: 'Exchange', service: 'Service', bridge: 'Bridge', dex: 'DEX', risk: 'High-risk wallet', deposit: 'Inferred deposit address', busy: 'High-activity wallet' };
const secs = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

export function EvidenceList({ ev, total }: { ev: Evidence[]; total: number }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {ev.map((e, i) => (
        <div key={i} className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Badge tone="outline">{e.kind === 'tx' ? 'tx' : 'wallet'}</Badge>
          {e.hash && e.chain ? <TxLink hash={e.hash} chain={e.chain} /> : e.ref ? <span className="muted">{e.ref}</span> : null}
          {e.address && e.chain && <AddressLink address={e.address} chain={e.chain} />}
          {typeof e.amount === 'number' && <span>{money(e.amount)}</span>}
          {e.at ? <span className="muted">{new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} UTC</span> : null}
          {e.note && <span className="muted">{e.note}</span>}
        </div>
      ))}
      {total > ev.length && <div className="small muted">Showing {ev.length} of {total} evidence rows.</div>}
    </div>
  );
}

function FindingCard({ f }: { f: Finding }) {
  return (
    <details className="card" style={{ padding: 12 }}>
      <summary style={{ cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center', listStyle: 'none' }}>
        <Badge tone={SEV[f.severity]}>{f.severity}</Badge><b>{f.title}</b><ChevronDown size={14} style={{ marginLeft: 'auto' }} aria-hidden />
      </summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <p style={{ margin: 0 }}>{f.statement}</p>
        <EvidenceList ev={f.evidence} total={f.evidenceTotal} />
      </div>
    </details>
  );
}

/** Daily amounts: on-chain and off-chain rows stacked, last 60 active days. */
function AmountBars({ points }: { points: Result['points'] }) {
  const days = useMemo(() => {
    const m = new Map<string, { on: number; off: number }>();
    for (const [t, a, off] of points) { const k = new Date(t).toISOString().slice(0, 10); const e = m.get(k) ?? { on: 0, off: 0 }; if (off) e.off += a; else e.on += a; m.set(k, e); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-60);
  }, [points]);
  if (!days.length) return <p className="muted small">No dated rows to chart.</p>;
  const W = 640, H = 200, L = 46, B = 24, T = 8, max = Math.max(1, ...days.map(([, d]) => d.on + d.off)), bw = (W - L) / days.length, y = (v: number) => T + (H - T - B) * (1 - v / max);
  return (
    <div className="stack sm">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily statement amounts over ${days.length} active days`} style={{ width: '100%' }}>
        {[0, .5, 1].map((f) => <g key={f}><line x1={L} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" /><text x={L - 6} y={y(max * f) + 3} textAnchor="end" fontSize="9.5" style={{ fill: 'var(--muted)' }}>{compact(max * f)}</text></g>)}
        {days.map(([d, v], i) => (
          <g key={d}>
            <rect x={L + i * bw + bw * .12} width={bw * .76} y={y(v.on)} height={H - B - y(v.on)} style={{ fill: 'var(--accent)' }}><title>{`${d}: on-chain ${num(v.on)}`}</title></rect>
            <rect x={L + i * bw + bw * .12} width={bw * .76} y={y(v.on + v.off)} height={y(v.on) - y(v.on + v.off)} style={{ fill: 'var(--medium)' }}><title>{`${d}: off-chain ${num(v.off)}`}</title></rect>
            {(i === 0 || i === days.length - 1) && <text x={L + i * bw + bw / 2} y={H - 8} textAnchor={i === 0 ? 'start' : 'end'} fontSize="9.5" style={{ fill: 'var(--muted)' }}>{d}</text>}
          </g>
        ))}
      </svg>
      <div className="legend"><span><i className="dot" style={{ background: 'var(--accent)' }} />On-chain</span><span><i className="dot" style={{ background: 'var(--medium)' }} />Off-chain (same exchange)</span><span>amount per day, USD-equivalent</span></div>
    </div>
  );
}

const KIND_COLOR: Record<string, string> = { source: '#6366f1', offchain: '#f59e0b', recipient: '#3b82f6', onward: '#8b94a7', busy: '#64748b', deposit: '#14b8a6' };
/** i2-style link chart: statement -> recipients -> onward hops -> endpoints (shared Cytoscape style with the graph workspace). */
function LinkChart({ chart }: { chart: Result['chart'] }) {
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const [sel, setSel] = useState<string>('');
  useEffect(() => {
    const els: ElementDefinition[] = [
      ...chart.nodes.map((n) => {
        const cat = n.category ?? (['exchange', 'service', 'bridge', 'dex'].includes(n.kind) ? n.kind : n.kind === 'risk' ? 'sanctioned' : undefined);
        return { group: 'nodes' as const, data: { id: n.id, label: n.label, kind: n.kind, address: n.address ?? '', root: n.kind === 'source', expanded: !['busy', 'onward'].includes(n.kind), color: KIND_COLOR[n.kind] ?? nodeColor(cat), icon: ICON_URI[n.kind === 'source' || n.kind === 'offchain' ? 'bank' : iconFor(cat)], size: n.kind === 'source' ? 46 : n.kind === 'recipient' ? 36 : 32 } };
      }),
      ...chart.edges.map((e) => ({ group: 'edges' as const, data: { id: e.id, source: e.source, target: e.target, color: '#888', w: 1.5 + Math.min(5, Math.log10(1 + e.amount)), label: `${compact(e.amount)}${e.count > 1 ? ` · ${e.count}×` : ''}` } })),
    ];
    const c = cytoscape({ container: box.current, elements: els, style: buildStyle(readTheme()), minZoom: .1, maxZoom: 3, wheelSensitivity: .3, layout: { name: 'breadthfirst', directed: true, roots: '#statement', spacingFactor: 1.15, padding: 20 } });
    c.on('select', 'node', (e) => setSel(`${e.target.data('label').replace(/\n/g, ' · ')}${e.target.data('address') ? ` (${e.target.data('address')})` : ''}`));
    c.on('unselect', () => setSel(''));
    cy.current = c;
    const mo = new MutationObserver(() => c.style(buildStyle(readTheme())));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const ro = new ResizeObserver(() => { c.resize(); c.fit(undefined, 20); });
    if (box.current) ro.observe(box.current);
    return () => { mo.disconnect(); ro.disconnect(); c.destroy(); cy.current = null; };
  }, [chart]);
  return (
    <div className="stack sm">
      <div ref={box} role="img" aria-label="Link chart: statement, recipient wallets, onward hops and endpoints" data-testid="link-chart" style={{ height: 440, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--graph-bg)' }} />
      <div className="legend small">
        {[['source', 'Statement'], ['recipient', 'Recipient'], ['onward', 'Onward wallet'], ['deposit', 'Inferred deposit'], ['busy', 'High-activity (not traced)']].map(([k, l]) => <span key={k}><i className="dot" style={{ background: KIND_COLOR[k] }} />{l}</span>)}
        <span><i className="dot" style={{ background: nodeColor('exchange') }} />Exchange / service / bridge</span><span><i className="dot" style={{ background: nodeColor('sanctioned') }} />Sanctioned / frozen / high-risk</span>
      </div>
      <div className="small muted" aria-live="polite">{sel || 'Click a wallet for its address. Dashed outlines are wallets that were not followed further.'}</div>
    </div>
  );
}

const walletCols = (total: number) => [
  { key: 'a', header: 'Wallet', cell: (w: WalletR) => <AddressLink address={w.address} chain={w.chain} label={w.labels[0] ?? null} />, sort: (w: WalletR) => w.address },
  { key: 'n', header: 'Payments', num: true, cell: (w: WalletR) => w.count, sort: (w: WalletR) => w.count },
  { key: 't', header: 'Total', num: true, cell: (w: WalletR) => <span title={`${(w.share * 100).toFixed(1)}% of ${money(total)} claimed`}>{money(w.total)}</span>, sort: (w: WalletR) => w.total },
  { key: 's', header: 'Share', num: true, hideSm: true, cell: (w: WalletR) => `${(w.share * 100).toFixed(1)}%`, sort: (w: WalletR) => w.share },
  { key: 'f', header: 'First / last', hideSm: true, wrap: true, cell: (w: WalletR) => <span className="small">{w.first ? new Date(w.first).toISOString().slice(0, 10) : '—'} / {w.last ? new Date(w.last).toISOString().slice(0, 10) : '—'}</span>, sort: (w: WalletR) => w.first },
  { key: 'b', header: 'Balance now', num: true, hideSm: true, cell: (w: WalletR) => (w.balance === null ? <span className="muted" title="Balance could not be read">unavailable</span> : money(w.balance)), sort: (w: WalletR) => w.balance },
  { key: 'r', header: 'Risk', wrap: true, cell: (w: WalletR) => (w.risk?.level ? <details><summary style={{ cursor: 'pointer' }}><RiskBadge level={w.risk.level} score={w.risk.score ?? undefined} /></summary><ul className="small" style={{ margin: '6px 0 0', paddingLeft: 16 }}>{w.risk.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></details> : <span className="muted small" title={w.risk?.reasons.join('; ')}>{w.error ? `unreadable: ${w.error}` : w.risk?.reasons[0] ?? '—'}</span>), sort: (w: WalletR) => w.risk?.score ?? -1 },
];

export function Results({ r }: { r: Result }) {
  const t = r.trace;
  const sev = r.findingsBySeverity;
  return (
    <div className="stack" style={{ gap: 16 }} data-testid="analysis-results">
      {(t.partial || r.notes.length > 0) && (
        <Notice tone="warn">
          <b>Partial result: traced {t.walletsTraced} of {t.walletsTotal} wallets</b> ({t.seedsTraced} of {t.seedsTotal} recipient wallets), in {secs(t.durationMs)}. {[...t.hit, ...r.notes].join(' · ')}
        </Notice>
      )}
      <div className="grid g4">
        <Stat label="Claimed by statement" value={money(r.totals.claimed)} sub={`${r.totals.rows} rows`} />
        <Stat label="Verified on-chain" value={money(r.totals.verified)} tone="var(--low)" sub={`${r.totals.byStatus.verified?.count ?? 0} rows match the chain`} />
        <Stat label="Off-chain (same exchange)" value={money(r.totals.offChain.amount)} sub={`${r.totals.offChain.count} rows, cannot be traced`} />
        <Stat label="Wallets traced" value={`${t.walletsTraced} of ${t.walletsTotal}`} sub={`${r.totals.wallets} recipient wallets · ${r.bounds.hops} hops`} />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} aria-label="Findings by severity">
        <b>{r.findings.length} findings</b>{(['high', 'medium', 'low', 'info'] as const).map((k) => <Badge key={k} tone={SEV[k]}>{sev[k] ?? 0} {k}</Badge>)}
      </div>

      <Card title="Findings">
        {r.findings.length === 0 ? <EmptyState title="No findings">None of the pattern rules fired on this data. That is not proof that nothing is wrong: the trace is bounded and the rules are simple.</EmptyState> : <div className="stack" style={{ gap: 8 }}>{r.findings.map((f, i) => <FindingCard key={i} f={f} />)}</div>}
      </Card>

      <Card title={`Endpoints reached (${r.endpoints.length})`}>
        {r.endpoints.length === 0 ? <p className="muted small">The trace did not reach any labelled exchange, service, bridge or high-risk wallet within its bounds.</p> : (
          <Table caption="Endpoints reached" rows={r.endpoints} rowKey={(e) => e.chain + e.address} pageSize={10} cols={[
            { key: 'k', header: 'Type', cell: (e) => <Badge tone={e.kind === 'risk' ? 'high' : e.kind === 'exchange' ? 'medium' : 'info'}>{KIND_LABEL[e.kind] ?? e.kind}</Badge>, sort: (e) => e.kind },
            { key: 'a', header: 'Wallet', cell: (e) => <AddressLink address={e.address} chain={e.chain} label={e.name && e.category ? { name: e.name, category: e.category } : null} /> },
            { key: 'p', header: 'Path from the recipient', wrap: true, cell: (e) => <span className="small">{e.path}</span> },
            { key: 'r', header: 'Why the trace ends', wrap: true, hideSm: true, cell: (e) => <span className="small muted">{e.reason}{e.source ? ` (label source: ${e.source})` : ''}</span> },
          ]} />
        )}
      </Card>

      <Card title="Counterparty wallets" flush>
        <Table caption="Counterparty wallets" rows={r.wallets} rowKey={(w) => w.chain + w.address} pageSize={10} initialSort={{ key: 't', dir: 'desc' }} cols={walletCols(r.totals.claimed)} empty={<EmptyState title="No on-chain recipient wallets">The statement rows are all off-chain.</EmptyState>} />
      </Card>

      <Card title="Case link chart">
        {r.chart.nodes.length > 1 ? <LinkChart chart={r.chart} /> : <p className="muted small">Nothing to chart.</p>}
      </Card>

      <div className="grid g2">
        <Card title="Activity by hour and weekday"><RadialHeatmap transfers={r.points.map(([timestamp, amount]) => ({ timestamp, amount }))} /></Card>
        <Card title="Amounts over time"><AmountBars points={r.points} /></Card>
      </div>

      <Card title={`Timeline (${r.timeline.length}${r.timelineTotal > r.timeline.length ? ` of ${r.timelineTotal}` : ''} dated rows)`} flush>
        <Table caption="Statement timeline" rows={r.timeline} rowKey={(x) => `${x.at}${x.hash ?? x.ref}${x.address}`} pageSize={10} cols={[
          { key: 'd', header: 'Time (UTC)', cell: (x) => <span className="small">{new Date(x.at).toISOString().slice(0, 16).replace('T', ' ')}</span>, sort: (x) => x.at },
          { key: 'h', header: 'Transaction', cell: (x) => (x.hash && x.chain ? <TxLink hash={x.hash} chain={x.chain} /> : <span className="muted small">{x.ref ?? 'off-chain'}</span>) },
          { key: 'a', header: 'To', hideSm: true, cell: (x) => (x.address && x.chain ? <AddressLink address={x.address} chain={x.chain} /> : '—') },
          { key: 'm', header: 'Amount', num: true, cell: (x) => money(x.amount, x.coin.toLowerCase()), sort: (x) => x.amount },
          { key: 's', header: 'Status', cell: (x) => <Badge tone={x.offChain ? 'info' : x.status === 'verified' ? 'good' : 'medium'}>{x.offChain ? 'off-chain' : x.status}</Badge> },
        ]} />
      </Card>
    </div>
  );
}

export function AnalysisTab({ id }: { id: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('cases.manage');
  const list = useApi<Analysis[]>(`/cases/${id}/analyses`, (d) => (d.some((a) => a.status === 'queued' || a.status === 'running') ? 2000 : false));
  const [pick, setPick] = useState<number | null>(null);
  const [f, setF] = useState({ hops: '2', fanout: '5', maxWallets: '60', budgetSec: '180', thresholds: '10000, 15000, 50000, 100000', tz: '0' });
  const [busy, setBusy] = useState(false);
  const runs = list.data ?? [];
  const active = runs.find((a) => a.status === 'queued' || a.status === 'running');
  const shown = runs.find((a) => a.id === pick) ?? runs[0];
  const doneId = shown?.status === 'done' ? shown.id : null;
  const detail = useApi<Analysis>(doneId ? `/cases/${id}/analyses/${doneId}` : null);
  const wasActive = useRef(false);
  useEffect(() => { if (wasActive.current && !active) { setPick(null); } wasActive.current = !!active; }, [active]);

  async function run() {
    setBusy(true);
    try {
      const body = { hops: Number(f.hops), fanout: Number(f.fanout), maxWallets: Number(f.maxWallets), budgetSec: Number(f.budgetSec), thresholds: f.thresholds, tzMin: Math.round(Number(f.tz) * 60) };
      const a = await api<Analysis>(`/cases/${id}/analyses`, { body });
      setPick(a.id); list.reload(); toast.success('Analysis started');
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const field = (k: keyof typeof f, label: string, w = 110, hint?: string) => <Field label={label} hint={hint}><Input aria-label={label} style={{ width: w }} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;

  if (list.loading && !list.data) return <div className="card"><SkeletonRows /></div>;
  if (list.error && !list.data) return <div className="card"><ErrorState error={list.error} status={list.status} onRetry={list.reload} /></div>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="Analysis" actions={runs.length > 1 && (
        <Select sm aria-label="Analysis run" style={{ width: 230 }} value={shown?.id ?? ''} onChange={(e) => setPick(Number(e.target.value))}>
          {runs.map((a, i) => <option key={a.id} value={a.id}>Run #{a.id} · {new Date(a.createdAt).toLocaleString()} · {a.status}{i === 0 ? ' (latest)' : ''}</option>)}
        </Select>)}>
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>Follows the money from every recipient wallet in the case, within the bounds below, then applies pattern rules. Everything is bounded so the free chain API is not flooded: results state what was and was not traced. Exchanges, services, bridges and high-activity wallets end a trace and are shown as endpoints.</p>
          <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Hops (1 to 3)"><Select aria-label="Hops" style={{ width: 90 }} value={f.hops} onChange={(e) => setF({ ...f, hops: e.target.value })}>{[1, 2, 3].map((n) => <option key={n}>{n}</option>)}</Select></Field>
            {field('fanout', 'Wallets per wallet', 120)}
            {field('maxWallets', 'Wallet cap', 100)}
            {field('budgetSec', 'Time budget (s)', 120)}
            {field('thresholds', 'Round thresholds', 250)}
            {field('tz', 'UTC offset (h)', 100)}
            <Button variant="primary" disabled={!manage || !!active || busy} busy={busy} title={manage ? '' : 'Requires cases.manage'} onClick={run}><Play size={14} />{active ? 'Running…' : 'Run analysis'}</Button>
          </div>
          {active && (
            <div role="status" aria-label="Analysis progress">
              <div className="small muted" style={{ marginBottom: 4 }}>Run #{active.id}: {active.status === 'queued' ? 'waiting in the job queue' : active.stage || 'starting'} · {active.progress} wallets traced so far (at most {Number(active.params.maxWallets) + 30})</div>
              <div className="progress"><i style={{ width: `${Math.min(100, Math.round((active.progress / Math.max(1, active.total)) * 100))}%` }} /></div>
            </div>
          )}
        </div>
      </Card>
      {shown?.status === 'failed' && <Notice tone="error"><AlertTriangle size={14} /> Run #{shown.id} failed: {shown.error}</Notice>}
      {!shown && <Card><EmptyState title="No analysis yet">Add transactions to the case (Transactions tab), then run an analysis.</EmptyState></Card>}
      {doneId && detail.loading && !detail.data && <div className="card"><SkeletonRows rows={6} /></div>}
      {detail.error && <div className="card"><ErrorState error={detail.error} status={detail.status} onRetry={detail.reload} /></div>}
      {detail.data?.result && (
        <>
          <div className="small muted">Run #{detail.data.id} finished <DateTime t={detail.data.finishedAt} /> · bounds: {detail.data.result.bounds.hops} hops, {detail.data.result.bounds.fanout} per wallet, {detail.data.result.bounds.maxWallets} onward wallets, {detail.data.result.bounds.budgetSec} s, wallets with {detail.data.result.bounds.busyTransfers}+ transfers count as service-scale.</div>
          <Results r={detail.data.result} />
        </>
      )}
    </div>
  );
}

/** Printable report section (light page): summary, findings with evidence, endpoints, wallets, bounds. */
export function AnalysisReportSection({ a }: { a: Analysis & { result: Result } }) {
  const r = a.result;
  return (
    <>
      <h2>Case analysis (run #{a.id}, {new Date(a.finishedAt ?? a.createdAt).toLocaleString()})</h2>
      <table><tbody>
        <tr><th>Claimed by statement</th><td>{num(r.totals.claimed)}</td><th>Verified on-chain</th><td>{num(r.totals.verified)}</td><th>Off-chain</th><td>{num(r.totals.offChain.amount)} ({r.totals.offChain.count} rows)</td></tr>
        <tr><th>Wallets traced</th><td>{r.trace.walletsTraced} of {r.trace.walletsTotal}</td><th>Findings</th><td colSpan={3}>{(['high', 'medium', 'low', 'info'] as const).map((k) => `${r.findingsBySeverity[k] ?? 0} ${k}`).join(' · ')}</td></tr>
        <tr><th>Bounds</th><td colSpan={5}>{r.bounds.hops} hops · {r.bounds.fanout} wallets per wallet · {r.bounds.maxWallets} onward wallets · {r.bounds.budgetSec} s · high-activity wallets ({r.bounds.busyTransfers}+ transfers) are endpoints</td></tr>
      </tbody></table>
      {(r.trace.partial || r.notes.length > 0) && <p><b>Partial result.</b> {[...r.trace.hit, ...r.notes].join(' · ')}</p>}
      <h3>Findings</h3>
      {r.findings.length === 0 ? <p className="muted">No pattern rule fired.</p> : r.findings.map((f, i) => (
        <div key={i} style={{ marginBottom: 10, breakInside: 'avoid' }}>
          <b>[{f.severity}] {f.title}</b>
          <div>{f.statement}</div>
          <table><tbody>{f.evidence.slice(0, 8).map((e, j) => <tr key={j}><td>{e.kind}</td><td style={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 10 }}>{e.hash ?? e.ref ?? e.address}</td><td>{typeof e.amount === 'number' ? num(e.amount) : ''}</td><td>{e.at ? new Date(e.at).toISOString().slice(0, 16).replace('T', ' ') : ''}</td><td>{e.note ?? ''}</td></tr>)}</tbody></table>
          {f.evidenceTotal > 8 && <div className="muted" style={{ fontSize: 11 }}>{f.evidenceTotal - 8} more evidence rows in the case analysis tab.</div>}
        </div>
      ))}
      <h3>Endpoints reached</h3>
      {r.endpoints.length === 0 ? <p className="muted">None within the bounds.</p> : (
        <table><thead><tr><th>Type</th><th>Wallet</th><th>Name (label source)</th><th>Path</th></tr></thead><tbody>
          {r.endpoints.map((e, i) => <tr key={i}><td>{KIND_LABEL[e.kind] ?? e.kind}</td><td style={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 10 }}>{e.address}</td><td>{e.name ? `${e.name} (${e.source})` : e.reason}</td><td>{e.path}</td></tr>)}
        </tbody></table>
      )}
      <h3>Counterparty wallets</h3>
      <table><thead><tr><th>Wallet</th><th className="num">Payments</th><th className="num">Total</th><th>First / last</th><th className="num">Balance</th><th>Risk and reasons</th></tr></thead><tbody>
        {r.wallets.map((w) => <tr key={w.chain + w.address}><td title={w.address} style={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 10 }}>{w.address}</td><td className="num">{w.count}</td><td className="num">{num(w.total)}</td>
          <td>{w.first ? new Date(w.first).toISOString().slice(0, 10) : '—'} / {w.last ? new Date(w.last).toISOString().slice(0, 10) : '—'}</td><td className="num">{w.balance === null ? 'n/a' : num(w.balance)}</td>
          <td>{w.risk?.level ? `${w.risk.level} (${w.risk.score}): ` : ''}{(w.risk?.reasons ?? []).join('; ')}</td></tr>)}
      </tbody></table>
    </>
  );
}
