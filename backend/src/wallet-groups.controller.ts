// Phase 9C: on-demand "possibly same owner" groups for one address. Bounded: <= 16 extra histories, 200 transfers each, 20 s per read. Nothing is stored.
import { Controller, Get, Injectable, Param, Query } from '@nestjs/common';
import { CurrentCtx, Perm } from './auth';
import { Chain, getTransfers, norm, Transfer } from './chains';
import { Ctx, Db } from './db';
import { LabelsService } from './labels';
import { GROUP_DEFAULTS, GROUP_NOTE, groupWallets, WalletGroup } from './wallet-groups';
import { parseAddr } from './util';

const PER_WALLET = 200;
const MAX_EXTRA = 16;
export const SERVICE_CATS = ['exchange', 'exchange_deposit', 'service', 'bridge', 'dex'];

const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** Labels + service-scale flags for a set of addresses on one chain, as the two predicates the grouping needs. */
export async function groupPredicates(labels: LabelsService, db: Db, chain: Chain, addrs: string[], orgId: number) {
  const list = [...new Set(addrs.map(norm))];
  const deposit = new Set<string>();
  const service = new Set<string>();
  for (let i = 0; i < list.length; i += 2000) {
    const part = list.slice(i, i + 2000);
    for (const [a, ls] of await labels.lookup(chain, part, orgId)) {
      if (ls.some((l) => l.category === 'exchange_deposit')) deposit.add(a);
      if (ls.some((l) => SERVICE_CATS.includes(l.category))) service.add(a);
    }
    for (const x of await db.indexedAddress.findMany({ where: { chain, address: { in: part }, status: 'capped' }, select: { address: true } })) service.add(x.address);
  }
  return { isDeposit: (a: string) => deposit.has(norm(a)), isService: (a: string) => service.has(norm(a)) };
}

@Injectable()
export class WalletGroupsService {
  constructor(
    private db: Db,
    private labels: LabelsService,
  ) {}

  async forAddress(chain: Chain, addr: string, orgId: number) {
    const me = norm(addr);
    const own = await timeout(getTransfers(chain, me, PER_WALLET, false, 'lookup'), 60_000);
    const partial = own.length >= PER_WALLET;
    const histories = new Map<string, Transfer[]>([[me, own]]);
    const out = new Set<string>();
    const inn = new Set<string>();
    for (const t of own) {
      if (norm(t.from) === me && norm(t.to) !== me) out.add(norm(t.to));
      if (norm(t.to) === me && norm(t.from) !== me) inn.add(norm(t.from));
    }
    const pred0 = await groupPredicates(this.labels, this.db, chain, [...out, ...inn], orgId);
    const extra = new Set<string>();
    for (const a of [...out].filter((x) => inn.has(x) && !pred0.isService(x)).slice(0, 6)) extra.add(a); // round-trip partners
    const first = own.filter((t) => norm(t.to) === me && norm(t.from) !== me).sort((x, y) => x.timestamp - y.timestamp)[0];
    const funder = first && !pred0.isService(norm(first.from)) ? norm(first.from) : null;
    const deposits = [...out].filter((a) => pred0.isDeposit(a)).slice(0, 3);
    const links = new Map<string, Transfer[]>();
    await Promise.all([...(funder ? [funder] : []), ...deposits].map(async (a) => links.set(a, await timeout(getTransfers(chain, a, PER_WALLET, false, 'graph'), 20_000).catch(() => []))));
    if (funder && first) {
      const near = (links.get(funder) ?? [])
        .filter((t) => norm(t.from) === funder && norm(t.to) !== me && Math.abs(t.timestamp - first.timestamp) <= GROUP_DEFAULTS.funderWindowMs)
        .sort((x, y) => Math.abs(x.timestamp - first.timestamp) - Math.abs(y.timestamp - first.timestamp));
      for (const t of near.slice(0, 8)) extra.add(norm(t.to));
    }
    for (const d of deposits) for (const t of (links.get(d) ?? []).filter((x) => norm(x.to) === d).slice(0, 40)) if (norm(t.from) !== me) extra.add(norm(t.from));
    const cand = [...extra].filter((a) => a !== me).slice(0, MAX_EXTRA);
    await Promise.all(cand.map(async (a) => histories.set(a, await timeout(getTransfers(chain, a, PER_WALLET, false, 'graph'), 20_000).catch(() => []))));
    const pred = await groupPredicates(this.labels, this.db, chain, [...histories.values()].flatMap((h) => h.flatMap((t) => [t.from, t.to])), orgId);
    const groups: WalletGroup[] = groupWallets({ chain, histories, ...pred }).filter((g) => g.wallets.includes(me));
    return {
      address: me, chain, groups, partial, note: GROUP_NOTE, checked: histories.size,
      bounds: { transfersPerWallet: PER_WALLET, extraWallets: MAX_EXTRA, funderWindowHours: GROUP_DEFAULTS.funderWindowMs / 3600_000, roundTripHours: GROUP_DEFAULTS.roundTripMs / 3600_000 },
    };
  }
}

@Controller()
export class WalletGroupsController {
  constructor(private svc: WalletGroupsService) {}

  /** Wallets that may share an owner with this address: common funder, shared exchange customer deposit address, round trips. Heuristics with evidence. */
  @Perm('investigate.view')
  @Get('address/:addr/groups')
  groups(@CurrentCtx() ctx: Ctx, @Param('addr') addr: string, @Query('chain') chain?: string) {
    const p = parseAddr(addr, chain);
    return this.svc.forAddress(p.chain, p.addr, ctx.orgId);
  }
}
