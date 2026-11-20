// Cross-chain endpoints (Phase 7C): swap detection on demand (7.14) and the bridge hop finder (7.15).
// Matching/ranking is pure (swap.ts, bridge-hop.ts); this file only fetches evidence and applies labels.
import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentCtx, Perm } from './auth';
import { CHAINS } from './assets';
import { Chain, getTransfers, getTx, hasEtherscanKey, isTxHash, norm, TxDetail, windowTransfers } from './chains';
import { HOP_DEFAULTS, HOP_LIMITS, HopOutflow, rankHops } from './bridge-hop';
import { Ctx } from './db';
import { LabelsService } from './labels';
import { detectSwaps } from './swap';
import { oneOf, parseAddr } from './util';

// Free TronGrid/Etherscan budget: each swap check is one tx lookup (cached a day), each bridge wallet scan is a few paged
// calls per asset. These caps are the bound; the response says when one was hit.
const SWAP_SCAN_DEFAULT = 8;
const SWAP_SCAN_MAX = 20;
const MAX_BRIDGES_PER_CHAIN = 6;
const MAX_ROWS_PER_BRIDGE = 600;

const num = (raw: unknown, def: number, [min, max]: readonly [number, number], field: string) => {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new BadRequestException(`${field} must be between ${min} and ${max}`);
  return n;
};

/** Swaps in one transaction, with `dex` labels applied (exact chain: a Tron dex label never matches an EVM address). */
export async function swapsOfTx(labels: LabelsService, tx: TxDetail, orgId: number) {
  const addrs = [...new Set([...tx.transfers.flatMap((t) => [t.from, t.to]), ...tx.native.flatMap((m) => [m.from, m.to])])];
  const dex = new Map((await labels.exact(tx.chain, ['dex'], orgId, addrs)).map((l) => [norm(l.address), l.name]));
  const n = (a: string) => norm(a);
  return detectSwaps(
    { ...tx, transfers: tx.transfers.map((t) => ({ ...t, from: n(t.from), to: n(t.to) })), native: tx.native.map((m) => ({ ...m, from: n(m.from), to: n(m.to) })) },
    (a) => dex.get(a),
  );
}

@Controller()
export class CrossChainController {
  constructor(private labels: LabelsService) {}

  /**
   * Did this wallet leave the stablecoin in a swap? Checks its outgoing transactions newest first, `max` per call
   * (default 8, cap 20; each tx lookup is cached a day) from `offset`, so a client can page in small chunks (free TronGrid
   * can take ~10 s per lookup under load). It never scans the whole history: `outgoingTx` / `nextOffset` say what is left.
   */
  @Perm('investigate.view')
  @Get('address/:addr/swaps')
  async addressSwaps(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string, @Query('chain') c?: string, @Query('max') maxRaw?: string, @Query('offset') offsetRaw?: string) {
    const { chain, addr } = parseAddr(raw, c);
    const offset = Math.round(num(offsetRaw, 0, [0, 200], 'offset'));
    const max = Math.round(num(maxRaw, SWAP_SCAN_DEFAULT, [1, SWAP_SCAN_MAX], 'max'));
    const out = (await getTransfers(chain, addr, 200, false, 'graph')).filter((t) => norm(t.from) === addr);
    const all = [...new Map(out.map((t) => [t.hash, t.timestamp])).entries()]; // newest first
    const hashes = all.slice(offset, offset + max); // newest first
    const swaps: unknown[] = [];
    const errors: { hash: string; error: string }[] = [];
    for (const [hash, ts] of hashes) {
      try {
        const tx = await getTx(chain, hash);
        for (const s of await swapsOfTx(this.labels, tx, ctx.orgId)) if (s.wallet === addr) swaps.push({ ...s, hash, timestamp: ts });
      } catch (e) {
        errors.push({ hash, error: (e as Error).message }); // reported, never dropped silently
      }
    }
    return { chain, address: addr, outgoingTx: all.length, scanned: hashes.length, offset, nextOffset: offset + max < all.length ? offset + max : null, swaps, errors, note: `Looked at outgoing transactions ${offset + 1}-${offset + hashes.length} of ${all.length} found in the newest 200 transfers; nothing older is scanned.` };
  }

  /**
   * Bridge hop finder. Input: a transaction on chain A that paid a `bridge`-labelled wallet (`hash`, `to`). Output: ranked
   * CANDIDATE outflows of `bridge`-labelled wallets on the other chain(s) inside the window/tolerance, each with evidence and
   * a confidence. Nothing is asserted.
   */
  @Perm('investigate.view')
  @Get('crosschain/hops')
  async hops(@CurrentCtx() ctx: Ctx, @Query('chain') chainRaw: string, @Query('hash') hash: string, @Query('to') toRaw: string, @Query('windowMin') windowRaw?: string, @Query('tolerancePct') tolRaw?: string, @Query('target') target?: string) {
    const chain = oneOf(chainRaw, 'chain', CHAINS) as Chain;
    if (!isTxHash(chain, hash ?? '')) throw new BadRequestException(`Not a valid ${chain} transaction hash`);
    const { addr: bridge } = parseAddr(toRaw, chain);
    const windowMin = num(windowRaw, HOP_DEFAULTS.windowMin, HOP_LIMITS.windowMin, 'windowMin');
    const tolerancePct = num(tolRaw, HOP_DEFAULTS.tolerancePct, HOP_LIMITS.tolerancePct, 'tolerancePct');

    const [srcLabel] = (await this.labels.exact(chain, ['bridge'], ctx.orgId, [bridge]));
    if (!srcLabel) throw new BadRequestException(`${bridge} is not labelled "bridge" on ${chain}. Add the label first (Labels page) - the finder only follows wallets you or an official source have identified as bridges.`);
    const tx = await getTx(chain, hash);
    if (!tx.success) throw new BadRequestException('That transaction failed on-chain; no funds moved');
    const deposits = tx.transfers.filter((t) => norm(t.to) === bridge);
    if (!deposits.length) throw new BadRequestException(`That transaction has no USDT/USDC transfer into ${bridge}`);
    const dep = deposits.reduce((a, b) => (b.amount > a.amount ? b : a));
    const source = { chain, hash, from: dep.from, bridge, bridgeName: srcLabel.name, amount: dep.amount, asset: dep.asset, timestamp: tx.timestamp };

    const wanted = target ? oneOf(target, 'target', CHAINS) : null;
    const targets = CHAINS.filter((x) => x !== chain && (!wanted || x === wanted));
    const to = source.timestamp + windowMin * 60_000;
    const sides: { chain: Chain; status: 'ok' | 'no_bridge_labels' | 'error'; bridges: number; scanned: number; truncated: boolean; error?: string }[] = [];
    const cands: HopOutflow[] = [];
    for (const tc of targets) {
      const bridges = (await this.labels.exact(tc, ['bridge'], ctx.orgId)).slice(0, MAX_BRIDGES_PER_CHAIN);
      if (!bridges.length) {
        sides.push({ chain: tc, status: 'no_bridge_labels', bridges: 0, scanned: 0, truncated: false });
        continue;
      }
      const side = { chain: tc, status: 'ok' as 'ok' | 'error', bridges: bridges.length, scanned: 0, truncated: false, error: undefined as string | undefined };
      for (const b of bridges) {
        try {
          const w = await windowTransfers(tc, b.address, source.timestamp, to, 'all', MAX_ROWS_PER_BRIDGE);
          side.scanned += w.rows.length;
          side.truncated ||= w.truncated;
          for (const t of w.rows) if (norm(t.from) === b.address) cands.push({ chain: tc, hash: t.hash, bridge: b.address, bridgeName: b.name, to: norm(t.to), amount: t.amount, asset: t.asset, ts: t.timestamp });
        } catch (e) {
          side.status = 'error';
          side.error = (e as Error).message; // e.g. ETHERSCAN_API_KEY missing: surfaced to the user, not an empty "no match"
        }
      }
      sides.push(side);
    }
    return {
      source,
      params: { windowMin, tolerancePct, defaults: HOP_DEFAULTS },
      sides,
      candidates: rankHops({ chain, amount: dep.amount, asset: dep.asset, ts: source.timestamp, bridgeName: srcLabel.name }, cands, { windowMin, tolerancePct }),
      etherscanKey: hasEtherscanKey(),
      note: 'Candidates are heuristic matches on time, amount and bridge. They are not proof that the funds are the same; nothing here is asserted.',
    };
  }
}
