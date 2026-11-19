import { BadRequestException, Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentCtx, Perm } from './auth';
import { Chain, flows, getBalance, getTransfers, getTx, isTetherFrozen, isTxHash, norm, Transfer } from './chains';
import { audit, Ctx, Db } from './db';
import { buildGraph, findPath, GetFlows, GraphNode, withVolumes } from './graph';
import { LabelsService } from './labels';
import { RiskService } from './risk';
import { topLabel } from './risk-score';
import { int, parseAddr, toCsv } from './util';

// ponytail: graph/path read only the latest 200 transfers per node. The Phase 7 indexer lifts this.
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

function flowsFor(chain: Chain, f: Filter, withTransfers: boolean): GetFlows {
  return async (a) => flows(a, applyFilter(await getTransfers(chain, a, PER_NODE), f), withTransfers);
}

@Controller()
export class InvestigateController {
  constructor(
    private db: Db,
    private labels: LabelsService,
    private risk: RiskService,
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
  private async summary(chain: Chain, addr: string, limit: number, orgId: number, deep = false) {
    const [transfers, balance, frozenLive] = await Promise.all([getTransfers(chain, addr, limit), getBalance(chain, addr), isTetherFrozen(chain, addr)]);
    const risk = await this.risk.assess(chain, addr, orgId, { transfers, deep, frozen: frozenLive });
    let totalIn = 0;
    let totalOut = 0;
    for (const t of transfers) {
      if (norm(t.to) === addr) totalIn += t.amount;
      if (norm(t.from) === addr) totalOut += t.amount;
    }
    const times = transfers.map((t) => t.timestamp);
    const fl = flows(addr, transfers).slice(0, 25);
    const cpLabels = await this.labels.lookup(chain, fl.map((f) => f.address), orgId);
    return {
      chain,
      address: addr,
      balance,
      frozen: risk.frozen,
      totalIn,
      totalOut,
      txCount: transfers.length,
      truncated: transfers.length >= limit, // totals cover only the fetched window when true
      firstSeen: times.length ? Math.min(...times) : null,
      lastSeen: times.length ? Math.max(...times) : null,
      risk,
      counterparties: fl.map((f) => ({ ...f, label: topLabel(cpLabels.get(f.address) ?? []) })),
      transfers,
    };
  }

  @Perm('investigate.view')
  @Get('address/:addr')
  address(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string, @Query('limit') limitRaw?: string, @Query('deep') deep?: string) {
    const { chain, addr } = parseAddr(raw);
    return this.summary(chain, addr, int(limitRaw, 200, 1, 2000), ctx.orgId, deep === 'true');
  }

  @Perm('export.data')
  @Get('address/:addr/report.csv')
  async addressCsv(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string, @Res() res: Response) {
    const { chain, addr } = parseAddr(raw);
    const s = await this.summary(chain, addr, 2000, ctx.orgId, true);
    await audit(this.db, ctx, 'address.export', `${chain}:${addr}`);
    const rows = [
      ['USDT Trace address report'],
      ['address', addr],
      ['chain', chain],
      ['generated_at', new Date().toISOString()],
      ['balance_usdt', s.balance],
      ['risk_score', s.risk.score],
      ['risk_level', s.risk.level],
      ['frozen_by_tether', s.frozen],
      ['labels', s.risk.labels.map((l) => `${l.name} (${l.category}, ${l.source})`).join('; ')],
      ...s.risk.reasons.map((r) => ['reason', r]),
      ['transfers_included', s.txCount, s.truncated ? 'latest only — wallet has more history' : 'complete'],
      [],
      ['time_utc', 'direction', 'from', 'to', 'amount_usdt', 'tx_hash'],
      ...s.transfers.map((t) => [new Date(t.timestamp).toISOString(), norm(t.to) === addr ? 'IN' : 'OUT', t.from, t.to, t.amount, t.hash]),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${chain}-${addr}.csv"`);
    res.send(toCsv(rows));
  }

  @Perm('investigate.view')
  @Get('tx/:chain/:hash')
  tx(@Param('chain') chain: string, @Param('hash') hash: string) {
    if (chain !== 'tron' && chain !== 'eth') throw new BadRequestException('chain must be "tron" or "eth"');
    if (!isTxHash(chain, hash)) throw new BadRequestException(`Not a valid ${chain} transaction hash`);
    return getTx(chain, hash);
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
  ) {
    const { chain, addr } = parseAddr(raw);
    const filter = { from: time(from), to: time(to), min: min ? Number(min) : undefined };
    if (filter.min !== undefined && Number.isNaN(filter.min)) throw new BadRequestException('min must be a number');
    const withT = transfers === 'true';
    const g = await buildGraph(addr, int(depth, 1, 1, 3), int(fanout, 8, 1, 15), flowsFor(chain, filter, withT));
    const nodes = await this.labelNodes(chain, withT ? withVolumes(g.nodes, g.edges) : g.nodes, ctx.orgId);
    return { chain, nodes, edges: g.edges };
  }

  @Perm('investigate.view')
  @Get('path')
  async path(@CurrentCtx() ctx: Ctx, @Query('from') fromRaw: string, @Query('to') toRaw: string, @Query('maxHops') maxHops?: string, @Query('fanout') fanout?: string, @Query('transfers') transfers?: string) {
    const a = parseAddr(fromRaw);
    const b = parseAddr(toRaw);
    if (a.chain !== b.chain) throw new BadRequestException('Both addresses must be on the same chain');
    if (a.addr === b.addr) throw new BadRequestException('From and to are the same address');
    const withT = transfers === 'true';
    const r = await findPath(a.addr, b.addr, int(maxHops, 4, 1, 6), int(fanout, 10, 1, 25), flowsFor(a.chain, {}, withT));
    return { chain: a.chain, ...r, nodes: await this.labelNodes(a.chain, withT ? withVolumes(r.nodes, r.edges) : r.nodes, ctx.orgId) };
  }
}
