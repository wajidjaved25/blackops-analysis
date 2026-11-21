import { Asset, norm, Transfer } from './chains';
import { topLabel, WEIGHTS } from './risk-score';

export const RULE_TYPES = ['amount_over', 'flagged_counterparty', 'volume_spike', 'risk_change'] as const;
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
  if (type === 'risk_change') return { minWeight: num(p?.minWeight, 'minWeight', 1, 50), asset: 'all' }; // re-scores the wallet over every asset
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


// ----- risk_change (9B): a watched wallet is re-scored periodically and compared with its last stored state -----

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2, severe: 3 };
const HIGH_RISK_LABEL = 80; // label weight from which a wallet counts as "labelled high-risk" (mixer, scam, fraud, ransomware, darknet, terrorism)

/** What is stored per WatchItem after each re-score; the next re-score is compared with it. */
export interface RiskSnap {
  score: number;
  level: string;
  frozen: boolean;
  sanctioned: boolean;
  highRiskLabel: boolean;
  flagged: Record<string, number>; // direct counterparties with a risk weight > 0 (address -> weight), capped
}

export function riskSnap(a: { score: number; level: string; frozen: boolean; labels: { category: string }[]; exposures: { address: string; weight: number }[] }): RiskSnap {
  const flagged: Record<string, number> = {};
  for (const e of a.exposures.filter((e) => e.weight > 0).slice(0, 50)) flagged[e.address] = e.weight;
  return {
    score: a.score,
    level: a.level,
    frozen: a.frozen,
    sanctioned: a.labels.some((l) => l.category === 'sanctioned'),
    highRiskLabel: a.labels.some((l) => l.category !== 'frozen' && l.category !== 'sanctioned' && (WEIGHTS[l.category] ?? 0) >= HIGH_RISK_LABEL),
    flagged,
  };
}

const cap = (l: string) => l.charAt(0).toUpperCase() + l.slice(1);

/**
 * Pure: the alert for a risk re-score, or null. `prev` null = first score, which only records a baseline.
 * Fires when the level goes up, the wallet becomes frozen / sanctioned / high-risk-labelled, or gains a NEW direct counterparty
 * with a risk weight of at least the rule's minWeight. A drop in risk never alerts.
 */
export function evaluateRiskChange(rule: RuleLike, prev: RiskSnap | null, next: RiskSnap, reasons: string[], now: number): Hit | null {
  if (!prev) return null;
  const why: string[] = [];
  if ((RANK[next.level] ?? 0) > (RANK[prev.level] ?? 0)) why.push(`risk level rose from ${cap(prev.level)} (${prev.score}) to ${cap(next.level)} (${next.score})`);
  if (next.frozen && !prev.frozen) why.push('the wallet is now frozen by the token issuer');
  if (next.sanctioned && !prev.sanctioned) why.push('the wallet is now labelled sanctioned');
  if (next.highRiskLabel && !prev.highRiskLabel) why.push('the wallet is now labelled high-risk');
  const min = Number(rule.params?.minWeight ?? 50);
  const fresh = Object.entries(next.flagged).filter(([a, w]) => w >= min && !((prev.flagged[a] ?? 0) >= min));
  if (fresh.length) why.push(`new direct exposure to ${fresh.length} flagged wallet${fresh.length === 1 ? '' : 's'} (${fresh.slice(0, 3).map(([a, w]) => `${a} weight ${w}`).join(', ')}${fresh.length > 3 ? ', …' : ''})`);
  if (!why.length) return null;
  const shown = reasons.filter((r) => !/^No risk indicators/.test(r)).slice(0, 3);
  return {
    ruleId: rule.id,
    dedupKey: `risk:${now}`, // every detected change is its own event; the stored snapshot stops the same change from being detected twice
    counterparty: fresh[0]?.[0],
    asset: 'all',
    detail: `Risk change: ${why.join('; ')}. Before: ${cap(prev.level)} (${prev.score}). Now: ${cap(next.level)} (${next.score}).${shown.length ? ` Reasons now: ${shown.join(' | ')}` : ''}`,
  };
}
