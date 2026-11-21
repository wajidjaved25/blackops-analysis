// Case analysis (Phase 8B), pure part: bounded onward trace, pattern rules, path extraction, aggregation. No network, no database: see selfcheck.ts.
// plan.md rules 4 and 5: every finding carries its evidence rows and the plain-English reason; nothing is inferred without saying it is an inference.
import { norm, Transfer } from './chains';
import { depositEvidence, exchangeName } from './cluster';
import type { LabelLite } from './labels';
import { WEIGHTS } from './risk-score';

export type Severity = 'high' | 'medium' | 'low' | 'info';
export interface Evidence {
  kind: 'tx' | 'wallet';
  chain?: string | null;
  hash?: string | null;
  ref?: string | null; // exchange reference of an off-chain row
  address?: string | null;
  amount?: number | null;
  at?: number | null;
  note?: string;
}
export interface Finding {
  type: string;
  severity: Severity;
  title: string;
  statement: string;
  evidence: Evidence[]; // capped at MAX_EVIDENCE
  evidenceTotal: number;
}
export const MAX_EVIDENCE = 25;
const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low', 'info'];
export const bySeverity = (a: Finding, b: Finding) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);

/** One statement / pasted-hash row, reduced to what the rules need. */
export interface Row {
  id: number;
  chain: string | null;
  hash: string | null;
  ref: string | null;
  address: string | null;
  coin: string;
  amount: number;
  at: number | null; // ms
  offChain: boolean;
  status: string;
}

export interface Params {
  hops: number;
  fanout: number; // onward wallets followed per wallet
  maxWallets: number; // onward wallets discovered in total
  budgetSec: number;
  thresholds: number[];
  thresholdPct: number; // "just under": within this % below a threshold
  repeatMin: number;
  consolidationMin: number;
  passShare: number; // 0..1
  passHours: number;
  nightFrom: number; // local hour, inclusive
  nightTo: number; // exclusive
  nightShare: number;
  nightMin: number;
  tzMin: number; // minutes east of UTC used for "local" hours
  busyTransfers: number; // a wallet whose first fetched page already holds this many transfers is service-scale: reported as an endpoint, not traced further
}
export const MAX_SEEDS = 30; // recipient wallets traced (largest by volume first)
export const DEFAULT_PARAMS: Params = {
  hops: 2, fanout: 5, maxWallets: 60, budgetSec: 180, thresholds: [10_000, 15_000, 50_000, 100_000], thresholdPct: 0.1,
  repeatMin: 3, consolidationMin: 3, passShare: 0.9, passHours: 24, nightFrom: 0, nightTo: 6, nightShare: 0.4, nightMin: 5, tzMin: 0, busyTransfers: 200,
};
export const LIMITS = { hops: [1, 3], fanout: [1, 10], maxWallets: [10, 150], budgetSec: [30, 600] } as const;

const usd = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const cap = (e: Evidence[]) => e.slice(0, MAX_EVIDENCE);
const mk = (type: string, severity: Severity, title: string, statement: string, evidence: Evidence[]): Finding => ({ type, severity, title, statement, evidence: cap(evidence), evidenceTotal: evidence.length });
const rowEv = (r: Row): Evidence => ({ kind: 'tx', chain: r.chain, hash: r.hash, ref: r.ref, address: r.address, amount: r.amount, at: r.at });

// ---------------- statement-row patterns ----------------

/** Same amount (and coin) three or more times. Most frequent first, at most 5 findings. */
export function repeatedAmounts(rows: Row[], min: number): Finding[] {
  const g = new Map<string, Row[]>();
  for (const r of rows) if (r.amount > 0) g.set(`${r.coin}|${r.amount.toFixed(6)}`, [...(g.get(`${r.coin}|${r.amount.toFixed(6)}`) ?? []), r]);
  return [...g.values()]
    .filter((l) => l.length >= min)
    .sort((a, b) => b.length - a.length || b[0].amount - a[0].amount)
    .slice(0, 5)
    .map((l) => mk('repeated_amount', l.length >= 6 ? 'medium' : 'low', `${l.length} identical amounts of ${usd(l[0].amount)} ${l[0].coin}`,
      `${l.length} transactions have exactly the same amount, ${usd(l[0].amount)} ${l[0].coin} (total ${usd(l.length * l[0].amount)}). Identical repeated amounts can indicate scripted or structured payments; they are not proof of wrongdoing on their own.`, l.map(rowEv)));
}

/** Amounts within `pct`% below a round threshold (e.g. 9,995 for 10,000): possible structuring below a limit. At least 2 per threshold. */
export function nearThreshold(rows: Row[], thresholds: number[], pct: number): Finding[] {
  const out: Finding[] = [];
  for (const t of thresholds) {
    const lo = t * (1 - pct / 100) - 1e-9;
    const l = rows.filter((r) => r.amount >= lo && r.amount < t);
    if (l.length >= 2) {
      out.push(mk('near_threshold', 'medium', `${l.length} amounts just under ${usd(t)}`,
        `${l.length} transactions are within ${pct}% below ${usd(t)} (between ${usd(lo)} and ${usd(t)}). Amounts that stop just short of a round limit are a known structuring pattern; the limit itself is only a guess about what the sender wanted to stay under.`, l.map(rowEv)));
    }
  }
  return out;
}

/** Transactions in the night window (local hours, `tzMin` east of UTC). Needs enough dated rows and a high enough share. */
export function unusualHours(rows: Row[], p: Pick<Params, 'nightFrom' | 'nightTo' | 'nightShare' | 'nightMin' | 'tzMin'>): Finding[] {
  const dated = rows.filter((r) => r.at !== null);
  const hourOf = (ms: number) => Math.floor((((ms / 60_000 + p.tzMin) / 60) % 24 + 24) % 24);
  const night = (h: number) => (p.nightFrom <= p.nightTo ? h >= p.nightFrom && h < p.nightTo : h >= p.nightFrom || h < p.nightTo);
  const l = dated.filter((r) => night(hourOf(r.at!)));
  if (l.length < p.nightMin || l.length / dated.length < p.nightShare) return [];
  const sign = p.tzMin >= 0 ? '+' : '-';
  const tz = `UTC${sign}${Math.floor(Math.abs(p.tzMin) / 60)}${Math.abs(p.tzMin) % 60 ? ':' + String(Math.abs(p.tzMin) % 60).padStart(2, '0') : ''}`;
  return [mk('unusual_hours', 'low', `${l.length} of ${dated.length} transactions between ${String(p.nightFrom).padStart(2, '0')}:00 and ${String(p.nightTo).padStart(2, '0')}:00`,
    `${Math.round((l.length / dated.length) * 100)}% of the dated transactions happened in the night window ${p.nightFrom}:00 to ${p.nightTo}:00 (${tz}). An even spread over the day would put about ${Math.round(((((p.nightTo - p.nightFrom) + 24) % 24) / 24) * 100)}% there. Night-time activity can point to a different time zone or automation; time zone assumptions matter.`, l.map(rowEv))];
}

/** Off-chain statement rows are transfers to another customer of the same exchange: they cannot be traced on-chain. */
export function internalTransfers(rows: Row[]): Finding[] {
  const l = rows.filter((r) => r.offChain);
  if (!l.length) return [];
  const total = l.reduce((s, r) => s + r.amount, 0);
  return [mk('internal_transfer', 'info', `${l.length} internal exchange transfer${l.length === 1 ? '' : 's'} (${usd(total)})`,
    `${l.length} statement row${l.length === 1 ? ' is an' : 's are'} "off-chain transfer" (${usd(total)} in total): the counterparty is another customer of the same exchange, so there is nothing on the blockchain to trace. These amounts count in the statement totals but not in the on-chain analysis. The exchange can identify the receiving account: request those records through legal process.`, l.map(rowEv))];
}

// ---------------- onward trace ----------------

export type Stop = 'exchange' | 'exchange_deposit' | 'service' | 'bridge' | 'dex' | 'risk' | 'deposit' | 'busy';
export const BUSY_REASON = 'high-activity wallet (likely exchange/service) — not traced further';
export interface Via {
  amount: number;
  count: number;
  hash: string | null; // earliest transfer on this hop
  first: number;
  last: number;
}
export interface TraceNode {
  key: string; // chain|address
  chain: string;
  address: string;
  hop: number;
  parent: string | null;
  via: Via | null;
  after: number; // only transfers at or after this time are followed (funds cannot leave before they arrive)
  labels: LabelLite[];
  stop: Stop | null;
  stopReason?: string; // why the trace ends here, shown to the investigator
  deposit: { exchange: string; hot: string; depositors: number; share: number } | null; // inferred deposit address (heuristic)
  expanded: boolean;
  omitted: number; // counterparties not followed because of the fan-out cap
  error?: string;
}
export interface TraceEdge {
  from: string;
  to: string;
  via: Via;
}
export interface TraceStats {
  walletsTotal: number; // seeds + onward wallets discovered
  walletsTraced: number; // wallets whose transfer history was read
  failed: number;
  notFollowed: number; // discovered, not a stop, not traced (hop limit, wallet cap or time)
  hopLimit: boolean; // wallets sit at the last hop and were not expanded
  fanoutCut: number; // wallets with more counterparties than the fan-out cap
  walletCap: boolean; // new wallets were dropped because of the wallet cap
  timedOut: boolean;
}
export interface TraceDeps {
  transfers(chain: string, address: string, seed: boolean): Promise<Transfer[]>;
  labels(chain: string, addresses: string[]): Promise<Map<string, LabelLite[]>>;
  /** Addresses (subset of the input) that are service-scale: the index holds more transfers than it keeps (IndexedAddress status `capped`). Never fetched or backfilled. */
  capped?(chain: string, addresses: string[]): Promise<Set<string>>;
  now?: () => number;
  onProgress?: (traced: number) => Promise<unknown> | void;
}
export interface TraceResult {
  nodes: Map<string, TraceNode>;
  edges: TraceEdge[];
  histories: Map<string, Transfer[]>;
  stats: TraceStats;
}

export const nodeKey = (chain: string, address: string) => `${chain}|${norm(address)}`;
const CONCURRENCY = 4;

/** What a label means for following the money: exchanges/services/bridges/dex end the trace; anything with a risk weight ends it too and is reported. 'other' (weight 20) does not. */
/** 9C: a case suspect/seed that is a customer account at an exchange is still traced as a seed (the trace starts there); only onward wallets end at it. */
const seedStop = (hop: number, s: Stop | null): Stop | null => (hop === 0 && s === 'exchange_deposit' ? null : s);
export const customerStopReason = (labels: LabelLite[]) => {
  const l = labels.find((x) => x.category === 'exchange_deposit');
  const ex = l ? exchangeName(l.name) : 'the exchange';
  return `funds entered a ${ex} customer account — request account holder records from ${ex}`;
};
export function stopOf(labels: LabelLite[]): Stop | null {
  if (labels.some((l) => (WEIGHTS[l.category] ?? 0) >= 40 || l.category === 'frozen')) return 'risk';
  for (const c of ['exchange', 'exchange_deposit', 'service', 'bridge', 'dex'] as const) if (labels.some((l) => l.category === c)) return c;
  return null;
}

/**
 * Follow outgoing transfers from each seed wallet, breadth first, within hard bounds (hops, fan-out per wallet, total wallets, time).
 * Only transfers made after the funds arrived are followed. Stops at labelled endpoints; an unlabelled wallet that forwards >= 90% of its outflow
 * to a labelled exchange wallet and was paid by >= 3 distinct senders is marked as an inferred deposit address (cluster.ts).
 */
export async function trace(seeds: { chain: string; address: string; after: number }[], p: Pick<Params, 'hops' | 'fanout' | 'maxWallets' | 'budgetSec' | 'busyTransfers'>, deps: TraceDeps): Promise<TraceResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + p.budgetSec * 1000;
  const nodes = new Map<string, TraceNode>();
  const edges: TraceEdge[] = [];
  const histories = new Map<string, Transfer[]>();
  const stats: TraceStats = { walletsTotal: 0, walletsTraced: 0, failed: 0, notFollowed: 0, hopLimit: false, fanoutCut: 0, walletCap: false, timedOut: false };
  const fresh = (chain: string, address: string, hop: number, parent: string | null, via: Via | null, after: number, labels: LabelLite[]): TraceNode => ({
    key: nodeKey(chain, address), chain, address: norm(address), hop, parent, via, after, labels, stop: seedStop(hop, stopOf(labels)), deposit: null, expanded: false, omitted: 0,
  });
  const markBusy = async (chain: string, list: TraceNode[]) => {
    const open = list.filter((x) => !x.stop);
    const capped = open.length && deps.capped ? await deps.capped(chain, open.map((x) => x.address)) : new Set<string>();
    for (const x of open) if (capped.has(norm(x.address))) Object.assign(x, { stop: 'busy', stopReason: BUSY_REASON });
  };
  const withReason = (x: TraceNode) => {
    if (x.stop && !x.stopReason) x.stopReason = x.stop === 'risk' ? 'labelled high-risk wallet' : x.stop === 'exchange_deposit' ? customerStopReason(x.labels) : `labelled ${x.stop} wallet: endpoint, not traced further`;
    return x;
  };
  for (const chain of new Set(seeds.map((s) => s.chain))) {
    const labels = await deps.labels(chain, seeds.filter((s) => s.chain === chain).map((s) => s.address));
    for (const s of seeds.filter((x) => x.chain === chain)) if (!nodes.has(nodeKey(chain, s.address))) nodes.set(nodeKey(chain, s.address), fresh(chain, s.address, 0, null, null, s.after, labels.get(norm(s.address)) ?? []));
    await markBusy(chain, [...nodes.values()].filter((x) => x.chain === chain));
  }
  for (const x of nodes.values()) withReason(x);
  const seedCount = nodes.size;

  const expand = async (n: TraceNode) => {
    let trs: Transfer[];
    try {
      trs = await deps.transfers(n.chain, n.address, n.hop === 0);
    } catch (e) {
      n.error = (e as Error).message.slice(0, 200);
      stats.failed++;
      return;
    }
    n.expanded = true;
    stats.walletsTraced++;
    histories.set(n.key, trs);
    if (trs.length >= p.busyTransfers) {
      Object.assign(n, { stop: 'busy', stopReason: BUSY_REASON }); // read, but not followed
      return;
    }
    const agg = new Map<string, Via>();
    for (const t of trs) {
      if (norm(t.from) !== n.address || norm(t.to) === n.address || t.timestamp < n.after) continue;
      const v = agg.get(norm(t.to));
      if (!v) agg.set(norm(t.to), { amount: t.amount, count: 1, hash: t.hash, first: t.timestamp, last: t.timestamp });
      else {
        v.amount += t.amount;
        v.count++;
        if (t.timestamp < v.first) Object.assign(v, { first: t.timestamp, hash: t.hash });
        v.last = Math.max(v.last, t.timestamp);
      }
    }
    const ranked = [...agg].sort((a, b) => b[1].amount - a[1].amount);
    const kept = ranked.slice(0, p.fanout);
    n.omitted = ranked.length - kept.length;
    if (n.omitted) stats.fanoutCut++;
    const labels = kept.length ? await deps.labels(n.chain, kept.map(([a]) => a)) : new Map<string, LabelLite[]>();
    const newNodes: TraceNode[] = [];
    for (const [addr, via] of kept) {
      const k = nodeKey(n.chain, addr);
      if (!nodes.has(k)) {
        if (nodes.size - seedCount >= p.maxWallets) {
          stats.walletCap = true;
          continue;
        }
        nodes.set(k, fresh(n.chain, addr, n.hop + 1, n.key, via, via.first, labels.get(addr) ?? []));
        newNodes.push(nodes.get(k)!);
      }
      edges.push({ from: n.key, to: k, via });
    }
    await markBusy(n.chain, newNodes);
    newNodes.forEach(withReason);
    if (!n.stop) {
      for (const [addr] of kept) {
        const hot = (labels.get(addr) ?? []).find((l) => l.category === 'exchange' && l.source !== 'cluster');
        const ev = hot && depositEvidence(n.address, trs, addr);
        if (hot && ev) {
          n.deposit = { exchange: hot.name, hot: addr, depositors: ev.depositors, share: ev.outToHot / ev.totalOut };
          n.stop = 'deposit';
          break;
        }
      }
    }
  };

  for (let hop = 0; hop < p.hops && !stats.timedOut; hop++) {
    const level = [...nodes.values()].filter((n) => n.hop === hop && !n.stop && !n.expanded);
    for (let i = 0; i < level.length; i += CONCURRENCY) {
      if (now() > deadline) {
        stats.timedOut = true;
        break;
      }
      await Promise.all(level.slice(i, i + CONCURRENCY).map(expand));
      await deps.onProgress?.(stats.walletsTraced);
    }
  }
  const open = [...nodes.values()].filter((n) => !n.stop && !n.expanded && !n.error);
  stats.notFollowed = open.length;
  stats.hopLimit = open.some((n) => n.hop >= p.hops);
  stats.walletsTotal = nodes.size;
  return { nodes, edges, histories, stats };
}

export interface PathStep {
  key: string;
  chain: string;
  address: string;
  hop: number;
  via: Via | null; // the hop that brought funds here
  labels: LabelLite[];
  deposit: TraceNode['deposit'];
}
/** Seed -> ... -> node, following the first-discovery parents. */
export function pathTo(nodes: Map<string, TraceNode>, key: string): PathStep[] {
  const out: PathStep[] = [];
  const seen = new Set<string>();
  for (let n = nodes.get(key); n && !seen.has(n.key); n = n.parent ? nodes.get(n.parent) : undefined) {
    seen.add(n.key);
    out.unshift({ key: n.key, chain: n.chain, address: n.address, hop: n.hop, via: n.via, labels: n.labels, deposit: n.deposit });
  }
  return out;
}

const shortA = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const best = (labels: LabelLite[]) => [...labels].sort((a, b) => (WEIGHTS[b.category] ?? 0) - (WEIGHTS[a.category] ?? 0))[0];
const stepText = (s: PathStep) => (s.deposit ? `${shortA(s.address)} (inferred ${s.deposit.exchange} deposit address)` : s.labels.length ? `${shortA(s.address)} (${best(s.labels).name})` : shortA(s.address));
export const pathText = (p: PathStep[]) => p.map(stepText).join(' → ');
/** Evidence for a path: every wallet on it, and the first transaction of every hop. */
export function pathEvidence(p: PathStep[]): Evidence[] {
  const ev: Evidence[] = [];
  for (const [i, s] of p.entries()) {
    const l = s.labels.length ? best(s.labels) : null;
    ev.push({ kind: 'wallet', chain: s.chain, address: s.address, note: i === 0 ? 'recipient wallet from the statement' : [l ? `${l.category}: ${l.name} (label source: ${l.source})` : '', s.deposit ? `inferred deposit address of ${s.deposit.exchange}: ${Math.round(s.deposit.share * 100)}% of its outflow goes to the labelled hot wallet, ${s.deposit.depositors} distinct depositors (heuristic)` : ''].filter(Boolean).join('; ') || `hop ${s.hop}` });
    if (s.via?.hash) ev.push({ kind: 'tx', chain: s.chain, hash: s.via.hash, address: s.address, amount: s.via.amount, at: s.via.first, note: `hop ${s.hop}: ${s.via.count} transfer${s.via.count === 1 ? '' : 's'}, ${usd(s.via.amount)} in total (first one shown)` });
  }
  return ev;
}

/** Wallets reached by the trace that carry a risk label (sanctioned, frozen, scam, mixer, ...), with the path from the recipient. */
export function exposureFindings(nodes: Map<string, TraceNode>): Finding[] {
  const out: Finding[] = [];
  for (const n of nodes.values()) {
    if (n.stop !== 'risk') continue;
    const p = pathTo(nodes, n.key);
    const l = best(n.labels);
    const hops = p.length - 1;
    out.push(mk('risk_exposure', 'high', `${hops === 0 ? 'Recipient is a' : 'Funds reached a'} ${l.category} wallet`,
      hops === 0
        ? `Recipient wallet ${n.address} is labelled ${l.category}: ${l.name} (label source: ${l.source}).`
        : `Funds from recipient ${p[0].address} reached ${n.address}, labelled ${l.category}: ${l.name} (label source: ${l.source}), ${hops} hop${hops === 1 ? '' : 's'} later: ${pathText(p)}. The amount shown on the last hop is everything that wallet sent onward, not necessarily case funds only.`, pathEvidence(p)));
  }
  return out;
}

/**
 * Funds that reached a labelled exchange (its OWN wallet) or a customer account at one (deposit address): who to send legal process to.
 * One finding per exchange and kind; the wording never calls a customer deposit address "the exchange".
 */
export function exchangeFindings(nodes: Map<string, TraceNode>): Finding[] {
  const by = new Map<string, { name: string; customer: boolean; ends: TraceNode[] }>();
  for (const n of nodes.values()) {
    const customer = n.stop === 'exchange_deposit';
    const l = n.labels.find((x) => x.category === (customer ? 'exchange_deposit' : 'exchange'));
    if ((n.stop !== 'exchange' && !customer) || !l || (customer && n.hop === 0)) continue; // a deposit node continues to its hot wallet, which is the endpoint
    const name = exchangeName(l.name);
    const k = `${customer ? 'c' : 'e'}|${customer ? name : l.name}`;
    const e = by.get(k) ?? { name: customer ? name : l.name, customer, ends: [] };
    by.set(k, { ...e, ends: [...e.ends, n] });
  }
  return [...by.values()].map((e) => {
    const paths = e.ends.map((n) => pathTo(nodes, n.key));
    const inferred = paths.some((p) => p.some((s) => s.deposit));
    const clustered = e.ends.some((n) => n.labels.some((l) => l.source === 'cluster'));
    const direct = paths.filter((p) => p.length === 1).length; // the statement itself pays a wallet labelled as this exchange
    const total = paths.reduce((s, p) => s + (p[p.length - 1].via?.amount ?? 0), 0);
    const first = pathText(paths.find((p) => p.length > 1) ?? paths[0]);
    const many = paths.length === 1 ? 'this deposit' : 'these deposits';
    const flag = `${inferred ? '. Part of this relies on an inferred deposit address (heuristic): confirm it with the exchange' : ''}${clustered ? '. A deposit address came from an accepted cluster suggestion (heuristic, confidence set by a reviewer)' : ''}.`;
    if (e.customer)
      return mk('exchange_customer_endpoint', 'medium', `Funds reached a ${e.name} customer account (deposit address)`,
        `${paths.length} path${paths.length === 1 ? '' : 's'} from the case recipients end at a deposit address of a ${e.name} customer${total > 0 ? `; ${usd(total)} USD-equivalent was sent there by the previous wallet on the onward paths (not necessarily case funds only)` : ''}. This is a customer account at ${e.name}, not a ${e.name} wallet. Example: ${first}. Who to contact: ${e.name} holds the account holder's identity records behind ${many}; request account holder records (KYC) from ${e.name} through legal process${flag}`,
        paths.flatMap((p) => pathEvidence(p)));
    return mk('exchange_endpoint', 'medium', `Funds reached ${e.name} (exchange wallet)`,
      `${paths.length} path${paths.length === 1 ? '' : 's'} from the case recipients end at ${e.name}, an exchange-owned wallet${direct ? ` (${direct} of them: the statement pays a wallet labelled ${e.name} directly)` : ''}${total > 0 ? `; ${usd(total)} USD-equivalent was sent to the exchange wallet by the previous wallet on the onward paths (not necessarily case funds only)` : ''}. Example: ${first}. Who to contact: ${e.name} holds the account behind ${many}; send legal process or a records request to ${e.name}${flag}`,
      paths.flatMap((p) => pathEvidence(p)));
  });
}

/** Unlabelled wallets that look service-scale (capped index or a full first page): shown as endpoints, never traced further, never inferred to be a specific exchange. */
export function busyFindings(nodes: Map<string, TraceNode>): Finding[] {
  const l = [...nodes.values()].filter((n) => n.stop === 'busy' && n.hop > 0);
  if (!l.length) return [];
  const paths = l.slice(0, 10).map((n) => pathTo(nodes, n.key));
  return [mk('busy_endpoint', 'info', `${l.length} high-activity wallet${l.length === 1 ? '' : 's'} reached`,
    `Funds reached ${l.length} unlabelled wallet${l.length === 1 ? '' : 's'} with so much activity that they are probably an exchange or service (${BUSY_REASON}). No exchange is named because none is labelled: identify the operator (for example from the address page or public sources) before sending legal process. Example: ${pathText(paths[0])}.`, paths.flatMap(pathEvidence))];
}

/** Many wallets paying one wallet: group the trace edges by target. Seeds' own transfers into a stop wallet (exchange) are not reported here. */
export function consolidations(edges: TraceEdge[], nodes: Map<string, TraceNode>, minSources: number): Finding[] {
  const by = new Map<string, TraceEdge[]>();
  for (const e of edges) by.set(e.to, [...(by.get(e.to) ?? []), e]);
  const out: Finding[] = [];
  for (const [to, list] of by) {
    const target = nodes.get(to)!;
    const sources = [...new Set(list.map((e) => e.from))];
    if (sources.length < minSources || target.hop === 0) continue;
    const total = list.reduce((s, e) => s + e.via.amount, 0);
    const label = target.labels.length ? ` (${best(target.labels).name})` : '';
    out.push(mk('consolidation', 'medium', `${sources.length} wallets consolidate into one`,
      `${sources.length} different wallets traced from the case recipients all send funds to ${target.address}${label}: ${usd(total)} USD-equivalent in total. Many sources converging on one wallet can indicate collection of funds; for exchange and service wallets it is normal.`,
      [{ kind: 'wallet', chain: target.chain, address: target.address, note: 'receiving wallet' }, ...list.map((e): Evidence => ({ kind: 'tx', chain: target.chain, hash: e.via.hash, address: nodes.get(e.from)!.address, amount: e.via.amount, at: e.via.first, note: `from ${shortA(nodes.get(e.from)!.address)}: ${e.via.count} transfer(s)` }))]));
  }
  return out.sort((a, b) => b.evidenceTotal - a.evidenceTotal).slice(0, 10);
}

// ---------------- pass-through ----------------
export interface PassEvent {
  inHash: string;
  inAmount: number;
  inAt: number;
  forwarded: number;
  lastOutAt: number;
  outHashes: string[];
}
/** Received funds that left again, at least `share` of the amount within `hours`. Each outgoing transfer is used by one inflow only. */
export function passThrough(addr: string, transfers: Transfer[], share: number, hours: number): PassEvent[] {
  const me = norm(addr);
  const sorted = [...transfers].sort((a, b) => a.timestamp - b.timestamp);
  const ins = sorted.filter((t) => norm(t.to) === me && norm(t.from) !== me);
  const outs = sorted.filter((t) => norm(t.from) === me && norm(t.to) !== me);
  const used = new Set<number>();
  const events: PassEvent[] = [];
  for (const i of ins) {
    let sum = 0;
    const take: number[] = [];
    outs.forEach((o, idx) => {
      if (used.has(idx) || sum >= i.amount || o.timestamp < i.timestamp || o.timestamp - i.timestamp > hours * 3_600_000) return;
      sum += o.amount;
      take.push(idx);
    });
    if (sum >= i.amount * share) {
      take.forEach((x) => used.add(x));
      events.push({ inHash: i.hash, inAmount: i.amount, inAt: i.timestamp, forwarded: sum, lastOutAt: outs[take[take.length - 1]].timestamp, outHashes: take.map((x) => outs[x].hash) });
    }
  }
  return events;
}

/** Pass-through findings for the wallets whose history was read; exchanges, services, bridges, dex and risk wallets are skipped (that is what they do). */
export function passThroughFindings(res: TraceResult, share: number, hours: number): Finding[] {
  const out: Finding[] = [];
  for (const n of res.nodes.values()) {
    const trs = res.histories.get(n.key);
    if (!trs || (n.stop && n.stop !== 'deposit')) continue;
    const ev = passThrough(n.address, trs, share, hours);
    if (!ev.length) continue;
    const moved = ev.reduce((s, e) => s + e.inAmount, 0);
    const mins = Math.round(Math.max(...ev.map((e) => e.lastOutAt - e.inAt)) / 60_000);
    out.push(mk('pass_through', ev.length >= 3 ? 'medium' : 'low', `Pass-through wallet${n.hop === 0 ? ' (recipient)' : ''}`,
      `${n.address} received ${ev.length} payment${ev.length === 1 ? '' : 's'} (${usd(moved)} USD-equivalent) and sent at least ${Math.round(share * 100)}% of each onward within ${hours} h (slowest: ${mins} min). Wallets that only relay funds are typical of layering, but also of payment processors and deposit addresses.`,
      ev.flatMap((e): Evidence[] => [
        { kind: 'tx', chain: n.chain, hash: e.inHash, address: n.address, amount: e.inAmount, at: e.inAt, note: 'received' },
        ...e.outHashes.slice(0, 3).map((h): Evidence => ({ kind: 'tx', chain: n.chain, hash: h, address: n.address, at: e.lastOutAt, note: 'sent onward' })),
      ])));
  }
  return out.sort((a, b) => b.evidenceTotal - a.evidenceTotal).slice(0, 10);
}

// ---------------- aggregation ----------------
export interface WalletRow {
  chain: string;
  address: string;
  total: number;
  verified: number;
  count: number;
  first: number | null;
  last: number | null;
  share: number;
}
/** Recipient wallets from the on-chain rows, biggest first. */
export function walletTable(rows: Row[]): WalletRow[] {
  const m = new Map<string, WalletRow>();
  const grand = rows.reduce((s, r) => s + r.amount, 0);
  for (const r of rows) {
    if (r.offChain || !r.chain || !r.address) continue;
    const k = nodeKey(r.chain, r.address);
    const w = m.get(k) ?? { chain: r.chain, address: norm(r.address), total: 0, verified: 0, count: 0, first: null, last: null, share: 0 };
    w.total += r.amount;
    if (r.status === 'verified') w.verified += r.amount;
    w.count++;
    if (r.at !== null) {
      w.first = w.first === null ? r.at : Math.min(w.first, r.at);
      w.last = w.last === null ? r.at : Math.max(w.last, r.at);
    }
    m.set(k, w);
  }
  return [...m.values()].map((w) => ({ ...w, share: grand ? w.total / grand : 0 })).sort((a, b) => b.total - a.total);
}

export function totals(rows: Row[]) {
  const sum = (f: (r: Row) => boolean) => rows.filter(f).reduce((s, r) => s + r.amount, 0);
  const byStatus: Record<string, { count: number; amount: number }> = {};
  for (const r of rows) byStatus[r.status] = { count: (byStatus[r.status]?.count ?? 0) + 1, amount: (byStatus[r.status]?.amount ?? 0) + r.amount };
  return { rows: rows.length, claimed: sum(() => true), verified: sum((r) => r.status === 'verified'), offChain: { count: rows.filter((r) => r.offChain).length, amount: sum((r) => r.offChain) }, byStatus };
}

export interface ChartNode { id: string; label: string; kind: 'source' | 'offchain' | 'recipient' | 'onward' | 'busy' | 'exchange' | 'exchange_deposit' | 'risk' | 'deposit' | 'bridge' | 'dex' | 'service'; chain?: string; address?: string; category?: string; hop?: number }
export interface ChartEdge { id: string; source: string; target: string; amount: number; count: number }
/** Link chart: statement -> recipients -> onward hops -> endpoints. Node count is bounded by MAX_SEEDS + maxWallets + 2. */
export function linkChart(wallets: WalletRow[], res: TraceResult, offChain: { count: number; amount: number }): { nodes: ChartNode[]; edges: ChartEdge[] } {
  const nodes: ChartNode[] = [{ id: 'statement', label: 'Statement', kind: 'source' }];
  const edges: ChartEdge[] = [];
  if (offChain.count) {
    nodes.push({ id: 'offchain', label: 'Off-chain (same exchange)', kind: 'offchain' });
    edges.push({ id: 'statement>offchain', source: 'statement', target: 'offchain', amount: offChain.amount, count: offChain.count });
  }
  for (const n of res.nodes.values()) {
    const l = n.labels.length ? best(n.labels) : null;
    const kind: ChartNode['kind'] = n.stop ?? (n.hop === 0 ? 'recipient' : 'onward');
    nodes.push({ id: n.key, label: l ? `${l.name}\n${shortA(n.address)}` : n.deposit ? `${n.deposit.exchange} deposit (inferred)\n${shortA(n.address)}` : shortA(n.address), kind, chain: n.chain, address: n.address, category: l?.category, hop: n.hop });
  }
  for (const w of wallets) {
    const k = nodeKey(w.chain, w.address);
    if (res.nodes.has(k)) edges.push({ id: `statement>${k}`, source: 'statement', target: k, amount: w.total, count: w.count });
  }
  for (const e of res.edges) edges.push({ id: `${e.from}>${e.to}`, source: e.from, target: e.to, amount: e.via.amount, count: e.via.count });
  return { nodes, edges };
}
