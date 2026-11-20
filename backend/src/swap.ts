// Swap detection (7.14). Pure: reads one transaction's stablecoin transfers + native (TRX/ETH/BNB) value moves, no I/O.
// A wallet "left the stablecoin" in a tx when it paid out stablecoin (net) and, in the SAME tx, either received native coin
// (net) or paid a wallet labelled `dex`. This is evidence from one transaction, not an identity claim, and it only sees
// internal value calls — a swap routed through a wrapped token with no native payout (e.g. USDT -> WTRX) is not detected.
import { Asset } from './assets';
import type { NativeMove } from './chains';

export interface SwapTransfer {
  from: string;
  to: string;
  amount: number;
  asset: Asset;
}
export interface Swap {
  wallet: string;
  direction: 'out' | 'in'; // out: wallet sold stablecoin; in: wallet received stablecoin from a dex
  asset: Asset;
  amount: number; // net stablecoin the wallet gave up (out) or received (in)
  native?: { symbol: string; amount: number }; // out only: net native coin the same wallet received
  dex?: { address: string; name: string };
  summary: string; // "Sold 23 USDT, received 73.99 TRX in the same transaction"
  reasons: string[]; // evidence, shown as-is (plan.md rule 4)
}
export interface SwapInput {
  success: boolean;
  nativeSymbol: string;
  transfers: SwapTransfer[];
  native: NativeMove[];
}

const EPS = 1e-9;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** `dexOf(address)` returns the dex label name for a wallet labelled `dex`, else undefined. Addresses must already be normalised. */
export function detectSwaps(tx: SwapInput, dexOf: (addr: string) => string | undefined): Swap[] {
  if (!tx.success) return [];
  const out: Swap[] = [];
  const wallets = [...new Set(tx.transfers.flatMap((t) => [t.from, t.to]))];
  for (const w of wallets) {
    for (const asset of new Set(tx.transfers.map((t) => t.asset))) {
      const mine = tx.transfers.filter((t) => t.asset === asset);
      const net = sum(mine.filter((t) => t.to === w).map((t) => t.amount)) - sum(mine.filter((t) => t.from === w).map((t) => t.amount));
      const sym = asset.toUpperCase();
      if (net < -EPS) {
        const sold = -net;
        const nativeNet = sum(tx.native.filter((m) => m.to === w).map((m) => m.amount)) - sum(tx.native.filter((m) => m.from === w).map((m) => m.amount));
        const dexTo = mine.filter((t) => t.from === w).map((t) => ({ address: t.to, name: dexOf(t.to) })).find((d) => d.name);
        if (nativeNet <= EPS && !dexTo) continue;
        const reasons = [`${fmt(sold)} ${sym} left the wallet in this transaction`];
        if (nativeNet > EPS) reasons.push(`The same wallet received ${fmt(nativeNet)} ${tx.nativeSymbol} in the same transaction`);
        if (dexTo) reasons.push(`The ${sym} went to ${dexTo.address}, labelled dex: ${dexTo.name}`);
        out.push({
          wallet: w,
          direction: 'out',
          asset,
          amount: sold,
          ...(nativeNet > EPS ? { native: { symbol: tx.nativeSymbol, amount: nativeNet } } : {}),
          ...(dexTo ? { dex: { address: dexTo.address, name: dexTo.name! } } : {}),
          summary: nativeNet > EPS ? `Sold ${fmt(sold)} ${sym}, received ${fmt(nativeNet)} ${tx.nativeSymbol} in the same transaction` : `Sent ${fmt(sold)} ${sym} to a DEX (${dexTo!.name})`,
          reasons,
        });
      } else if (net > EPS) {
        const dexFrom = mine.filter((t) => t.to === w).map((t) => ({ address: t.from, name: dexOf(t.from) })).find((d) => d.name);
        if (!dexFrom) continue;
        out.push({
          wallet: w,
          direction: 'in',
          asset,
          amount: net,
          dex: { address: dexFrom.address, name: dexFrom.name! },
          summary: `Received ${fmt(net)} ${sym} from a DEX (${dexFrom.name})`,
          reasons: [`${fmt(net)} ${sym} arrived in this transaction`, `The sender ${dexFrom.address} is labelled dex: ${dexFrom.name}`],
        });
      }
    }
  }
  return out;
}

export function selfCheckSwap(assert: typeof import('node:assert/strict')) {
  const tx = (o: Partial<SwapInput>): SwapInput => ({ success: true, nativeSymbol: 'TRX', transfers: [], native: [], ...o });
  const none = () => undefined;
  // Real shape (Tron 987c9423…): user -> pair 23 USDT; WTRX -> router -> user 73.99 TRX.
  const s = detectSwaps(tx({ transfers: [{ from: 'U', to: 'PAIR', amount: 23, asset: 'usdt' }], native: [{ from: 'WTRX', to: 'R', amount: 73.99327 }, { from: 'R', to: 'U', amount: 73.99327 }] }), none);
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].wallet, s[0].direction, s[0].amount, s[0].native?.symbol, s[0].native?.amount], ['U', 'out', 23, 'TRX', 73.99327]);
  assert.match(s[0].summary, /Sold 23 USDT, received 73.99327 TRX/);
  // pass-through router: stablecoin in and out nets to zero, so only the user is reported
  const hop = detectSwaps(tx({ transfers: [{ from: 'U', to: 'R', amount: 5, asset: 'usdt' }, { from: 'R', to: 'PAIR', amount: 5, asset: 'usdt' }], native: [{ from: 'R', to: 'U', amount: 20 }] }), none);
  assert.deepEqual(hop.map((x) => x.wallet), ['U']);
  // plain transfer, no native back, no dex -> nothing
  assert.equal(detectSwaps(tx({ transfers: [{ from: 'A', to: 'B', amount: 9, asset: 'usdt' }] }), none).length, 0);
  // native paid out again by the same wallet cancels the "received" side
  assert.equal(detectSwaps(tx({ transfers: [{ from: 'A', to: 'B', amount: 9, asset: 'usdt' }], native: [{ from: 'X', to: 'A', amount: 1 }, { from: 'A', to: 'Y', amount: 1 }] }), none).length, 0);
  // dex-labelled counterparty, no native payout
  const dexOf = (a: string) => (a === 'DEX1' ? 'SunSwap router' : undefined);
  const d = detectSwaps(tx({ transfers: [{ from: 'A', to: 'DEX1', amount: 50, asset: 'usdc' }] }), dexOf);
  assert.deepEqual([d[0].direction, d[0].dex?.name, d[0].native], ['out', 'SunSwap router', undefined]);
  const din = detectSwaps(tx({ transfers: [{ from: 'DEX1', to: 'A', amount: 50, asset: 'usdt' }] }), dexOf);
  assert.deepEqual([din[0].wallet, din[0].direction], ['A', 'in']);
  assert.equal(detectSwaps(tx({ success: false, transfers: [{ from: 'U', to: 'P', amount: 1, asset: 'usdt' }], native: [{ from: 'P', to: 'U', amount: 1 }] }), none).length, 0);
}
