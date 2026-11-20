'use client';
import cytoscape, { Core, ElementDefinition, NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { Download, ExternalLink, Focus, Loader2, Maximize2, Network, Plus, Route, Save, ZoomIn, ZoomOut, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AddToCaseModal } from '@/components/AddressActions';
import { AssetChips, ChainChoice } from '@/components/Assets';
import { RequirePerm } from '@/components/Guard';
import { Modal } from '@/components/Modal';
import { CategoryChip, CategoryLegend } from '@/components/Risk';
import { useToast } from '@/components/Toast';
import { Badge, Button, Check2, CopyButton, Field, Input, Notice, Segmented, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addrHref, Asset, ASSET_COLOR, AssetFilter, assetSym, Chain, chainQ, compact, detectChain, download, explorerAddr, exact, money, resolveChain, short, TRON_USDC_NOTE } from '@/lib/format';
import { buildStyle, FLOW_IN, FLOW_OUT, iconFor, ICON_URI, nodeColor, readTheme, Theme } from '@/lib/graphStyle';
import { useApi } from '@/lib/hooks';

let registered = false;
if (!registered) { cytoscape.use(fcose); registered = true; }

interface GTransfer { hash: string; amount: number; timestamp: number; asset?: Asset }
interface GNode { id: string; root?: boolean; expanded: boolean; in?: number; out?: number; label?: string; category?: string; volume?: number; target?: boolean }
interface GEdge { id: string; source: string; target: string; amount: number; count: number; asset?: Asset; transfers?: GTransfer[] }
interface GraphData { chain: Chain; nodes: GNode[]; edges: GEdge[] }
interface PathData extends GraphData { found: boolean; path: string[]; expansions: number; limitReached: boolean }
type Sel = { kind: 'node'; id: string } | { kind: 'edge'; data: Record<string, any> } | null; // eslint-disable-line @typescript-eslint/no-explicit-any
type Layout = 'force' | 'hier' | 'radial';
type EdgeColor = 'flow' | 'category' | 'asset' | 'plain';
const TX_LIMIT = 400;

const day = (ms: number) => new Date(ms).toISOString().slice(5, 10);

function Workspace() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { can } = useAuth();
  const root = params.get('addr') ?? '';
  const caseId = params.get('case');
  const [chainOv, setChainOv] = useState<Chain | null>(null); // a saved case graph carries its own chain
  const chain = chainOv ?? resolveChain(root, params.get('chain'));
  const asset: AssetFilter = params.get('asset') === 'usdt' || params.get('asset') === 'usdc' ? (params.get('asset') as Asset) : 'all';
  const chainRef = useRef(chain);
  chainRef.current = chain;

  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const theme = useRef<Theme | null>(null);
  const nodes = useRef(new Map<string, GNode>());
  const edges = useRef(new Map<string, GEdge>());
  const pathIds = useRef<{ nodes: Set<string>; edges: Set<string> }>({ nodes: new Set(), edges: new Set() });
  const target = useRef('');
  const rootRef = useRef(root);
  rootRef.current = root;

  const [rootInput, setRootInput] = useState(root);
  const [depth, setDepth] = useState('1');
  const [fanout, setFanout] = useState('8');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [min, setMin] = useState('');
  const [pathTo, setPathTo] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [sel, setSel] = useState<Sel>(null);
  const [layout, setLayout] = useState<Layout>('force');
  const [edgeColor, setEdgeColor] = useState<EdgeColor>('flow');
  const [perTx, setPerTx] = useState<boolean | null>(null); // null = automatic
  const [stats, setStats] = useState({ nodes: 0, transfers: 0, hasTransfers: false });
  const [saveOpen, setSaveOpen] = useState(false);
  const [caseAddr, setCaseAddr] = useState('');
  const [showPath, setShowPath] = useState(false);
  const savedCase = useApi<{ title: string; graphJson: unknown }>(caseId ? `/cases/${caseId}` : null);

  const colorTouched = useRef(false); // once the user picks a link colour we stop switching to asset colours automatically
  const L = useRef({ layout, edgeColor, perTx });
  L.current = { layout, edgeColor, perTx };
  const filterQs = () => {
    const q = new URLSearchParams({ fanout, transfers: 'true', asset });
    if (chainRef.current === 'bsc') q.set('chain', 'bsc');
    if (from) q.set('from', from);
    if (to) q.set('to', `${to}T23:59:59`);
    if (min) q.set('min', min);
    return q.toString();
  };

  const usePerTx = () => {
    const total = [...edges.current.values()].reduce((s, e) => s + (e.transfers?.length ?? 0), 0);
    const any = total > 0;
    return { any, total, on: any && (L.current.perTx ?? total <= TX_LIMIT) };
  };

  const recolor = useCallback(() => {
    const c = cy.current, th = theme.current;
    if (!c || !th) return;
    const selNode = c.$('node:selected');
    const anchor = selNode.nonempty() ? selNode.id() : rootRef.current;
    c.edges().forEach((e) => {
      const s = e.data('source'), t = e.data('target');
      let col = th.edge;
      if (L.current.edgeColor === 'flow') col = t === anchor ? FLOW_IN : s === anchor ? FLOW_OUT : th.edge;
      else if (L.current.edgeColor === 'category') col = c.getElementById(s === anchor ? t : s).data('color') ?? th.edge;
      else if (L.current.edgeColor === 'asset') col = ASSET_COLOR[(e.data('asset') as Asset) ?? 'usdt'] ?? th.edge;
      e.data('color', col);
    });
  }, []);

  const focus = useCallback((n: NodeSingular | null) => {
    const c = cy.current;
    if (!c) return;
    c.elements().removeClass('dim');
    if (n && n.nonempty()) c.elements().not(n.closedNeighborhood()).addClass('dim');
  }, []);

  /** Rebuild cytoscape elements from the node/edge stores. */
  const sync = useCallback(() => {
    const c = cy.current;
    if (!c) return;
    const vol = new Map<string, number>();
    for (const e of edges.current.values()) { vol.set(e.source, (vol.get(e.source) ?? 0) + e.amount); vol.set(e.target, (vol.get(e.target) ?? 0) + e.amount); }
    const add: ElementDefinition[] = [];
    for (const n of nodes.current.values()) {
      const v = n.volume ?? vol.get(n.id) ?? 0;
      const base = 28 + Math.min(26, Math.log10(1 + v) * 4.2);
      const isRoot = n.id === rootRef.current || !!n.root;
      const data = {
        ...n, root: isRoot, target: n.id === target.current, color: nodeColor(n.category), icon: ICON_URI[iconFor(n.category)], size: isRoot ? base + 14 : base,
        label: `${n.label ?? short(n.id)}\n${n.category ?? (v ? `${compact(v)} USD` : '')}`,
      };
      const ex = c.getElementById(n.id);
      if (ex.nonempty()) ex.data(data); else add.push({ group: 'nodes', data });
    }
    c.add(add);
    c.edges().remove();
    const mode = usePerTx();
    const els: ElementDefinition[] = [];
    for (const e of edges.current.values()) {
      if (!nodes.current.has(e.source) || !nodes.current.has(e.target)) continue;
      if (mode.on && e.transfers?.length) {
        e.transfers.forEach((t, i) => els.push({ group: 'edges', data: { id: `${e.id}#${i}`, source: e.source, target: e.target, parent: e.id, kind: 'tx', asset: t.asset ?? e.asset ?? 'usdt', amount: t.amount, hash: t.hash, ts: t.timestamp, w: 1.2 + Math.min(3.3, Math.log10(1 + t.amount) * .6), label: `${compact(t.amount)}\n${t.timestamp ? day(t.timestamp) : ''}`, color: '#888' } }));
      } else {
        els.push({ group: 'edges', data: { id: e.id, source: e.source, target: e.target, parent: e.id, kind: 'agg', asset: e.asset ?? 'usdt', amount: e.amount, count: e.count, w: 1.5 + Math.min(6, Math.log10(1 + e.amount) * 1.2), label: `${compact(e.amount)} ${assetSym(e.asset)}${e.count > 1 ? ` · ${e.count}×` : ''}`, color: '#888' } });
      }
    }
    c.add(els);
    pathIds.current.nodes.forEach((id) => c.getElementById(id).addClass('path'));
    pathIds.current.edges.forEach((id) => c.edges().filter((e) => e.data('parent') === id).addClass('path'));
    if (!colorTouched.current && [...edges.current.values()].some((e) => (e.asset ?? 'usdt') !== 'usdt')) { L.current.edgeColor = 'asset'; setEdgeColor('asset'); } // mixed assets: colour by asset by default
    recolor();
    setStats({ nodes: nodes.current.size, transfers: mode.total, hasTransfers: mode.any });
  }, [recolor]);

  const runLayout = useCallback((name?: Layout, fit = true) => {
    const c = cy.current;
    if (!c || c.nodes().empty()) return;
    const l = name ?? L.current.layout;
    const r = c.getElementById(rootRef.current);
    const common = { animate: false, padding: 70, fit };
    if (l === 'force') c.layout({ name: 'fcose', quality: 'default', randomize: true, nodeRepulsion: () => 12000, idealEdgeLength: () => 120, nodeSeparation: 90, ...common } as cytoscape.LayoutOptions).run();
    else if (l === 'hier') {
      const sources = c.nodes().filter((n) => n.indegree(false) === 0);
      c.layout({ name: 'breadthfirst', directed: true, roots: sources.nonempty() ? sources : r.nonempty() ? r : undefined, spacingFactor: 1.3, ...common } as cytoscape.LayoutOptions).run();
    } else {
      const dist = new Map<string, number>();
      if (r.nonempty()) c.elements().bfs({ roots: r, directed: false, visit: (n, _e, _u, _i, d) => { dist.set(n.id(), d); } });
      const mx = Math.max(1, ...dist.values());
      c.layout({ name: 'concentric', concentric: (n: NodeSingular) => mx - (dist.get(n.id()) ?? mx) + 1, levelWidth: () => 1, minNodeSpacing: 40, spacingFactor: 1.15, ...common } as cytoscape.LayoutOptions).run();
    }
  }, []);

  const merge = useCallback((g: GraphData) => {
    let added = 0;
    for (const n of g.nodes) {
      const ex = nodes.current.get(n.id);
      if (!ex) { nodes.current.set(n.id, { ...n }); added++; }
      else nodes.current.set(n.id, { ...ex, ...n, expanded: ex.expanded || n.expanded, root: ex.root || n.root });
    }
    for (const e of g.edges) {
      const ex = edges.current.get(e.id);
      if (!ex) { edges.current.set(e.id, e); added++; } else if (!ex.transfers && e.transfers) edges.current.set(e.id, { ...ex, ...e });
    }
    return added;
  }, []);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(''); setInfo('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }, []);

  const loadRoot = useCallback(() => {
    if (!detectChain(rootRef.current)) return;
    return run('Loading graph…', async () => {
      const g = await api<GraphData>(`/graph/${rootRef.current}?depth=${depth}&${filterQs()}`);
      colorTouched.current = false;
      nodes.current.clear(); edges.current.clear(); pathIds.current = { nodes: new Set(), edges: new Set() }; target.current = '';
      cy.current?.elements().remove();
      merge(g);
      nodes.current.set(rootRef.current, { ...(nodes.current.get(rootRef.current) ?? { id: rootRef.current, expanded: true }), root: true });
      sync(); runLayout();
      cy.current?.getElementById(rootRef.current).select();
      if (g.nodes.length <= 1) setInfo('No transfers found for this wallet with the current filters.');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth, fanout, from, to, min, asset, merge, sync, runLayout, run]);

  const expand = useCallback((id: string) => run(`Expanding ${short(id)}…`, async () => {
    const g = await api<GraphData>(`/graph/${id}?depth=1&${filterQs()}`);
    const added = merge(g);
    const n = nodes.current.get(id); if (n) n.expanded = true;
    sync(); if (added) runLayout(undefined, false); else setInfo('No new counterparties for this wallet with the current filters.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fanout, from, to, min, asset, merge, sync, runLayout, run]);

  const S = useRef({ expand });
  S.current = { expand };

  // Create the Cytoscape instance once; restyle on theme change.
  useEffect(() => {
    theme.current = readTheme();
    const c = cytoscape({ container: box.current, style: buildStyle(theme.current), minZoom: .08, maxZoom: 3, wheelSensitivity: .3 });
    c.on('select', 'node', (e) => { setSel({ kind: 'node', id: e.target.id() }); focus(e.target as NodeSingular); recolor(); });
    c.on('select', 'edge', (e) => setSel({ kind: 'edge', data: e.target.data() }));
    c.on('unselect', () => { setTimeout(() => { if (c.$(':selected').empty()) { setSel(null); focus(null); recolor(); } }, 0); });
    c.on('mouseover', 'node', (e) => focus(e.target as NodeSingular));
    c.on('mouseout', 'node', () => focus(c.$('node:selected').first() as NodeSingular));
    c.on('dbltap', 'node', (e) => S.current.expand(e.target.id()));
    cy.current = c;
    const mo = new MutationObserver(() => { theme.current = readTheme(); c.style(buildStyle(theme.current)); recolor(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const ro = new ResizeObserver(() => c.resize());
    if (box.current) ro.observe(box.current);
    return () => { mo.disconnect(); ro.disconnect(); c.destroy(); cy.current = null; };
  }, [focus, recolor]);

  // Re-render edges / recolour when the display options change.
  useEffect(() => { if (nodes.current.size) sync(); }, [perTx, sync]);
  useEffect(() => { recolor(); }, [edgeColor, recolor]);
  useEffect(() => { if (nodes.current.size) runLayout(layout); }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load when the start address changes (not for saved-case views).
  useEffect(() => { setRootInput(root); if (!caseId) loadRoot(); }, [root, asset, chain === 'bsc']); // eslint-disable-line react-hooks/exhaustive-deps

  // Open a saved case graph.
  useEffect(() => {
    const gj = savedCase.data?.graphJson;
    if (!gj || !cy.current) return;
    try {
      const el = (typeof gj === 'string' ? JSON.parse(gj) : gj) as { chain?: Chain; nodes?: { data: GNode }[]; edges?: { data: GEdge }[] };
      if (el.chain) setChainOv(el.chain);
      nodes.current.clear(); edges.current.clear(); cy.current.elements().remove();
      (el.nodes ?? []).forEach((n) => nodes.current.set(n.data.id, n.data));
      (el.edges ?? []).forEach((e) => edges.current.set(e.data.id, e.data));
      const r = [...nodes.current.values()].find((n) => n.root);
      if (r) { rootRef.current = r.id; setRootInput(r.id); }
      sync(); runLayout(); setInfo(`Saved graph from case “${savedCase.data?.title}”. Double-click a wallet to keep expanding.`);
    } catch { setError('This case graph could not be read.'); }
  }, [savedCase.data]); // eslint-disable-line react-hooks/exhaustive-deps

  function submitRoot(e: React.FormEvent) {
    e.preventDefault();
    const v = rootInput.trim();
    if (!detectChain(v)) return setError('Enter a valid Tron (T…) or Ethereum / BNB Chain (0x…) address.');
    setError('');
    if (v === root && !caseId) loadRoot(); else router.replace(graphHref(v));
  }

  function findPath(e: React.FormEvent) {
    e.preventDefault();
    const t = pathTo.trim();
    if (!detectChain(t)) return setError('Enter a valid destination address.');
    run('Searching for a money path (this can take a while)…', async () => {
      const p = await api<PathData>(`/path?from=${root}&to=${t}&maxHops=4&fanout=10&asset=${asset}${chain === 'bsc' ? '&chain=bsc' : ''}`);
      cy.current?.elements().removeClass('path');
      pathIds.current = { nodes: new Set(), edges: new Set() };
      target.current = '';
      if (!p.found) { setInfo(p.limitReached ? `No path found after checking ${p.expansions} wallets (search limit reached). It may be longer or go through smaller transfers.` : `No path within 4 hops: money from this wallet does not reach ${short(t)} through its largest counterparties.`); return; }
      merge(p);
      target.current = t;
      p.path.forEach((id) => pathIds.current.nodes.add(id));
      p.edges.forEach((ed) => pathIds.current.edges.add(ed.id));
      sync(); runLayout();
      setInfo(`Path found: ${p.path.length - 1} hop${p.path.length > 2 ? 's' : ''}, highlighted in yellow (start ring yellow, destination ring green).`);
    });
  }

  const png = (scale: number) => cy.current!.png({ full: true, scale, bg: theme.current?.bg });
  const exportPng = () => {
    if (!cy.current || cy.current.nodes().empty()) return toast.error('Nothing to export yet');
    const a = document.createElement('a'); a.href = png(2); a.download = `graph-${short(root) || 'export'}.png`; a.click();
  };
  const elementsJson = () => ({
    chain: chain ?? 'tron', // eth | bsc matters for 0x wallets; the case timeline needs it
    nodes: [...nodes.current.values()].map((n) => ({ data: n })),
    edges: [...edges.current.values()].map((e) => ({ data: e })),
  });

  const graphHref = (a: string, over: { chain?: Chain | null; asset?: AssetFilter } = {}) => {
    const q = [chainQ(over.chain === undefined ? chain : over.chain), (over.asset ?? asset) !== 'all' ? `asset=${over.asset ?? asset}` : ''].filter(Boolean).join('&');
    return `/graph?addr=${a}${q ? `&${q}` : ''}`;
  };
  const selNode = sel?.kind === 'node' ? nodes.current.get(sel.id) : undefined;
  const mode = usePerTx();
  const zoom = (f: number) => { const c = cy.current!; c.zoom({ level: c.zoom() * f, renderedPosition: { x: c.width() / 2, y: c.height() / 2 } }); };

  return (
    <div className="ws">
      <form className="ws-bar no-print" onSubmit={submitRoot}>
        <Field label="Start address" className="grow" ><Input className="mono" style={{ minWidth: 220 }} value={rootInput} onChange={(e) => setRootInput(e.target.value)} placeholder="T… or 0x…" spellCheck={false} /></Field>
        <ChainChoice addr={rootInput} value={chain ?? 'eth'} onChange={(c) => { if (rootInput.trim() === root) router.replace(graphHref(root, { chain: c })); else setChainOv(c); }} />
        <Field label="Depth"><Select sm value={depth} onChange={(e) => setDepth(e.target.value)} style={{ width: 62 }}>{['1', '2', '3'].map((d) => <option key={d}>{d}</option>)}</Select></Field>
        <Field label="Per wallet"><Select sm value={fanout} onChange={(e) => setFanout(e.target.value)} style={{ width: 66 }}>{['5', '8', '10', '15'].map((d) => <option key={d}>{d}</option>)}</Select></Field>
        <Field label="From"><Input sm type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input sm type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Min amount"><Input sm type="number" min="0" value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 84 }} /></Field>
        <Button variant="primary" type="submit" busy={!!busy}>Load</Button>
        <span className="end row">
          <Button sm onClick={() => setShowPath((s) => !s)} aria-pressed={showPath}><Route size={14} />Path finder</Button>
          <Button sm onClick={exportPng}><Download size={14} />PNG</Button>
          <Button sm variant="primary" disabled={!can('cases.manage') || !stats.nodes} title={can('cases.manage') ? '' : 'Requires cases.manage'} onClick={() => setSaveOpen(true)}><Save size={14} />Save to case</Button>
        </span>
        <div className="row" style={{ width: '100%', gap: 14 }}>
          <Segmented label="Layout" value={layout} onChange={setLayout} options={[{ id: 'force', label: 'Force' }, { id: 'hier', label: 'Hierarchy' }, { id: 'radial', label: 'Concentric' }]} />
          <AssetChips value={asset} onChange={(a) => router.replace(graphHref(root, { asset: a }))} />
          <Segmented label="Link colour" value={edgeColor} onChange={(v) => { colorTouched.current = true; setEdgeColor(v); }} options={[{ id: 'flow', label: 'In / out' }, { id: 'asset', label: 'Asset' }, { id: 'category', label: 'Category' }, { id: 'plain', label: 'Plain' }]} />
          <Check2 checked={mode.on} disabled={!mode.any} onChange={(v) => setPerTx(v)}><span className="small">Show individual transfers</span></Check2>
          {!mode.any && stats.nodes > 0 && <span className="xs muted">(per-transfer links not provided by the server yet)</span>}
          {mode.any && perTx === null && mode.total > TX_LIMIT && <span className="xs muted">Aggregated automatically ({mode.total} transfers)</span>}
        </div>
        {showPath && (
          <div className="row nw" style={{ width: '100%' }}>
            <span className="small muted">Find money path from start to</span>
            <Input sm className="mono grow" value={pathTo} onChange={(e) => setPathTo(e.target.value)} placeholder="Destination address" aria-label="Destination address" />
            <Button sm variant="primary" busy={!!busy} onClick={findPath as unknown as () => void}>Find path</Button>
          </div>
        )}
      </form>

      <div className="ws-body">
        <div className="ws-canvas">
          <div className="cy" ref={box} aria-label="Fund-flow graph" role="application" />
          {chain === 'tron' && asset !== 'usdt' && root && <div className="ws-float" style={{ top: 8, left: 8, maxWidth: 360 }}><Notice>{TRON_USDC_NOTE}</Notice></div>}
          {!root && !caseId && (
            <div className="ws-float ws-empty"><div className="card card-b stack sm" style={{ maxWidth: 380, textAlign: 'center' }}>
              <Network size={28} className="muted" style={{ margin: '0 auto' }} /><h2>Trace the flow of funds</h2>
              <p className="muted">Enter a Tron, Ethereum or BNB Chain address above to draw who it paid and who paid it. Double-click any wallet to expand it.</p>
            </div></div>
          )}
          <div className="ws-float ws-ctl no-print" role="group" aria-label="Zoom controls">
            <Button icon aria-label="Zoom in" onClick={() => zoom(1.3)}><ZoomIn size={16} /></Button>
            <Button icon aria-label="Zoom out" onClick={() => zoom(1 / 1.3)}><ZoomOut size={16} /></Button>
            <Button icon aria-label="Fit to screen" onClick={() => cy.current?.fit(undefined, 40)}><Maximize2 size={16} /></Button>
            <Button icon aria-label="Re-run layout" onClick={() => runLayout()}><Shuffle size={16} /></Button>
            <Button icon aria-label="Centre on start wallet" onClick={() => { const n = cy.current?.getElementById(root); if (n?.nonempty()) cy.current?.animate({ center: { eles: n }, zoom: 1 }, { duration: 200 }); }}><Focus size={16} /></Button>
          </div>
          <div className="ws-float ws-status" aria-live="polite">
            {busy && <Notice><span className="row"><Loader2 size={14} className="spin" />{busy}</span></Notice>}
            {error && <Notice tone="error">{error}</Notice>}
            {info && !busy && <Notice>{info}</Notice>}
          </div>
          <details className="ws-float ws-legend stack sm no-print">
            <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>Legend{stats.nodes > 0 && <span className="faint" style={{ fontWeight: 400 }}> · {stats.nodes} wallets{stats.transfers ? ` · ${stats.transfers} transfers` : ''}</span>}</summary>
            <CategoryLegend />
            <div className="legend">
              <span><i className="dot" style={{ background: '#facc15' }} />Start wallet</span><span><i className="dot" style={{ background: '#22c55e' }} />Path destination</span>
              {edgeColor === 'flow' && <><span><i className="dot" style={{ background: FLOW_IN }} />Inflow</span><span><i className="dot" style={{ background: FLOW_OUT }} />Outflow</span></>}
              {edgeColor === 'asset' && <><span><i className="dot" style={{ background: ASSET_COLOR.usdt }} />USDT link</span><span><i className="dot" style={{ background: ASSET_COLOR.usdc }} />USDC link</span></>}
              <span>Volumes in USD (USDT and USDC ≈ $1)</span>
              <span>Dashed ring = not expanded · size = volume</span>
            </div>
          </details>
        </div>
        {(sel || true) && (
          <aside className={`ws-side${sel ? '' : ' hide-sm'}`} aria-label="Details">
            {!sel && <p className="muted small">Click a wallet or a link for details. <b>Double-click</b> a wallet to expand its counterparties. Hover to highlight a wallet&apos;s neighbourhood.</p>}
            {sel?.kind === 'node' && selNode && (
              <div className="stack">
                <div className="row spread"><h3>Wallet</h3><Button sm variant="ghost" onClick={() => cy.current?.elements().unselect()}>Close</Button></div>
                <div className="row nw"><code className="break small">{selNode.id}</code><CopyButton value={selNode.id} label="Copy address" /></div>
                {selNode.category && <div><CategoryChip category={selNode.category} name={selNode.label} /></div>}
                {selNode.root && <Badge tone="medium">Start wallet</Badge>}
                {selNode.expanded && selNode.in !== undefined && <dl className="kv" style={{ gridTemplateColumns: '90px 1fr' }}><dt>Received</dt><dd>{money(selNode.in)}</dd><dt>Sent</dt><dd>{money(selNode.out)}</dd></dl>}
                <div className="stack sm">
                  <Button variant="primary" busy={!!busy} onClick={() => expand(selNode.id)}>Expand counterparties</Button>
                  <Link className="btn" href={addrHref(selNode.id, chain, asset)} target="_blank">Wallet details</Link>
                  <Button onClick={() => router.replace(graphHref(selNode.id))}>Start graph here</Button>
                  <Button onClick={() => { setPathTo(selNode.id); setShowPath(true); }}><Route size={14} />Use as path destination</Button>
                  <Button disabled={!can('cases.manage')} onClick={() => setCaseAddr(selNode.id)}><Plus size={14} />Add to case</Button>
                  {chain && <a className="btn ghost" href={explorerAddr(chain, selNode.id)} target="_blank" rel="noreferrer"><ExternalLink size={14} />Explorer</a>}
                </div>
              </div>
            )}
            {sel?.kind === 'edge' && (
              <div className="stack">
                <div className="row spread"><h3>{sel.data.kind === 'tx' ? 'Transfer' : 'Flow'}</h3><Button sm variant="ghost" onClick={() => cy.current?.elements().unselect()}>Close</Button></div>
                <div className="small mono break"><Link href={`/address/${sel.data.source}`}>{short(sel.data.source)}</Link> → <Link href={`/address/${sel.data.target}`}>{short(sel.data.target)}</Link></div>
                <div style={{ fontSize: 22, fontWeight: 650 }}>{money(sel.data.amount, sel.data.asset)}</div>
                {sel.data.kind === 'tx' ? (
                  <dl className="kv" style={{ gridTemplateColumns: '60px 1fr' }}>
                    <dt>Time</dt><dd title={exact(sel.data.ts)}>{exact(sel.data.ts)}</dd>
                    <dt>Tx</dt><dd className="row nw"><Link href={`/tx/${chain}/${sel.data.hash}`} className="mono small break">{short(sel.data.hash)}</Link><CopyButton value={sel.data.hash} label="Copy hash" /></dd>
                  </dl>
                ) : (
                  <>
                    <span className="muted small">{sel.data.count} transfer{sel.data.count === 1 ? '' : 's'} in total</span>
                    {(edges.current.get(sel.data.parent)?.transfers ?? []).slice(0, 12).map((t, i) => (
                      <div key={i} className="row nw small" style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                        <span className="grow" title={exact(t.timestamp)}>{money(t.amount, t.asset ?? sel.data.asset)}<br /><span className="xs muted">{exact(t.timestamp)}</span></span>
                        <Link href={`/tx/${chain}/${t.hash}`} className="mono xs">{short(t.hash)}</Link>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
      {saveOpen && <SaveToCase onClose={() => setSaveOpen(false)} getPayload={() => ({ elements: elementsJson(), png: png(1) })} />}
      {caseAddr && <AddToCaseModal address={caseAddr} chain={chain ?? undefined} onClose={() => setCaseAddr('')} />}
    </div>
  );
}

function SaveToCase({ onClose, getPayload }: { onClose: () => void; getPayload: () => { elements: unknown; png: string } }) {
  const toast = useToast();
  const router = useRouter();
  const cases = useApi<{ id: number; title: string; status: string }[]>('/cases');
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = (cases.data ?? []).filter((c) => c.status === 'open');
  useEffect(() => { if (cases.data && !id) setId(open[0] ? String(open[0].id) : 'new'); }, [cases.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Save graph to case" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={async () => {
      setBusy(true); setErr('');
      try {
        let cid = id;
        if (id === 'new') { if (!title.trim()) throw new Error('Give the new case a title'); cid = String((await api<{ id: number }>('/cases', { body: { title: title.trim() } })).id); }
        await api(`/cases/${cid}/graph`, { method: 'PUT', body: getPayload() });
        toast.success('Graph saved to case');
        router.push(`/cases/${cid}`);
      } catch (e) { setErr((e as Error).message); setBusy(false); }
    }}>Save</Button></>}>
      <div className="stack">
        <p className="muted small">Saves the current wallets, links and a snapshot image. It replaces any graph already saved on that case.</p>
        {cases.error && <Notice tone="warn">Could not load cases: {cases.error}</Notice>}
        <Field label="Case"><Select value={id} onChange={(e) => setId(e.target.value)}>{open.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}<option value="new">+ Create new case…</option></Select></Field>
        {id === 'new' && <Field label="New case title"><Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>}
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Modal>
  );
}

export default function GraphPage() {
  return <RequirePerm perm="investigate.view"><Suspense fallback={<div className="page"><div className="skel" style={{ height: 300 }} /></div>}><Workspace /></Suspense></RequirePerm>;
}
