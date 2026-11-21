import { detectChain, norm } from './chains';

export interface TimelineTransfer {
  hash: string;
  from: string;
  to: string;
  amount: number;
  asset: string;
  timestamp: number;
}

/**
 * Hop = distance (in transfers, ignoring direction) between the transfer and the starting wallet(s):
 * a transfer touching a source is hop 1, the next layer hop 2, and so on. null = not connected to any source.
 * Oldest transfer first.
 */
export function timelineHops(transfers: TimelineTransfer[], sources: string[]): (TimelineTransfer & { hop: number | null })[] {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => adj.set(a, (adj.get(a) ?? new Set()).add(b));
  for (const t of transfers) {
    link(t.from, t.to);
    link(t.to, t.from);
  }
  const dist = new Map<string, number>(sources.map((s) => [s, 0]));
  let frontier = sources;
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const a of frontier) {
      for (const b of adj.get(a) ?? []) {
        if (!dist.has(b)) dist.set(b, d), next.push(b);
      }
    }
    frontier = next;
  }
  return [...transfers]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((t) => {
      const f = dist.get(t.from);
      const g = dist.get(t.to);
      return { ...t, hop: f === undefined || g === undefined ? null : Math.max(f, g) };
    });
}

/** First victim, else first suspect, else the first address (case addresses in the order they were added). */
export function pickSources(addresses: { address: string; role: string }[]): string[] {
  const first = addresses.find((a) => a.role === 'victim') ?? addresses.find((a) => a.role === 'suspect') ?? addresses[0];
  return first ? [first.address] : [];
}

/** A saved graph may be stored as a JSON string (older saves); anything unreadable is treated as empty. */
const parsed = (json: unknown): unknown => {
  if (typeof json !== 'string') return json;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};
const graphParts = (json: unknown): { nodes: any[]; edges: any[]; chain?: string } => {
  const j: any = parsed(json);
  const root: any = j && typeof j === 'object' && 'elements' in j ? j.elements : j;
  if (Array.isArray(root)) return { nodes: root.filter((e) => e?.group !== 'edges' && !e?.data?.source), edges: root.filter((e) => e?.group === 'edges' || e?.data?.source), chain: j?.chain };
  return { nodes: Array.isArray(root?.nodes) ? root.nodes : [], edges: Array.isArray(root?.edges) ? root.edges : [], chain: root?.chain ?? j?.chain };
};

/** Counts and root of a saved graph (same rules as the SQL in the 9B case_graphs migration). */
export function graphStats(json: unknown): { nodes: number; edges: number; chain: string; root: string | null } {
  const g = graphParts(json);
  const root = g.nodes.find((n) => n?.data?.root === true || n?.data?.root === 'true')?.data?.id;
  return { nodes: g.nodes.length, edges: g.edges.length, chain: g.chain || 'tron', root: typeof root === 'string' ? root : null };
}

/** Wallet addresses in a saved Cytoscape graph (array of elements, or { nodes, edges } / { elements: {...} }). */
export function graphAddresses(json: unknown): string[] {
  const out = new Set<string>();
  for (const n of graphParts(json).nodes) {
    const id = n?.data?.id;
    if (typeof id === 'string' && detectChain(id)) out.add(norm(id));
  }
  return [...out];
}

/** Runs `fn` over `items` with at most `limit` in flight and a per-item timeout; returns what finished and a message for what did not. */
export async function boundedMap<T, R>(items: T[], limit: number, timeoutMs: number, deadline: number, fn: (x: T) => Promise<R>, label: (x: T) => string): Promise<{ done: R[]; warnings: string[] }> {
  const done: R[] = [];
  const warnings: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const x = items[next++];
      if (Date.now() > deadline) {
        warnings.push(`${label(x)}: skipped, the time budget for this request was used up`);
        continue;
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        done.push(await Promise.race([fn(x), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`took longer than ${Math.round(timeoutMs / 1000)} s, skipped`)), timeoutMs)))]));
      } catch (e) {
        warnings.push(`${label(x)}: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { done, warnings };
}
