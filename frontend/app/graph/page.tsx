'use client';
import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, Chain, compact, detectChain, explorerAddr, short, usdt } from '@/lib/format';

interface GNode {
  id: string;
  root?: boolean;
  expanded: boolean;
  in?: number;
  out?: number;
}
interface GEdge {
  id: string;
  source: string;
  target: string;
  amount: number;
  count: number;
}
interface GraphData {
  chain: Chain;
  nodes: GNode[];
  edges: GEdge[];
}
interface PathData extends GraphData {
  found: boolean;
  path: string[];
  expansions: number;
  limitReached: boolean;
}
type Selected = { kind: 'node'; data: GNode } | { kind: 'edge'; data: GEdge } | null;

// Cytoscape draws on canvas, so colours are fixed values chosen to read on light and dark backgrounds.
const STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'font-size': 9,
      color: '#8a93a3',
      'text-valign': 'bottom',
      'text-margin-y': 4,
      'background-color': '#9aa3b2',
      width: 18,
      height: 18,
    },
  },
  { selector: 'node[?expanded]', style: { 'background-color': '#3b82f6' } },
  { selector: 'node[?root]', style: { 'background-color': '#8b5cf6', width: 26, height: 26 } },
  { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#f59e0b' } },
  {
    selector: 'edge',
    style: {
      width: (e: cytoscape.EdgeSingular) => 1 + Math.min(8, Math.log10(1 + e.data('amount')) * 1.2),
      'line-color': '#b7beca',
      'target-arrow-color': '#b7beca',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 8,
      color: '#8a93a3',
      'text-rotation': 'autorotate',
    },
  },
  { selector: 'edge:selected', style: { 'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b' } },
  { selector: '.path', style: { 'line-color': '#f97316', 'target-arrow-color': '#f97316', 'border-width': 3, 'border-color': '#f97316' } },
];

function GraphWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const root = params.get('addr') ?? '';
  const chain = detectChain(root);

  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
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
  const [selected, setSelected] = useState<Selected>(null);

  const filterQs = useCallback(() => {
    const q = new URLSearchParams({ fanout });
    if (from) q.set('from', from);
    if (to) q.set('to', `${to}T23:59:59`);
    if (min) q.set('min', min);
    return q.toString();
  }, [fanout, from, to, min]);

  const merge = useCallback((g: GraphData) => {
    const c = cy.current!;
    const add: ElementDefinition[] = [];
    for (const n of g.nodes) {
      const existing = c.getElementById(n.id);
      if (existing.nonempty()) {
        if (n.expanded) existing.data({ expanded: true, in: n.in, out: n.out });
      } else {
        add.push({ group: 'nodes', data: { ...n, label: short(n.id) } });
      }
    }
    for (const e of g.edges) {
      if (c.getElementById(e.id).empty()) add.push({ group: 'edges', data: { ...e, label: compact(e.amount) } });
    }
    c.add(add);
    return add.length;
  }, []);

  // Rings around the start wallet: hop 1 on the first ring, hop 2 on the next, and so on.
  const relayout = () => {
    const c = cy.current;
    if (!c || c.elements().empty()) return;
    c.layout({ name: 'breadthfirst', roots: c.getElementById(root).nonempty() ? [root] : undefined, circle: true, spacingFactor: 1.1, directed: false, animate: false, padding: 30 }).run();
  };

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
    setInfo('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, []);

  const expand = useCallback(
    (id: string) =>
      run(`Expanding ${short(id)}…`, async () => {
        const g = await api<GraphData>(`/api/graph/${id}?depth=1&${filterQs()}`);
        const added = merge(g);
        cy.current!.getElementById(id).data('expanded', true);
        if (!added) setInfo('No new counterparties for this wallet with the current filters.');
        relayout();
      }),
    [filterQs, merge, run],
  );

  const loadRoot = useCallback(() => {
    if (!chain) return;
    return run('Loading graph…', async () => {
      const g = await api<GraphData>(`/api/graph/${root}?depth=${depth}&${filterQs()}`);
      cy.current!.elements().remove();
      merge(g);
      relayout();
      cy.current!.getElementById(root).select();
    });
  }, [chain, root, depth, filterQs, merge, run]);

  // Create Cytoscape once.
  useEffect(() => {
    const c = cytoscape({ container: box.current, style: STYLE, minZoom: 0.1, maxZoom: 2.5 });
    c.on('select', 'node', (e) => setSelected({ kind: 'node', data: e.target.data() }));
    c.on('select', 'edge', (e) => setSelected({ kind: 'edge', data: e.target.data() }));
    c.on('unselect', () => setSelected(null));
    cy.current = c;
    return () => c.destroy();
  }, []);

  // Double-click a node to expand it (re-bound when filters change so it uses current values).
  useEffect(() => {
    const c = cy.current!;
    const h = (e: cytoscape.EventObject) => expand(e.target.id());
    c.on('dbltap', 'node', h);
    return () => {
      c.off('dbltap', 'node', h);
    };
  }, [expand]);

  // Load when the root in the URL changes. Filters apply on "Load", not on every keystroke.
  useEffect(() => {
    setRootInput(root);
    loadRoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  function submitRoot(e: React.FormEvent) {
    e.preventDefault();
    const v = rootInput.trim();
    if (!detectChain(v)) return setError('Enter a valid Tron (T…) or Ethereum (0x…) address.');
    if (v === root) loadRoot();
    else router.replace(`/graph?addr=${v}`);
  }

  function findPath(e: React.FormEvent) {
    e.preventDefault();
    const target = pathTo.trim();
    if (!detectChain(target)) return setError('Enter a valid destination address.');
    run('Searching for a path (this can take a while)…', async () => {
      const p = await api<PathData>(`/api/path?from=${root}&to=${target}&maxHops=4&fanout=10`);
      cy.current!.elements().removeClass('path');
      if (!p.found) {
        setInfo(
          p.limitReached
            ? `No path found after checking ${p.expansions} wallets (search limit reached). The path may be longer or go through smaller transfers.`
            : `No path within 4 hops: money from this wallet does not reach ${short(target)} through its largest counterparties.`,
        );
        return;
      }
      merge(p);
      const c = cy.current!;
      p.path.forEach((id) => c.getElementById(id).addClass('path'));
      p.edges.forEach((ed) => c.getElementById(ed.id).addClass('path'));
      relayout();
      setInfo(`Path found: ${p.path.length - 1} hop${p.path.length > 2 ? 's' : ''}, highlighted in orange.`);
    });
  }

  return (
    <div className="graph-page">
      <form className="toolbar no-print" onSubmit={submitRoot}>
        <input className="grow mono" value={rootInput} onChange={(e) => setRootInput(e.target.value)} placeholder="Start address (T… or 0x…)" aria-label="Start address" spellCheck={false} />
        <label>Depth <select value={depth} onChange={(e) => setDepth(e.target.value)}>{['1', '2', '3'].map((d) => <option key={d}>{d}</option>)}</select></label>
        <label>Per wallet <select value={fanout} onChange={(e) => setFanout(e.target.value)}>{['5', '8', '10', '15'].map((d) => <option key={d}>{d}</option>)}</select></label>
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>Min USDT <input type="number" min="0" value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 90 }} /></label>
        <button type="submit" disabled={!!busy}>Load</button>
        <button type="button" className="secondary" onClick={relayout}>Re-layout</button>
      </form>

      {root && chain && (
        <form className="toolbar no-print" onSubmit={findPath}>
          <span className="muted small">Find path from start to</span>
          <input className="grow mono" value={pathTo} onChange={(e) => setPathTo(e.target.value)} placeholder="Destination address" aria-label="Destination address" spellCheck={false} />
          <button type="submit" disabled={!!busy}>Find path</button>
        </form>
      )}

      {busy && <p className="muted small">{busy}</p>}
      {error && <p className="bad small">{error}</p>}
      {info && <p className="note small">{info}</p>}

      <div className="graph-layout">
        <div className="graph-canvas card" ref={box}>
          {!root && <p className="muted overlay">Enter an address above to start tracing.</p>}
        </div>
        <aside className="card side">
          {!selected && (
            <p className="muted small">
              Click a wallet or flow for details. <b>Double-click</b> a wallet to expand its counterparties. Purple = start, blue = expanded, grey = not yet expanded.
            </p>
          )}
          {selected?.kind === 'node' && (
            <>
              <div className="muted small">Wallet</div>
              <div className="mono break">{selected.data.id}</div>
              {selected.data.expanded && selected.data.in !== undefined && (
                <p className="small">
                  Received {usdt(selected.data.in)}<br />Sent {usdt(selected.data.out ?? 0)}
                  <br /><span className="muted">(latest 200 transfers)</span>
                </p>
              )}
              <div className="stack">
                <button onClick={() => expand(selected.data.id)} disabled={!!busy}>Expand</button>
                <a className="button secondary" href={`/address/${selected.data.id}`} target="_blank">Wallet details</a>
                {chain && <a className="button secondary" href={explorerAddr(chain, selected.data.id)} target="_blank" rel="noreferrer">Explorer ↗</a>}
                <button className="secondary" onClick={() => router.replace(`/graph?addr=${selected.data.id}`)}>Start graph here</button>
              </div>
            </>
          )}
          {selected?.kind === 'edge' && (
            <>
              <div className="muted small">Flow</div>
              <p className="small mono">
                <a href={`/address/${selected.data.source}`}>{short(selected.data.source)}</a> → <a href={`/address/${selected.data.target}`}>{short(selected.data.target)}</a>
              </p>
              <p>{usdt(selected.data.amount)}<br /><span className="muted small">{selected.data.count} transfer{selected.data.count === 1 ? '' : 's'}</span></p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export default function GraphPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <GraphWorkspace />
    </Suspense>
  );
}
