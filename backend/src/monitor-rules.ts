import { Asset, norm, Transfer } from './chains';
import { topLabel, WEIGHTS } from './risk-score';

export const RULE_TYPES = ['amount_over', 'flagged_counterparty', 'volume_spike'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export interface RuleLike {
  id: number;
  type: string;
  params: any;
}
export interface Hit {
  ruleId: number;
  dedupKey: string;
  txHash?: string;
  amount?: number;
  counterparty?: string;
  asset: Asset | 'all'; // the asset the alert is about ('all' = a rule over every asset, e.g. a volume spike)
  detail: string;
}

const HOUR = 3_600_000;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Validates and normalises rule params; throws a readable message. */
export function ruleParams(type: RuleType, p: any): Record<string, number | string> {
  const num = (v: unknown, name: string, min: number, def?: number) => {
    const n = v === undefined || v === '' ? def : Number(v);
    if (n === undefined || !Number.isFinite(n) || n < min) throw new Error(`${name} must be a number ≥ ${min}`);
    return n;
  };
  const asset = p?.asset === undefined || p?.asset === '' ? 'all' : p.asset;
  if (asset !== 'all' && asset !== 'usdt' && asset !== 'usdc') throw new Error('asset must be usdt, usdc or all');
  if (type === 'amount_over') return { amount: num(p?.amount, 'amount', 0), asset };
  if (type === 'flagged_counterparty') return { minWeight: num(p?.minWeight, 'minWeight', 1, 50), asset };
  return { factor: num(p?.factor, 'factor', 1.1, 5), asset };
}

/**
 * Pure rule evaluation for one watched address.
 * `fresh` = transfers newer than the last poll; `history` = all fetched transfers (incl. fresh), for spike baselines.
 */
export function evaluateRules(
  rules: RuleLike[],
  me: string,
  allFresh: Transfer[],
  allHistory: Transfer[],
  labelsOf: (addr: string) => { name: string; category: string }[],
  now: number,
): Hit[] {
  const hits: Hit[] = [];
  if (!allFresh.length) return hits;
  const self = norm(me);
  const other = (t: Transfer) => (norm(t.to) === self ? t.from : t.to);
  const dir = (t: Transfer) => (norm(t.to) === self ? 'received' : 'sent');
  const key = (t: Transfer) => (t.asset === 'usdt' ? t.hash : `${t.hash}:${t.asset}`); // USDT keys stay the plain tx hash (existing alerts)
  const sym = (t: Transfer) => t.asset.toUpperCase();

  for (const r of rules) {
    // A rule watches one asset, or every asset when none is set (rules created before 7B have no asset param).
    const only = r.params.asset === 'usdt' || r.params.asset === 'usdc' ? (r.params.asset as Asset) : null;
    const fresh = allFresh.filter((t) => !only || t.asset === only);
    const history = allHistory.filter((t) => !only || t.asset === only);
    if (r.type === 'amount_over') {
      for (const t of fresh.filter((t) => t.amount >= r.params.amount)) {
        hits.push({ ruleId: r.id, dedupKey: key(t), txHash: t.hash, amount: t.amount, counterparty: other(t), asset: t.asset, detail: `Large transfer: ${dir(t)} ${fmt(t.amount)} ${sym(t)} (threshold ${fmt(r.params.amount)})` });
      }
    } else if (r.type === 'flagged_counterparty') {
      for (const t of fresh) {
        const l = topLabel(labelsOf(norm(other(t))));
        const w = l ? WEIGHTS[l.category] ?? 0 : 0;
        if (l && w >= r.params.minWeight) {
          hits.push({ ruleId: r.id, dedupKey: key(t), txHash: t.hash, amount: t.amount, counterparty: other(t), asset: t.asset, detail: `${dir(t) === 'received' ? 'Received' : 'Sent'} ${fmt(t.amount)} ${sym(t)} ${dir(t) === 'received' ? 'from' : 'to'} ${l.category} wallet (${l.name})` });
        }
      }
    } else if (r.type === 'volume_spike') {
      const cutoff = now - HOUR;
      const lastHour = history.filter((t) => t.timestamp >= cutoff).reduce((s, t) => s + t.amount, 0);
      const older = history.filter((t) => t.timestamp < cutoff);
      if (!older.length || lastHour <= 0) continue;
      const hours = Math.max(1, (cutoff - Math.min(...older.map((t) => t.timestamp))) / HOUR);
      const avg = older.reduce((s, t) => s + t.amount, 0) / hours;
      if (lastHour > r.params.factor * avg) {
        const unit = only ? only.toUpperCase() : 'USD-equivalent (USDT + USDC)';
        hits.push({ ruleId: r.id, dedupKey: `spike:${Math.floor(now / HOUR)}`, amount: lastHour, asset: only ?? 'all', detail: `Volume spike: ${fmt(lastHour)} ${unit} in the last hour vs ${fmt(avg)}/hour average (×${(lastHour / Math.max(avg, 1e-9)).toFixed(1)}, threshold ×${r.params.factor})` });
      }
    }
  }
  return hits;
}
