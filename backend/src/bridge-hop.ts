// Bridge hop finder (7.15): pure matching + ranking. Given a deposit into a bridge wallet on chain A, rank outflows of
// bridge wallets on chain B that could be its continuation. This is a heuristic on (time, amount, bridge): every result
// is a CANDIDATE with its evidence and a confidence, never an assertion (plan.md rules 4 and 5).
import { Asset } from './assets';
import type { Chain } from './chains';

export const HOP_DEFAULTS = { windowMin: 60, tolerancePct: 1 };
export const HOP_LIMITS = { windowMin: [1, 1440], tolerancePct: [0.01, 10] } as const;
/** The payout may exceed the deposit by at most this much (rounding), never more. */
const OVERSHOOT_PCT = 0.1;
export const MAX_CANDIDATES = 10;

export interface HopSource {
  chain: Chain;
  amount: number;
  asset: Asset;
  ts: number;
  bridgeName: string; // label of the bridge wallet that received the deposit
}
export interface HopOutflow {
  chain: Chain;
  hash: string;
  bridge: string; // the bridge wallet that sent it
  bridgeName: string;
  to: string; // recipient on the destination chain: the continuation
  amount: number;
  asset: Asset;
  ts: number;
}
export interface RankedHop extends HopOutflow {
  amountDelta: number; // deposit - payout (the bridge fee, if this is the right match)
  amountDeltaPct: number;
  timeDeltaSec: number; // payout - deposit
  bridgePair: { from: string; to: string };
  confidence: number; // 0..0.95 — never certain
  level: 'high' | 'medium' | 'low';
  reasons: string[];
}

/** First word of a bridge label ("Allbridge Core USDT" -> "allbridge"): same word on both sides = same protocol. */
const protocol = (name: string) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
const r2 = (n: number) => Math.round(n * 100) / 100;

export function rankHops(src: HopSource, cands: HopOutflow[], opts: { windowMin?: number; tolerancePct?: number } = {}): RankedHop[] {
  const windowMin = opts.windowMin ?? HOP_DEFAULTS.windowMin;
  const windowMs = windowMin * 60_000;
  const tol = opts.tolerancePct ?? HOP_DEFAULTS.tolerancePct;
  const hits = cands
    .filter((c) => c.chain !== src.chain)
    .map((c) => ({ c, dt: c.ts - src.ts, pct: ((src.amount - c.amount) / src.amount) * 100 }))
    .filter((x) => x.dt >= 0 && x.dt <= windowMs && x.pct <= tol && x.pct >= -OVERSHOOT_PCT);
  const n = hits.length;
  return hits
    .map(({ c, dt, pct }): RankedHop => {
      const amountScore = 1 - Math.max(0, pct) / tol; // 1 = exact amount, 0 = at the tolerance edge
      const timeScore = 1 - dt / windowMs;
      const sameProto = protocol(src.bridgeName) !== '' && protocol(src.bridgeName) === protocol(c.bridgeName);
      const sameAsset = c.asset === src.asset;
      let conf = 0.35 * amountScore + 0.25 * timeScore + 0.2 * (sameProto ? 1 : 0) + 0.2 * (1 / n);
      if (!sameAsset) conf *= 0.8;
      conf = Math.min(0.95, conf);
      return {
        ...c,
        amountDelta: r2(src.amount - c.amount),
        amountDeltaPct: r2(pct),
        timeDeltaSec: Math.round(dt / 1000),
        bridgePair: { from: src.bridgeName, to: c.bridgeName },
        confidence: r2(conf),
        level: conf >= 0.7 ? 'high' : conf >= 0.45 ? 'medium' : 'low',
        reasons: [
          `Amount: deposit ${src.amount} ${src.asset.toUpperCase()} vs payout ${c.amount} ${c.asset.toUpperCase()} (difference ${r2(src.amount - c.amount)}, ${r2(pct)}%, within the ${tol}% fee tolerance)`,
          `Time: payout ${Math.round(dt / 1000)} s after the deposit (window ${windowMin} min)`,
          sameProto ? `Same bridge protocol on both sides ("${src.bridgeName}" / "${c.bridgeName}")` : `Different bridge labels ("${src.bridgeName}" / "${c.bridgeName}"): protocol match not established`,
          n === 1 ? 'Only candidate within the window and tolerance' : `${n} candidates fit the window and tolerance, so any one is less certain`,
          ...(sameAsset ? [] : [`Different asset on the destination chain (${src.asset.toUpperCase()} -> ${c.asset.toUpperCase()}), confidence reduced`]),
        ],
      };
    })
    .sort((a, b) => b.confidence - a.confidence || a.timeDeltaSec - b.timeDeltaSec)
    .slice(0, MAX_CANDIDATES);
}

export function selfCheckHops(assert: typeof import('node:assert/strict')) {
  const t0 = 1_700_000_000_000;
  const src: HopSource = { chain: 'tron', amount: 1000, asset: 'usdt', ts: t0, bridgeName: 'Allbridge Core (Tron)' };
  const o = (hash: string, amount: number, secAfter: number, over: Partial<HopOutflow> = {}): HopOutflow => ({ chain: 'eth', hash, bridge: '0xb', bridgeName: 'Allbridge Core (Ethereum)', to: '0xdest', amount, asset: 'usdt', ts: t0 + secAfter * 1000, ...over });
  const r = rankHops(src, [
    o('good', 999.5, 120), // fee 0.05%, 2 min
    o('late', 999.5, 7200), // outside 60 min
    o('early', 999.5, -5), // before the deposit
    o('fat', 900, 60), // 10% off
    o('more', 1010, 60), // overshoot
    o('samechain', 999, 60, { chain: 'tron' }),
    o('other', 995, 600, { bridgeName: 'Wormhole portal' }), // fits (0.5%) but another protocol
  ]);
  assert.deepEqual(r.map((x) => x.hash), ['good', 'other']);
  assert.ok(r[0].confidence > r[1].confidence && r[0].confidence <= 0.95);
  assert.deepEqual([r[0].amountDelta, r[0].timeDeltaSec, r[0].bridgePair.to], [0.5, 120, 'Allbridge Core (Ethereum)']);
  assert.ok(r[0].reasons.length >= 4 && r[0].reasons[0].includes('999.5'));
  // a lone exact, same-protocol, instant match is high but never 1; a crowd of similar payouts lowers it
  const lone = rankHops(src, [o('a', 1000, 5)])[0];
  assert.equal(lone.level, 'high');
  assert.ok(lone.confidence < 1);
  const crowd = rankHops(src, [o('a', 1000, 5), o('b', 999.9, 6), o('c', 999.8, 7), o('d', 999.7, 8)]);
  assert.ok(crowd[0].confidence < lone.confidence);
  // parameters: a wider tolerance admits the 10% case; a 1-minute window drops 'good'
  assert.equal(rankHops(src, [o('fat', 900, 60)], { tolerancePct: 10 }).length, 1);
  assert.equal(rankHops(src, [o('good', 999.5, 120)], { windowMin: 1 }).length, 0);
  assert.ok(rankHops(src, [o('x', 1000, 5, { asset: 'usdc' })])[0].confidence < lone.confidence); // an asset change is penalised
}
