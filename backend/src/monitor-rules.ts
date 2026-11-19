import { norm, Transfer } from './chains';
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
  detail: string;
}

const HOUR = 3_600_000;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Validates and normalises rule params; throws a readable message. */
export function ruleParams(type: RuleType, p: any): Record<string, number> {
  const num = (v: unknown, name: string, min: number, def?: number) => {
    const n = v === undefined || v === '' ? def : Number(v);
    if (n === undefined || !Number.isFinite(n) || n < min) throw new Error(`${name} must be a number ≥ ${min}`);
    return n;
  };
  if (type === 'amount_over') return { amount: num(p?.amount, 'amount', 0) };
  if (type === 'flagged_counterparty') return { minWeight: num(p?.minWeight, 'minWeight', 1, 50) };
  return { factor: num(p?.factor, 'factor', 1.1, 5) };
}

/**
 * Pure rule evaluation for one watched address.
 * `fresh` = transfers newer than the last poll; `history` = all fetched transfers (incl. fresh), for spike baselines.
 */
export function evaluateRules(
  rules: RuleLike[],
  me: string,
  fresh: Transfer[],
  history: Transfer[],
  labelsOf: (addr: string) => { name: string; category: string }[],
  now: number,
): Hit[] {
  const hits: Hit[] = [];
  if (!fresh.length) return hits;
  const self = norm(me);
  const other = (t: Transfer) => (norm(t.to) === self ? t.from : t.to);
  const dir = (t: Transfer) => (norm(t.to) === self ? 'received' : 'sent');

  for (const r of rules) {
    if (r.type === 'amount_over') {
      for (const t of fresh.filter((t) => t.amount >= r.params.amount)) {
        hits.push({ ruleId: r.id, dedupKey: t.hash, txHash: t.hash, amount: t.amount, counterparty: other(t), detail: `Large transfer: ${dir(t)} ${fmt(t.amount)} USDT (threshold ${fmt(r.params.amount)})` });
      }
    } else if (r.type === 'flagged_counterparty') {
      for (const t of fresh) {
        const l = topLabel(labelsOf(norm(other(t))));
        const w = l ? WEIGHTS[l.category] ?? 0 : 0;
        if (l && w >= r.params.minWeight) {
          hits.push({ ruleId: r.id, dedupKey: t.hash, txHash: t.hash, amount: t.amount, counterparty: other(t), detail: `${dir(t) === 'received' ? 'Received' : 'Sent'} ${fmt(t.amount)} USDT ${dir(t) === 'received' ? 'from' : 'to'} ${l.category} wallet (${l.name})` });
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
        hits.push({ ruleId: r.id, dedupKey: `spike:${Math.floor(now / HOUR)}`, amount: lastHour, detail: `Volume spike: ${fmt(lastHour)} USDT in the last hour vs ${fmt(avg)} USDT/hour average (×${(lastHour / Math.max(avg, 1e-9)).toFixed(1)}, threshold ×${r.params.factor})` });
      }
    }
  }
  return hits;
}
