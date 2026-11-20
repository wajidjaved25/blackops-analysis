import { Flow } from './chains';

/** plan.md §5 — keep in sync. */
export const WEIGHTS: Record<string, number> = {
  sanctioned: 100,
  frozen: 100,
  ransomware: 95,
  darknet: 95,
  terrorism: 95,
  scam: 90,
  fraud: 90,
  mixer: 80,
  gambling: 50,
  other: 20,
  exchange: 0,
  service: 0,
  bridge: 0, // 7C: informational — funds may continue on another chain (bridge-hop.ts)
  dex: 0, // 7C: informational — a swap venue (swap.ts)
};
export const CATEGORIES = Object.keys(WEIGHTS);
export const INDIRECT_DISCOUNT = 0.5;

export type Level = 'severe' | 'high' | 'medium' | 'low';
export const level = (s: number): Level => (s >= 75 ? 'severe' : s >= 40 ? 'high' : s >= 15 ? 'medium' : 'low');

export interface LabelLike {
  name: string;
  category: string;
}
export interface Exposure {
  address: string;
  name: string;
  category: string;
  weight: number;
  volume: number;
  share: number; // 0..1 of this wallet's volume
}
export interface IndirectInput {
  address: string;
  share: number; // share of this wallet's volume going through that counterparty
  directScore: number; // that counterparty's own direct exposure score
}
export interface RiskResult {
  score: number;
  level: Level;
  own: number;
  direct: number;
  indirect: number;
  reasons: string[];
  exposures: Exposure[];
}

/** The highest-risk label, or null. */
export function topLabel(labels: LabelLike[]): LabelLike | null {
  let best: LabelLike | null = null;
  for (const l of labels) if (!best || (WEIGHTS[l.category] ?? 0) > (WEIGHTS[best.category] ?? 0)) best = l;
  return best;
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
const usd = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
// USDT and USDC both track the US dollar, so volume of different assets is simply added and shown as USD-equivalent.
export const USD_NOTE = 'USDT and USDC are both ≈ 1 USD, so their volumes are added';

/** Pure scoring: own labels, direct (1-hop) exposure by volume, discounted indirect (2-hop) exposure. */
export function scoreRisk(input: { own: LabelLike[]; frozen: boolean; frozenBy?: string[]; flows: Flow[]; labelsOf: (addr: string) => LabelLike[]; indirect?: IndirectInput[] }): RiskResult {
  const reasons: string[] = [];

  let own = 0;
  if (input.frozen) {
    own = 100;
    reasons.push(input.frozenBy?.length ? `Frozen by ${input.frozenBy.join(' and ')} (issuer blacklist)` : 'Frozen by the token issuer (blacklist)');
  }
  for (const l of input.own) {
    const w = WEIGHTS[l.category] ?? 0;
    own = Math.max(own, w);
    if (w > 0 && !(l.category === 'frozen' && input.frozen)) reasons.push(`Labelled ${l.category}: ${l.name}`);
  }

  const total = input.flows.reduce((s, f) => s + f.in + f.out, 0);
  const exposures: Exposure[] = [];
  let weighted = 0;
  for (const f of input.flows) {
    const best = topLabel(input.labelsOf(f.address));
    if (!best) continue;
    const w = WEIGHTS[best.category] ?? 0;
    const volume = f.in + f.out;
    exposures.push({ address: f.address, name: best.name, category: best.category, weight: w, volume, share: total ? volume / total : 0 });
    weighted += w * volume;
  }
  exposures.sort((a, b) => b.weight * b.volume - a.weight * a.volume);
  const direct = total ? weighted / total : 0;
  for (const e of exposures.filter((e) => e.weight > 0).slice(0, 5)) {
    reasons.push(`Direct exposure: ${usd(e.volume)} USD-equivalent (${pct(e.share)} of volume; ${USD_NOTE}) with ${e.category} wallet ${e.address} (${e.name})`);
  }

  let indirect = 0;
  for (const i of input.indirect ?? []) indirect += i.share * i.directScore * INDIRECT_DISCOUNT;
  if (indirect >= 1) {
    const top = [...(input.indirect ?? [])].sort((a, b) => b.share * b.directScore - a.share * a.directScore)[0];
    reasons.push(`Indirect exposure (2 hops): counterparties such as ${top.address} have direct risk exposure themselves`);
  }

  const score = Math.min(100, Math.round(Math.max(own, direct, indirect)));
  if (!reasons.length) reasons.push('No risk indicators found in labels or in the transfers checked');
  return { score, level: level(score), own: Math.round(own), direct: Math.round(direct * 10) / 10, indirect: Math.round(indirect * 10) / 10, reasons, exposures: exposures.slice(0, 25) };
}
