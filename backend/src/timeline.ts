import { detectChain, norm } from './chains';

export interface TimelineTransfer {
  hash: string;
  from: string;
  to: string;
  amount: number;
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

/** Wallet addresses in a saved Cytoscape graph (array of elements, or { nodes, edges } / { elements: {...} }). */
export function graphAddresses(json: unknown): string[] {
  const root: any = json && typeof json === 'object' && 'elements' in (json as object) ? (json as any).elements : json;
  const nodes: any[] = Array.isArray(root) ? root.filter((e) => e?.group !== 'edges' && !e?.data?.source) : Array.isArray(root?.nodes) ? root.nodes : [];
  const out = new Set<string>();
  for (const n of nodes) {
    const id = n?.data?.id;
    if (typeof id === 'string' && detectChain(id)) out.add(norm(id));
  }
  return [...out];
}
