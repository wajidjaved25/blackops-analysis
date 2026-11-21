import { BadRequestException, Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentCtx, Perm } from './auth';
import { assetsOf, CHAINS, selectAssets } from './assets';
import { AssetFilter, Chain, flows, frozenBy, frozenStatus, getBalances, getTransfers, getTx, isTxHash, norm, Transfer } from './chains';
import { audit, Ctx, Db } from './db';
import { buildGraph, findPath, GetFlows, GraphNode, withVolumes } from './graph';
import { swapsOfTx } from './crosschain';
import { isServiceScale } from './exchange-labels';
import { LabelsService } from './labels';
import { RiskService } from './risk';
import { TransferIndex } from './transfer-index';
import { topLabel } from './risk-score';
import { assetParam, int, oneOf, parseAddr, toCsv } from './util';

// ponytail: graph/path read only the latest 200 transfers per node (from Postgres when the node is indexed, else the live API).
const PER_NODE = 200;

function time(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (Number.isNaN(t)) throw new BadRequestException(`Invalid date "${raw}"`);
  return t;
}

interface Filter {
  from?: number;
  to?: number;
  min?: number;
}
const applyFilter = (ts: Transfer[], f: Filter) =>
  ts.filter((t) => (f.from === undefined || t.timestamp >= f.from) && (f.to === undefined || t.timestamp <= f.to) && (f.min === undefined || t.amount >= f.min));

function flowsFor(chain: Chain, f: Filter, withTransfers: boolean, root: string, asset: AssetFilter): GetFlows {
  // the searched wallet is indexed (backfill queued); neighbour nodes are only written through. perAsset: one edge per asset.
  return async (a) => flows(a, applyFilter(await getTransfers(chain, a, PER_NODE, false, a === root ? 'lookup' : 'graph', asset), f), withTransfers, true);
}

@Controller()
export class InvestigateController {
  constructor(
    private db: Db,
    private labels: LabelsService,
    private risk: RiskService,
    private index: TransferIndex,
  ) {}

  /** Adds the highest-risk label (name + category) to each graph node. */
  private async labelNodes<T extends GraphNode>(chain: Chain, nodes: T[], orgId: number) {
    const m = await this.labels.lookup(chain, nodes.map((n) => n.id), orgId);
    return nodes.map((n) => {
      const top = topLabel(m.get(n.id) ?? []);
      return top ? { ...n, label: top.name, category: top.category } : n;
    });
  }

  /** Transfers, balance and freeze status are fetched concurrently; `deep` (2-hop risk, ~5 more wallets) is opt-in — the UI loads GET /risk/:addr separately. */
  async summary(chain: Chain, addr: string, limit: number, orgId: number, deep = false, asset: AssetFilter = 'all') {
    const [transfers, balances, frozenMap] = await Promise.all([getTransfers(chain, addr, limit, false, 'lookup', asset), getBalances(chain, addr), frozenStatus(chain, addr)]);
    const risk = await this.risk.assess(chain, addr, orgId, { transfers, deep, frozen: frozenMap });
    let totalIn = 0;
    let totalOut = 0;
    const byAsset: Record<string, { in: number; out: number; count: number }> = {};
    for (const t of transfers) {
      const b = (byAsset[t.asset] ??= { in: 0, out: 0, count: 0 });
      b.count++;
      if (norm(t.to) === addr) (totalIn += t.amount), (b.in += t.amount);
      if (norm(t.from) === addr) (totalOut += t.amount), (b.out += t.amount);
    }
    const wanted = selectAssets(chain, asset).map((d) => d.asset);
    const times = transfers.map((t) => t.timestamp);
    const fl = flows(addr, transfers).slice(0, 25);
    const cpLabels = await this.labels.lookup(chain, fl.map((f) => f.address), orgId);
    // Coverage is read after getTransfers, so a first visit already shows "indexing". Lifetime numbers only when the whole history is stored.
    const cov = await this.index.coverage(chain, addr);
    const lifetime = cov?.status === 'complete' && wanted.every((a) => cov.assets.split(',').includes(a)) ? await this.index.lifetime(chain, addr, wanted) : null;
    return {
      chain,
      address: addr,
      asset,
      assets: assetsOf(chain).map((d) => ({ asset: d.asset, symbol: d.symbol, decimals: d.decimals, issuer: d.issuer, note: d.note ?? null })),
      balance: wanted.reduce((s, a) => s + balances[a], 0), // USD-equivalent of the selected assets (USDT and USDC are both ~ $1)
      balances,
      frozen: risk.frozen,
      frozenBy: frozenBy(chain, frozenMap),
      frozenAssets: frozenMap, // per asset: true | false | null (null = no issuer freeze exists, e.g. BSC pegged tokens)
      byAsset,
      totalIn,
      totalOut,
      txCount: transfers.length,
      truncated: transfers.length >= limit, // totals cover only the fetched window when true
      firstSeen: times.length ? Math.min(...times) : null,
      lastSeen: times.length ? Math.max(...times) : null,
      risk,
      counterparties: fl.map((f) => ({ ...f, label: topLabel(cpLabels.get(f.address) ?? []) })),
      transfers,
      coverage: cov && { status: cov.status, assets: cov.assets, rowCount: cov.rowCount, newestTs: cov.newestTs === null ? null : Number(cov.newestTs), lastSyncAt: cov.lastSyncAt },
      lifetime,
      serviceScale: isServiceScale(cov), // 8.17 heuristic, not a label
    };
  }

  @Perm('investigate.view')
  @Get('address/:addr')
  address(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string, @Query('limit') limitRaw?: string, @Query('deep') deep?: string, @Query('chain') c?: string, @Query('asset') asset?: string) {
    const { chain, addr } = parseAddr(raw, c);
    return this.summary(chain, addr, int(limitRaw, 200, 1, 2000), ctx.orgId, deep === 'true', assetParam(asset));
  }

  @Perm('export.data')
  @Get('address/:addr/report.csv')
  async addressCsv(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string, @Res() res: Response, @Query('chain') c?: string, @Query('asset') asset?: string) {
    const { chain, addr } = parseAddr(raw, c);
    const s = await this.summary(chain, addr, 2000, ctx.orgId, true, assetParam(asset));
    await audit(this.db, ctx, 'address.export', `${chain}:${addr}`);
    const rows = [
      ['Tracera address report'],
      ['address', addr],
      ['chain', chain],
      ['generated_at', new Date().toISOString()],
      ['asset_filter', s.asset],
      ...s.assets.map((d) => [`balance_${d.asset}`, s.balances[d.asset]]),
      ['risk_score', s.risk.score],
      ['risk_level', s.risk.level],
      ['frozen_by_issuer', s.frozenBy.join('; ') || 'no'],
      ['labels', s.risk.labels.map((l) => `${l.name} (${l.category}, ${l.source})`).join('; ')],
      ...s.risk.reasons.map((r) => ['reason', r]),
      ['transfers_included', s.txCount, s.truncated ? 'latest only — wallet has more history' : 'complete'],
      [],
      ['time_utc', 'direction', 'from', 'to', 'asset', 'amount', 'tx_hash'],
      ...s.transfers.map((t) => [new Date(t.timestamp).toISOString(), norm(t.to) === addr ? 'IN' : 'OUT', t.from, t.to, t.asset.toUpperCase(), t.amount, t.hash]),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${chain}-${addr}.csv"`);
    res.send(toCsv(rows));
  }

  @Perm('investigate.view')
  @Get('tx/:chain/:hash')
  async tx(@CurrentCtx() ctx: Ctx, @Param('chain') chain: Chain, @Param('hash') hash: string) {
    oneOf(chain, 'chain', CHAINS);
    if (!isTxHash(chain, hash)) throw new BadRequestException(`Not a valid ${chain} transaction hash`);
    const tx = await getTx(chain, hash);
    return { ...tx, swaps: await swapsOfTx(this.labels, tx, ctx.orgId) }; // 7.14: evidence from this one tx (native payout / dex label)
  }

  @Perm('investigate.view')
  @Get('graph/:addr')
  async graph(
    @CurrentCtx() ctx: Ctx,
    @Param('addr') raw: string,
    @Query('depth') depth?: string,
    @Query('fanout') fanout?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('min') min?: string,
    @Query('transfers') transfers?: string,
    @Query('chain') c?: string,
    @Query('asset') asset?: string,
  ) {
    const { chain, addr } = parseAddr(raw, c);
    const filter = { from: time(from), to: time(to), min: min ? Number(min) : undefined };
    if (filter.min !== undefined && Number.isNaN(filter.min)) throw new BadRequestException('min must be a number');
    const withT = transfers === 'true';
    const g = await buildGraph(addr, int(depth, 1, 1, 3), int(fanout, 8, 1, 15), flowsFor(chain, filter, withT, addr, assetParam(asset)));
    const nodes = await this.labelNodes(chain, withT ? withVolumes(g.nodes, g.edges) : g.nodes, ctx.orgId);
    return { chain, asset: assetParam(asset), nodes, edges: g.edges };
  }

  @Perm('investigate.view')
  @Get('path')
  async path(@CurrentCtx() ctx: Ctx, @Query('from') fromRaw: string, @Query('to') toRaw: string, @Query('maxHops') maxHops?: string, @Query('fanout') fanout?: string, @Query('transfers') transfers?: string, @Query('chain') c?: string, @Query('asset') asset?: string) {
    const a = parseAddr(fromRaw, c);
    const b = parseAddr(toRaw, c);
    if (a.chain !== b.chain) throw new BadRequestException('Both addresses must be on the same chain');
    if (a.addr === b.addr) throw new BadRequestException('From and to are the same address');
    const withT = transfers === 'true';
    const r = await findPath(a.addr, b.addr, int(maxHops, 4, 1, 6), int(fanout, 10, 1, 25), flowsFor(a.chain, {}, withT, a.addr, assetParam(asset)));
    return { chain: a.chain, ...r, nodes: await this.labelNodes(a.chain, withT ? withVolumes(r.nodes, r.edges) : r.nodes, ctx.orgId) };
  }
}
