import { Flow, TransferRef } from './chains';

/** Counterparty flows for one address. Injected so graph logic is testable without the network. */
export type GetFlows = (addr: string) => Promise<Flow[]>;

export interface GraphNode {
  id: string;
  root?: boolean;
  expanded: boolean;
  in?: number; // totals within the fetched window, set once expanded
  out?: number;
  volume?: number; // only with ?transfers=true, see withVolumes
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  amount: number;
  count: number;
  transfers?: TransferRef[]; // only with ?transfers=true
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

class EdgeSet {
  readonly map = new Map<string, GraphEdge>();
  add(source: string, target: string, amount: number, count: number, transfers?: TransferRef[]) {
    const id = `${source}>${target}`;
    const e = this.map.get(id);
    // Same transfers can be seen from both ends with different fetch windows: keep the larger view.
    if (!e) this.map.set(id, { id, source, target, amount, count, ...(transfers ? { transfers } : {}) });
    else if (amount > e.amount) Object.assign(e, { amount, count, ...(transfers ? { transfers } : {}) });
  }
  get(source: string, target: string) {
    return this.map.get(`${source}>${target}`);
  }
}

/** BFS out from root: each expanded node contributes its top `fanout` counterparties by volume. */
export async function buildGraph(root: string, depth: number, fanout: number, getFlows: GetFlows): Promise<Graph> {
  const nodes = new Map<string, GraphNode>([[root, { id: root, root: true, expanded: false }]]);
  const edges = new EdgeSet();
  let frontier = [root];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    // One level's lookups run concurrently (the per-host throttle in chains.ts still spaces the calls).
    const level = await Promise.all(frontier.map((a) => getFlows(a)));
    for (const [i, a] of frontier.entries()) {
      const fl = level[i];
      const n = nodes.get(a)!;
      n.expanded = true;
      n.in = fl.reduce((s, f) => s + f.in, 0);
      n.out = fl.reduce((s, f) => s + f.out, 0);
      for (const f of fl.slice(0, fanout)) {
        if (!nodes.has(f.address)) {
          nodes.set(f.address, { id: f.address, expanded: false });
          next.push(f.address);
        }
        if (f.in > 0) edges.add(f.address, a, f.in, f.inCount, f.inTransfers);
        if (f.out > 0) edges.add(a, f.address, f.out, f.outCount, f.outTransfers);
      }
    }
    frontier = next;
  }
  return { nodes: [...nodes.values()], edges: [...edges.map.values()] };
}

export interface PathResult extends Graph {
  found: boolean;
  path: string[];
  expansions: number;
  limitReached: boolean;
}

/**
 * Directed money-flow path from -> to. Bidirectional BFS: forward follows outgoing
 * transfers from `from`, backward follows incoming transfers into `to`, always
 * expanding the smaller frontier. Each expansion is one API call, so it is capped.
 */
export async function findPath(
  from: string,
  to: string,
  maxHops: number,
  fanout: number,
  getFlows: GetFlows,
  maxExpansions = 60,
): Promise<PathResult> {
  const fwd = new Map<string, string | null>([[from, null]]);
  const bwd = new Map<string, string | null>([[to, null]]);
  const edges = new EdgeSet();
  let fFrontier = [from];
  let bFrontier = [to];
  let used = 0;

  const build = (meet: string): PathResult => {
    const path: string[] = [];
    for (let x: string | null | undefined = meet; x; x = fwd.get(x)) path.unshift(x);
    for (let x: string | null | undefined = bwd.get(meet); x; x = bwd.get(x)) path.push(x);
    const pathEdges = path.slice(1).map((t, i) => edges.get(path[i], t)!);
    return { found: true, path, nodes: path.map((id) => ({ id, expanded: false })), edges: pathEdges, expansions: used, limitReached: false };
  };

  for (let hop = 0; hop < maxHops; hop++) {
    const forward = fFrontier.length <= bFrontier.length;
    const mine = forward ? fwd : bwd;
    const other = forward ? bwd : fwd;
    const next: string[] = [];
    for (const a of forward ? fFrontier : bFrontier) {
      if (used >= maxExpansions) break;
      used++;
      const fl = (await getFlows(a))
        .filter((f) => (forward ? f.out : f.in) > 0)
        .sort((x, y) => (forward ? y.out - x.out : y.in - x.in))
        .slice(0, fanout);
      for (const f of fl) {
        if (forward) edges.add(a, f.address, f.out, f.outCount, f.outTransfers);
        else edges.add(f.address, a, f.in, f.inCount, f.inTransfers);
        if (mine.has(f.address)) continue;
        mine.set(f.address, a);
        if (other.has(f.address)) return build(f.address);
        next.push(f.address);
      }
    }
    if (forward) fFrontier = next;
    else bFrontier = next;
    if (!next.length) break; // one side is a dead end: no path exists within the explored fanout
  }
  return { found: false, path: [], nodes: [], edges: [], expansions: used, limitReached: used >= maxExpansions };
}

/**
 * Adds `volume` to every node: in+out within the fetched window for expanded nodes,
 * otherwise the sum of the amounts of the edges touching it.
 */
export function withVolumes<N extends GraphNode>(nodes: N[], edges: GraphEdge[]): N[] {
  const touching = new Map<string, number>();
  for (const e of edges) {
    touching.set(e.source, (touching.get(e.source) ?? 0) + e.amount);
    touching.set(e.target, (touching.get(e.target) ?? 0) + e.amount);
  }
  return nodes.map((n) => ({ ...n, volume: n.expanded && n.in !== undefined ? (n.in ?? 0) + (n.out ?? 0) : touching.get(n.id) ?? 0 }));
}
