'use client';
import cytoscape, { Core, ElementDefinition, NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { ArrowRightLeft, Download, ExternalLink, Focus, Loader2, Maximize2, Network, Plus, Route, Save, ZoomIn, ZoomOut, Shuffle, Waypoints } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AddToCaseModal } from '@/components/AddressActions';
import { AssetChips, ChainChoice } from '@/components/Assets';
import { RequirePerm } from '@/components/Guard';
import { Modal } from '@/components/Modal';
import { CategoryChip, CategoryLegend } from '@/components/Risk';
import { useToast } from '@/components/Toast';
import { Badge, Button, Check2, CopyButton, Field, Input, Notice, Segmented, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addrHref, Asset, ASSET_COLOR, AssetFilter, assetSym, Chain, chainName, chainQ, compact, detectChain, download, explorerAddr, exact, money, resolveChain, short, TRON_USDC_NOTE } from '@/lib/format';
import { buildStyle, FLOW_IN, FLOW_OUT, iconFor, ICON_URI, nodeColor, readTheme, Theme } from '@/lib/graphStyle';
import { useApi } from '@/lib/hooks';

let registered = false;
if (!registered) { cytoscape.use(fcose); registered = true; }

interface GTransfer { hash: string; amount: number; timestamp: number; asset?: Asset }
// Node ids: a bare address belongs to the graph's own chain (so every graph saved before 7C stays valid); a wallet on another chain is `chain:address`.
interface GNode { id: string; root?: boolean; expanded: boolean; in?: number; out?: number; label?: string; category?: string; volume?: number; target?: boolean; chain?: Chain; swap?: { symbol: string; amount: number; asset: Asset; hash: string; ts: number } }
interface GEdge { id: string; source: string; target: string; amount: number; count: number; asset?: Asset; transfers?: GTransfer[]; chain?: Chain; xchain?: boolean; evidence?: HopEvidence }
interface HopEvidence { confidence: number; level: string; reasons: string[]; hash: string; chain: Chain; bridge: string; bridgeName: string; amountDelta: number; timeDeltaSec: number; sourceChain: Chain; sourceHash: string; sourceAmount: number; sourceBridge: string }
interface Hop { chain: Chain; hash: string; bridge: string; bridgeName: string; to: string; amount: number; asset: Asset; ts: number; amountDelta: number; amountDeltaPct: number; timeDeltaSec: number; bridgePair: { from: string; to: string }; confidence: number; level: 'high' | 'medium' | 'low'; reasons: string[] }
interface HopResult { source: { chain: Chain; hash: string; bridge: string; bridgeName: string; amount: number; asset: Asset; timestamp: number }; params: { windowMin: number; tolerancePct: number }; sides: { chain: Chain; status: 'ok' | 'no_bridge_labels' | 'error'; bridges: number; scanned: number; truncated: boolean; error?: string }[]; candidates: Hop[]; note: string }
interface SwapScan { swaps: { asset: Asset; amount: number; native?: { symbol: string; amount: number }; hash: string; timestamp: number }[]; errors: { hash: string; error: string }[]; outgoingTx: number; scanned: number; nextOffset: number | null }
interface GraphData { chain: Chain; nodes: GNode[]; edges: GEdge[] }
interface PathData extends GraphData { found: boolean; path: string[]; expansions: number; limitReached: boolean }
type Sel = { kind: 'node'; id: string } | { kind: 'edge'; data: Record<string, any> } | null; // eslint-disable-line @typescript-eslint/no-explicit-any
type Layout = 'force' | 'hier' | 'radial';
type EdgeColor = 'flow' | 'category' | 'asset' | 'plain';
const TX_LIMIT = 400;

const keyOf = (c: Chain, base: Chain | null, a: string) => (c === base ? a : `${c}:${a}`);
const parseKey = (id: string, base: Chain | null): { chain: Chain; addr: string } => {
  const m = /^(tron|eth|bsc):(.+)$/.exec(id);
  return m ? { chain: m[1] as Chain, addr: m[2] } : { chain: base ?? 'tron', addr: id };
};
const CHAIN_TAG: Record<Chain, string> = { tron: 'TRON', eth: 'ETH', bsc: 'BSC' };

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
  const [hopFor, setHopFor] = useState('');
  const [hopCase, setHopCase] = useState<{ chain: Chain; address: string; note: string } | null>(null);
  const savedCase = useApi<{ title: string; graphJson: unknown }>(caseId ? `/cases/${caseId}` : null);

  const colorTouched = useRef(false); // once the user picks a link colour we stop switching to asset colours automatically
  const L = useRef({ layout, edgeColor, perTx });
  L.current = { layout, edgeColor, perTx };
  const filterQs = (c: Chain | null = chainRef.current) => {
    const q = new URLSearchParams({ fanout, transfers: 'true', asset });
    if (c === 'bsc') q.set('chain', 'bsc');
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
      if (e.data('xchain')) return void e.data('color', '#0ea5e9');
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
      const k = parseKey(n.id, chainRef.current);
      const foreign = k.chain !== chainRef.current ? ` [${CHAIN_TAG[k.chain]}]` : '';
      const data = {
        ...n, root: isRoot, target: n.id === target.current, color: nodeColor(n.category), icon: ICON_URI[iconFor(n.category)], size: isRoot ? base + 14 : base,
        label: `${n.label ?? short(k.addr)}${foreign}\n${n.swap ? `left ${assetSym(n.swap.asset)} here → ${n.swap.symbol}` : n.category ?? (v ? `${compact(v)} USD` : '')}`,
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
      if (e.xchain) {
        els.push({ group: 'edges', data: { id: e.id, source: e.source, target: e.target, parent: e.id, kind: 'xchain', xchain: true, chain: e.chain, asset: e.asset ?? 'usdt', amount: e.amount, w: 2.8, label: `cross-chain (heuristic)\n≈${compact(e.amount)} ${assetSym(e.asset)} · ${Math.round((e.evidence?.confidence ?? 0) * 100)}%`, color: '#0ea5e9' } });
        continue;
      }
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

  /** `gc`: the chain the server built `g` on; ids of any other chain than the graph's own get the `chain:` prefix. */
  const merge = useCallback((g: GraphData, gc?: Chain) => {
    let added = 0;
    const base = chainRef.current, c = gc ?? base;
    const k = (a: string) => keyOf(c ?? 'tron', base, a);
    const foreign = c !== base;
    for (const n0 of g.nodes) {
      const n: GNode = foreign ? { ...n0, id: k(n0.id), chain: c ?? undefined, root: false } : n0;
      const ex = nodes.current.get(n.id);
      if (!ex) { nodes.current.set(n.id, { ...n }); added++; }
      else nodes.current.set(n.id, { ...ex, ...n, expanded: ex.expanded || n.expanded, root: ex.root || n.root });
    }
    for (const e0 of g.edges) {
      const e: GEdge = foreign ? { ...e0, id: k(e0.id), source: k(e0.source), target: k(e0.target), chain: c ?? undefined } : e0;
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
      merge(g, g.chain);
      nodes.current.set(rootRef.current, { ...(nodes.current.get(rootRef.current) ?? { id: rootRef.current, expanded: true }), root: true });
      sync(); runLayout();
      cy.current?.getElementById(rootRef.current).select();
      if (g.nodes.length <= 1) setInfo('No transfers found for this wallet with the current filters.');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth, fanout, from, to, min, asset, merge, sync, runLayout, run]);

  const expand = useCallback((id: string) => run(`Expanding ${short(id)}…`, async () => {
    const k = parseKey(id, chainRef.current);
    const g = await api<GraphData>(`/graph/${k.addr}?depth=1&${filterQs(k.chain)}`);
    const added = merge(g, k.chain);
    const n = nodes.current.get(id); if (n) n.expanded = true;
    sync(); if (added) runLayout(undefined, false); else setInfo('No new counterparties for this wallet with the current filters.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fanout, from, to, min, asset, merge, sync, runLayout, run]);

  const S = useRef({ expand });
  S.current = { expand };

  /** 7.14: on-demand swap check, newest outgoing transactions first, in small chunks (each tx lookup is a live chain call). */
  const checkSwaps = (id: string) => run(`Checking ${short(parseKey(id, chain).addr)} for swaps…`, async () => {
    const k = parseKey(id, chain);
    const found: SwapScan['swaps'] = [];
    let offset = 0, scanned = 0, outgoing = 0;
    const errs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await api<SwapScan>(`/address/${k.addr}/swaps?max=4&offset=${offset}${k.chain === 'bsc' ? '&chain=bsc' : ''}`);
      found.push(...r.swaps); scanned += r.scanned; outgoing = r.outgoingTx; errs.push(...r.errors.map((x) => x.error));
      if (r.nextOffset === null) break;
      offset = r.nextOffset;
    }
    const n = nodes.current.get(id);
    if (n && found[0]) n.swap = { symbol: found[0].native?.symbol ?? 'DEX', amount: found[0].amount, asset: found[0].asset, hash: found[0].hash, ts: found[0].timestamp };
    sync();
    setInfo(`Checked the ${scanned} newest of ${outgoing} outgoing transactions: ${found.length ? `${found.length} swap${found.length > 1 ? 's' : ''} found (newest: ${found[0].native ? `${money(found[0].amount, found[0].asset)} → ${found[0].native.amount} ${found[0].native.symbol}` : 'via a labelled DEX'}).` : 'no swap found.'}${errs.length ? ` ${errs.length} lookup(s) failed: ${errs[0]}` : ''}`);
  });

  /** Accept a heuristic hop: adds the destination wallet and a dashed cross-chain edge carrying the evidence. Nothing is saved until the graph or the hop is saved to a case. */
  const acceptHop = (srcId: string, h: Hop, src: HopResult['source']) => {
    const dst = keyOf(h.chain, chainRef.current, h.to);
    if (!nodes.current.has(dst)) nodes.current.set(dst, { id: dst, chain: h.chain, expanded: false });
    const id = `x:${srcId}>${dst}`;
    edges.current.set(id, { id, source: srcId, target: dst, amount: h.amount, count: 1, asset: h.asset, chain: h.chain, xchain: true,
      evidence: { confidence: h.confidence, level: h.level, reasons: h.reasons, hash: h.hash, chain: h.chain, bridge: h.bridge, bridgeName: h.bridgeName, amountDelta: h.amountDelta, timeDeltaSec: h.timeDeltaSec, sourceChain: src.chain, sourceHash: src.hash, sourceAmount: src.amount, sourceBridge: src.bridgeName } });
    sync(); runLayout(undefined, false);
    cy.current?.getElementById(dst).select();
    setInfo('Cross-chain continuation added as a dashed heuristic link. It is a candidate, not a finding.');
  };

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
      merge(p, p.chain);
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
  const selK = selNode ? parseKey(selNode.id, chain) : null;
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
              <span><i className="dot" style={{ background: '#0ea5e9' }} />Dashed link = cross-chain (heuristic)</span><span><i className="dot" style={{ background: '#f59e0b' }} />Double ring = left stablecoins here (swap)</span>
            </div>
          </details>
        </div>
        {(sel || true) && (
          <aside className={`ws-side${sel ? '' : ' hide-sm'}`} aria-label="Details">
            {!sel && <p className="muted small">Click a wallet or a link for details. <b>Double-click</b> a wallet to expand its counterparties. Hover to highlight a wallet&apos;s neighbourhood.</p>}
            {sel?.kind === 'node' && selNode && (
              <div className="stack">
                <div className="row spread"><h3>Wallet</h3><Button sm variant="ghost" onClick={() => cy.current?.elements().unselect()}>Close</Button></div>
                <div className="row nw"><code className="break small">{selK!.addr}</code><CopyButton value={selK!.addr} label="Copy address" /></div>
                {selK!.chain !== chain && <div><Badge tone="outline">{chainName(selK!.chain)}</Badge></div>}
                {selNode.category && <div><CategoryChip category={selNode.category} name={selNode.label} /></div>}
                {selNode.swap && <Notice><b>Left {assetSym(selNode.swap.asset)} here → {selNode.swap.symbol}</b> ({money(selNode.swap.amount, selNode.swap.asset)}), <Link href={`/tx/${selK!.chain}/${selNode.swap.hash}`}>see the transaction</Link>. Funds continue as {selNode.swap.symbol}, outside this graph.</Notice>}
                {selNode.root && <Badge tone="medium">Start wallet</Badge>}
                {selNode.expanded && selNode.in !== undefined && <dl className="kv" style={{ gridTemplateColumns: '90px 1fr' }}><dt>Received</dt><dd>{money(selNode.in)}</dd><dt>Sent</dt><dd>{money(selNode.out)}</dd></dl>}
                <div className="stack sm">
                  <Button variant="primary" busy={!!busy} onClick={() => expand(selNode.id)}>Expand counterparties</Button>
                  {selNode.category === 'bridge' && <Button variant="primary" busy={!!busy} onClick={() => setHopFor(selNode.id)}><Waypoints size={14} />Find cross-chain continuation</Button>}
                  <Button busy={!!busy} onClick={() => checkSwaps(selNode.id)} title="Reads this wallet's newest outgoing transactions and looks for a stablecoin-to-native swap"><ArrowRightLeft size={14} />Check for swaps</Button>
                  <Link className="btn" href={addrHref(selK!.addr, selK!.chain, asset)} target="_blank">Wallet details</Link>
                  <Button onClick={() => router.replace(graphHref(selK!.addr, { chain: selK!.chain }))}>Start graph here</Button>
                  <Button onClick={() => { setPathTo(selK!.addr); setShowPath(true); }}><Route size={14} />Use as path destination</Button>
                  <Button disabled={!can('cases.manage')} onClick={() => setCaseAddr(selNode.id)}><Plus size={14} />Add to case</Button>
                  <a className="btn ghost" href={explorerAddr(selK!.chain, selK!.addr)} target="_blank" rel="noreferrer"><ExternalLink size={14} />Explorer</a>
                </div>
              </div>
            )}
            {sel?.kind === 'edge' && (
              <div className="stack">
                <div className="row spread"><h3>{sel.data.kind === 'tx' ? 'Transfer' : 'Flow'}</h3><Button sm variant="ghost" onClick={() => cy.current?.elements().unselect()}>Close</Button></div>
                <div className="small mono break"><Link href={addrHref(parseKey(sel.data.source, chain).addr, parseKey(sel.data.source, chain).chain)}>{short(parseKey(sel.data.source, chain).addr)}</Link> → <Link href={addrHref(parseKey(sel.data.target, chain).addr, parseKey(sel.data.target, chain).chain)}>{short(parseKey(sel.data.target, chain).addr)}</Link></div>
                <div style={{ fontSize: 22, fontWeight: 650 }}>{sel.data.kind === 'xchain' ? '≈ ' : ''}{money(sel.data.amount, sel.data.asset)}</div>
                {sel.data.kind === 'xchain' ? (() => {
                  const ev = edges.current.get(sel.data.parent)?.evidence;
                  if (!ev) return null;
                  const tgt = parseKey(sel.data.target, chain);
                  return (
                    <div className="stack sm" data-testid="xchain-evidence">
                      <Notice tone="warn">Cross-chain continuation (heuristic): a candidate matched on time, amount and bridge. It is not proof the funds are the same.</Notice>
                      <div><Badge tone={ev.level === 'high' ? 'good' : ev.level === 'medium' ? 'medium' : 'outline'}>Confidence {Math.round(ev.confidence * 100)}% · {ev.level}</Badge></div>
                      <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{ev.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                      <dl className="kv" style={{ gridTemplateColumns: '80px 1fr' }}>
                        <dt>Deposit</dt><dd><Link href={`/tx/${ev.sourceChain}/${ev.sourceHash}`} className="mono small">{short(ev.sourceHash)}</Link> ({chainName(ev.sourceChain)})</dd>
                        <dt>Payout</dt><dd><Link href={`/tx/${ev.chain}/${ev.hash}`} className="mono small">{short(ev.hash)}</Link> ({chainName(ev.chain)}) from {ev.bridgeName}</dd>
                      </dl>
                      <Button disabled={!can('cases.manage')} title={can('cases.manage') ? '' : 'Requires cases.manage'} onClick={() => setHopCase({ chain: tgt.chain, address: tgt.addr, note: hopNote(ev) })}><Plus size={14} />Save hop to case</Button>
                    </div>
                  );
                })() : sel.data.kind === 'tx' ? (
                  <dl className="kv" style={{ gridTemplateColumns: '60px 1fr' }}>
                    <dt>Time</dt><dd title={exact(sel.data.ts)}>{exact(sel.data.ts)}</dd>
                    <dt>Tx</dt><dd className="row nw"><Link href={`/tx/${sel.data.chain ?? chain}/${sel.data.hash}`} className="mono small break">{short(sel.data.hash)}</Link><CopyButton value={sel.data.hash} label="Copy hash" /></dd>
                  </dl>
                ) : (
                  <>
                    <span className="muted small">{sel.data.count} transfer{sel.data.count === 1 ? '' : 's'} in total</span>
                    {(edges.current.get(sel.data.parent)?.transfers ?? []).slice(0, 12).map((t, i) => (
                      <div key={i} className="row nw small" style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                        <span className="grow" title={exact(t.timestamp)}>{money(t.amount, t.asset ?? sel.data.asset)}<br /><span className="xs muted">{exact(t.timestamp)}</span></span>
                        <Link href={`/tx/${edges.current.get(sel.data.parent)?.chain ?? chain}/${t.hash}`} className="mono xs">{short(t.hash)}</Link>
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
      {caseAddr && <AddToCaseModal address={parseKey(caseAddr, chain).addr} chain={parseKey(caseAddr, chain).chain} onClose={() => setCaseAddr('')} />}
      {hopFor && (
        <HopModal
          node={nodes.current.get(hopFor)!} k={parseKey(hopFor, chain)}
          incoming={[...edges.current.values()].filter((e) => e.target === hopFor && !e.xchain).flatMap((e) => (e.transfers ?? []).map((t) => ({ ...t, asset: t.asset ?? e.asset ?? 'usdt' })))}
          canSave={can('cases.manage')} onSave={(h, src) => setHopCase({ chain: h.chain, address: h.to, note: hopNote(evidenceOf(h, src)) })}
          onAccept={(h, src) => { acceptHop(hopFor, h, src); setHopFor(''); }} onClose={() => setHopFor('')} />
      )}
      {hopCase && <SaveHopModal target={hopCase} onClose={() => setHopCase(null)} />}
    </div>
  );
}

const evidenceOf = (h: Hop, src: HopResult['source']): HopEvidence => ({ confidence: h.confidence, level: h.level, reasons: h.reasons, hash: h.hash, chain: h.chain, bridge: h.bridge, bridgeName: h.bridgeName, amountDelta: h.amountDelta, timeDeltaSec: h.timeDeltaSec, sourceChain: src.chain, sourceHash: src.hash, sourceAmount: src.amount, sourceBridge: src.bridgeName });

/** The case note that stores a hop's evidence (the case address row keeps its chain). */
const hopNote = (ev: HopEvidence) =>
  `Cross-chain hop, HEURISTIC candidate accepted by an analyst (not proven). Deposit: ${ev.sourceChain} tx ${ev.sourceHash}, ${ev.sourceAmount} into bridge "${ev.sourceBridge}". Payout: ${ev.chain} tx ${ev.hash} from "${ev.bridgeName}" (${ev.bridge}) to this address, ${ev.timeDeltaSec}s later, amount difference ${ev.amountDelta}. Confidence ${Math.round(ev.confidence * 100)}% (${ev.level}). Evidence: ${ev.reasons.join(' | ')}`.slice(0, 2000);

function HopModal({ node, k, incoming, canSave, onSave, onAccept, onClose }: {
  node: GNode; k: { chain: Chain; addr: string }; incoming: GTransfer[]; canSave: boolean;
  onSave: (h: Hop, src: HopResult['source']) => void; onAccept: (h: Hop, src: HopResult['source']) => void; onClose: () => void;
}) {
  const [hash, setHash] = useState(incoming[0]?.hash ?? '');
  const [windowMin, setWindowMin] = useState('60');
  const [tol, setTol] = useState('1');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<HopResult | null>(null);
  const hashes = [...new Map(incoming.map((t) => [t.hash, t])).values()];
  const run = async () => {
    setBusy(true); setErr(''); setRes(null);
    try {
      const q = new URLSearchParams({ chain: k.chain, hash: hash.trim(), to: k.addr, windowMin, tolerancePct: tol });
      if (target) q.set('target', target);
      setRes(await api<HopResult>(`/crosschain/hops?${q}`));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal wide title="Find cross-chain continuation" onClose={onClose} footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" busy={busy} disabled={!hash.trim()} onClick={run}>Search</Button></>}>
      <div className="stack" data-testid="hop-modal">
        <p className="muted small">Looks for payouts from wallets labelled <b>bridge</b> on the other chain(s) shortly after a deposit into <b>{node.label ?? short(k.addr)}</b>. Results are heuristic candidates ranked with their evidence; nothing is asserted.</p>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Field label="Deposit transaction" className="grow">
            {hashes.length ? (
              <Select value={hash} onChange={(e) => setHash(e.target.value)}>{hashes.map((t) => <option key={t.hash} value={t.hash}>{money(t.amount, t.asset)} · {exact(t.timestamp)} · {short(t.hash)}</option>)}</Select>
            ) : <Input className="mono" value={hash} onChange={(e) => setHash(e.target.value)} placeholder="Transaction hash of a deposit into this bridge wallet" />}
          </Field>
          <Field label="Time window (min)" hint="Default 60"><Input sm type="number" min="1" max="1440" value={windowMin} onChange={(e) => setWindowMin(e.target.value)} style={{ width: 90 }} /></Field>
          <Field label="Fee tolerance (%)" hint="Default 1"><Input sm type="number" min="0.01" max="10" step="0.1" value={tol} onChange={(e) => setTol(e.target.value)} style={{ width: 90 }} /></Field>
          <Field label="Other chain"><Select sm value={target} onChange={(e) => setTarget(e.target.value)}><option value="">All</option>{(['tron', 'eth', 'bsc'] as Chain[]).filter((c) => c !== k.chain).map((c) => <option key={c} value={c}>{chainName(c)}</option>)}</Select></Field>
        </div>
        {err && <Notice tone="error">{err}</Notice>}
        {res && (
          <div className="stack sm">
            <div className="small">Deposit: <b>{money(res.source.amount, res.source.asset)}</b> into {res.source.bridgeName} at {exact(res.source.timestamp)}</div>
            {res.sides.map((s) => (
              <Notice key={s.chain} tone={s.status === 'ok' ? undefined : 'warn'}>
                <b>{chainName(s.chain)}:</b>{' '}
                {s.status === 'ok' && `scanned ${s.bridges} bridge wallet${s.bridges > 1 ? 's' : ''}, ${s.scanned} transfers in the window${s.truncated ? ' (cap reached, some payouts may be missing)' : ''}.`}
                {s.status === 'no_bridge_labels' && 'no wallet is labelled "bridge" on this chain, so nothing could be searched. Add or import bridge labels on the Labels page.'}
                {s.status === 'error' && `the search failed: ${s.error}`}
              </Notice>
            ))}
            {res.candidates.length === 0 ? <p className="muted small" data-testid="hop-none">No candidates within {res.params.windowMin} min and {res.params.tolerancePct}% tolerance.</p> : (
              <div style={{ overflowX: 'auto' }}>
                <table className="tbl" data-testid="hop-candidates"><thead><tr><th>Confidence</th><th>Bridge pair</th><th>Recipient</th><th>Amount Δ</th><th>Time Δ</th><th /></tr></thead><tbody>
                  {res.candidates.map((h) => (
                    <tr key={h.hash + h.to}>
                      <td><Badge tone={h.level === 'high' ? 'good' : h.level === 'medium' ? 'medium' : 'outline'}>{Math.round(h.confidence * 100)}% · {h.level}</Badge></td>
                      <td className="small">{h.bridgePair.from} → {h.bridgePair.to}<ul className="xs muted" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{h.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></td>
                      <td className="mono small"><Link href={addrHref(h.to, h.chain)} target="_blank">{short(h.to)}</Link><br /><span className="xs muted">{chainName(h.chain)}</span></td>
                      <td className="num small">{money(h.amount, h.asset)}<br /><span className="xs muted">−{h.amountDelta} ({h.amountDeltaPct}%)</span></td>
                      <td className="small">{h.timeDeltaSec}s</td>
                      <td><div className="stack sm"><Button sm variant="primary" onClick={() => onAccept(h, res.source)}>Add to graph</Button><Button sm disabled={!canSave} title={canSave ? '' : 'Requires cases.manage'} onClick={() => onSave(h, res.source)}>Save to case</Button></div></td>
                    </tr>
                  ))}
                </tbody></table>
              </div>
            )}
            <p className="xs muted">{res.note}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Saves an accepted hop as a case address (with its chain) whose note holds the evidence. Needs cases.manage (the API enforces it). */
function SaveHopModal({ target, onClose }: { target: { chain: Chain; address: string; note: string }; onClose: () => void }) {
  const toast = useToast();
  const cases = useApi<{ id: number; title: string; status: string }[]>('/cases');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = (cases.data ?? []).filter((c) => c.status === 'open');
  useEffect(() => { if (cases.data && !id && open[0]) setId(String(open[0].id)); }, [cases.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Save hop to case" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!id} onClick={async () => {
      setBusy(true); setErr('');
      try { await api(`/cases/${id}/addresses`, { body: { chain: target.chain, address: target.address, role: 'intermediary', note: target.note } }); toast.success('Hop saved to case'); onClose(); }
      catch (e) { setErr((e as Error).message); setBusy(false); }
    }}>Save</Button></>}>
      <div className="stack" data-testid="save-hop">
        <p className="muted small">Adds <code className="break">{target.address}</code> ({chainName(target.chain)}) to the case as an intermediary. The note records that this is a heuristic candidate, with its evidence.</p>
        {cases.error && <Notice tone="warn">Could not load cases: {cases.error}</Notice>}
        {!cases.loading && !open.length && <Notice tone="warn">There is no open case. Create one on the Cases page first.</Notice>}
        <Field label="Case"><Select value={id} onChange={(e) => setId(e.target.value)}>{open.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</Select></Field>
        <Field label="Note (stored with the address)"><Textarea rows={5} readOnly value={target.note} /></Field>
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Modal>
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
