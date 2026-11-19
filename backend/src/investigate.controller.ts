import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { Chain, detectChain, flows, getBalance, getTransfers, getTx, isTetherFrozen, isTxHash, norm, Transfer } from './chains';
import { buildGraph, findPath, GetFlows } from './graph';

// ponytail: graph/path read only the latest 200 transfers per node. The Phase 7 indexer lifts this.
const PER_NODE = 200;

function parseAddr(raw: string): { chain: Chain; addr: string } {
  const chain = detectChain(raw?.trim() ?? '');
  if (!chain) throw new BadRequestException('Not a valid Tron (T…) or Ethereum (0x…) address');
  return { chain, addr: norm(raw.trim()) };
}

function int(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new BadRequestException(`Expected an integer, got "${raw}"`);
  return Math.min(max, Math.max(min, n));
}

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

function flowsFor(chain: Chain, f: Filter): GetFlows {
  return async (a) => flows(a, applyFilter(await getTransfers(chain, a, PER_NODE), f));
}

@Controller()
export class InvestigateController {
  @Get('address/:addr')
  async address(@Param('addr') raw: string, @Query('limit') limitRaw?: string) {
    const { chain, addr } = parseAddr(raw);
    const limit = int(limitRaw, 1000, 1, 2000);
    const transfers = await getTransfers(chain, addr, limit);
    const [balance, frozen] = await Promise.all([getBalance(chain, addr), isTetherFrozen(chain, addr)]);
    let totalIn = 0;
    let totalOut = 0;
    for (const t of transfers) {
      if (norm(t.to) === addr) totalIn += t.amount;
      if (norm(t.from) === addr) totalOut += t.amount;
    }
    const times = transfers.map((t) => t.timestamp);
    return {
      chain,
      address: addr,
      balance,
      frozen,
      totalIn,
      totalOut,
      txCount: transfers.length,
      // Totals cover only the fetched window when this is true.
      truncated: transfers.length >= limit,
      firstSeen: times.length ? Math.min(...times) : null,
      lastSeen: times.length ? Math.max(...times) : null,
      counterparties: flows(addr, transfers).slice(0, 25),
      transfers,
    };
  }

  @Get('tx/:chain/:hash')
  async tx(@Param('chain') chain: string, @Param('hash') hash: string) {
    if (chain !== 'tron' && chain !== 'eth') throw new BadRequestException('chain must be "tron" or "eth"');
    if (!isTxHash(chain, hash)) throw new BadRequestException(`Not a valid ${chain} transaction hash`);
    return getTx(chain, hash);
  }

  @Get('graph/:addr')
  async graph(
    @Param('addr') raw: string,
    @Query('depth') depth?: string,
    @Query('fanout') fanout?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('min') min?: string,
  ) {
    const { chain, addr } = parseAddr(raw);
    const filter = { from: time(from), to: time(to), min: min ? Number(min) : undefined };
    if (filter.min !== undefined && Number.isNaN(filter.min)) throw new BadRequestException('min must be a number');
    const g = await buildGraph(addr, int(depth, 1, 1, 3), int(fanout, 8, 1, 15), flowsFor(chain, filter));
    return { chain, ...g };
  }

  @Get('path')
  async path(@Query('from') fromRaw: string, @Query('to') toRaw: string, @Query('maxHops') maxHops?: string, @Query('fanout') fanout?: string) {
    const a = parseAddr(fromRaw);
    const b = parseAddr(toRaw);
    if (a.chain !== b.chain) throw new BadRequestException('Both addresses must be on the same chain');
    if (a.addr === b.addr) throw new BadRequestException('From and to are the same address');
    const r = await findPath(a.addr, b.addr, int(maxHops, 4, 1, 6), int(fanout, 10, 1, 25), flowsFor(a.chain, {}));
    return { chain: a.chain, ...r };
  }
}
