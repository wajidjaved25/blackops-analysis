import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Logger, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { Label } from '@prisma/client';
import { CurrentCtx, Roles } from './auth';
import { Chain, detectChain, ethFreezeEvents, hasEtherscanKey, norm, tronFreezeEvents } from './chains';
import { audit, Ctx, Db } from './db';
import { Jobs } from './jobs';
import { CATEGORIES } from './risk-score';
import { id, int, oneOf, parseCsv, str } from './util';

const OFAC_LISTS = ['USDT', 'TRX', 'ETH'].map(
  (s) => `https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_${s}.txt`,
);
const DAY = 86_400_000;

export type LabelLite = Pick<Label, 'name' | 'category' | 'source' | 'confidence'>;

@Injectable()
export class LabelsService implements OnModuleInit {
  private log = new Logger('Labels');
  constructor(
    private db: Db,
    private jobs: Jobs,
  ) {}

  onModuleInit() {
    // Daily OFAC refresh, Tether freeze sync every 30 minutes. Both are cheap no-ops when up to date.
    this.jobs.every('ofac-sync', 60 * 60_000, async () => {
      const last = Number((await this.getSetting('ofac.lastSync')) ?? 0);
      if (Date.now() - last > DAY) await this.syncOfac();
    });
    this.jobs.every('tether-sync', 30 * 60_000, () => this.syncTether(), 15_000);
  }

  /** Labels for many addresses on one chain, visible to the org (global + its own). */
  async lookup(chain: Chain, addresses: string[], orgId: number): Promise<Map<string, LabelLite[]>> {
    const m = new Map<string, LabelLite[]>();
    if (!addresses.length) return m;
    const rows = await this.db.label.findMany({
      where: { chain, address: { in: [...new Set(addresses.map(norm))] }, orgId: { in: [0, orgId] } },
      select: { address: true, name: true, category: true, source: true, confidence: true },
    });
    for (const r of rows) m.set(r.address, [...(m.get(r.address) ?? []), r]);
    return m;
  }

  async getSetting(key: string) {
    return (await this.db.setting.findUnique({ where: { key } }))?.value;
  }
  setSetting(key: string, value: string) {
    return this.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  async syncOfac() {
    const found = new Map<string, Chain>();
    for (const url of OFAC_LISTS) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OFAC list ${url} returned HTTP ${res.status}`);
      for (const line of (await res.text()).split(/\r?\n/)) {
        const chain = detectChain(line.trim());
        if (chain) found.set(norm(line.trim()), chain);
      }
    }
    if (!found.size) throw new Error('OFAC lists were empty — keeping existing labels');
    await this.db.label.createMany({
      data: [...found].map(([address, chain]) => ({ chain, address, name: 'OFAC SDN list', category: 'sanctioned', source: 'ofac', orgId: 0 })),
      skipDuplicates: true,
    });
    const removed = await this.db.label.deleteMany({ where: { source: 'ofac', address: { notIn: [...found.keys()] } } });
    await this.setSetting('ofac.lastSync', String(Date.now()));
    this.log.log(`OFAC sync: ${found.size} addresses (${removed.count} delisted)`);
    return { addresses: found.size, removed: removed.count };
  }

  private async applyFreeze(chain: Chain, events: { address: string; added: boolean }[]) {
    for (const e of events) {
      const where = { chain_address_source_orgId: { chain, address: e.address, source: 'tether', orgId: 0 } };
      if (e.added) {
        await this.db.label.upsert({ where, create: { chain, address: e.address, name: 'Frozen by Tether', category: 'frozen', source: 'tether', orgId: 0 }, update: {} });
      } else {
        await this.db.label.deleteMany({ where: { chain, address: e.address, source: 'tether', orgId: 0 } });
      }
    }
  }

  private tetherRun: Promise<unknown> | null = null;

  /** Imports Tether's freeze/unfreeze events since the last cursor. Safe to re-run; concurrent calls share one run. */
  syncTether() {
    this.tetherRun ??= this.doSyncTether().finally(() => (this.tetherRun = null));
    return this.tetherRun;
  }

  private async doSyncTether() {
    const out = { tron: 0, eth: 0 as number | string };
    // Tron: everything since the cursor (events at the cursor itself are re-applied; that is idempotent).
    const cursor = Number((await this.getSetting('tether.tron.ts')) ?? 0);
    const tronEvents = await tronFreezeEvents(cursor);
    await this.applyFreeze('tron', tronEvents);
    out.tron = tronEvents.length;
    if (tronEvents.length) await this.setSetting('tether.tron.ts', String(tronEvents[tronEvents.length - 1].ts));
    // Ethereum: needs an Etherscan key.
    if (hasEtherscanKey()) {
      let from = Number((await this.getSetting('tether.eth.block')) ?? 0);
      out.eth = 0;
      for (let page = 0; page < 50; page++) {
        const r = await ethFreezeEvents(from);
        await this.applyFreeze('eth', r.events);
        out.eth += r.events.length;
        if (r.events.length) from = r.events[r.events.length - 1].ts; // same block re-read next time is harmless
        await this.setSetting('tether.eth.block', String(from));
        if (!r.full) break;
      }
    } else out.eth = 'skipped (no ETHERSCAN_API_KEY)';
    await this.setSetting('tether.lastSync', String(Date.now()));
    this.log.log(`Tether sync: tron +${out.tron} events, eth ${out.eth}`);
    return out;
  }

  /** Validate CSV rows `address,name,category[,confidence]` (chain auto-detected). */
  parseImport(csv: string) {
    const rows = parseCsv(csv);
    if (rows[0]?.[0]?.trim().toLowerCase() === 'address') rows.shift();
    if (rows.length > 20000) throw new BadRequestException('Max 20,000 rows per import');
    return rows.map((r, i) => {
      const [address = '', name = '', category = '', confidence = ''] = r.map((c) => c.trim());
      const chain = detectChain(address);
      const conf = confidence === '' ? 1 : Number(confidence);
      const error = !chain
        ? 'invalid address'
        : !name
          ? 'missing name'
          : name.length > 200
            ? 'name too long'
            : !CATEGORIES.includes(category)
              ? `category must be one of ${CATEGORIES.join('/')}`
              : !(conf >= 0 && conf <= 1)
                ? 'confidence must be 0..1'
                : null;
      return { line: i + 1, chain, address: chain ? norm(address) : address, name, category, confidence: conf, error };
    });
  }
}

@Controller('labels')
export class LabelsController {
  constructor(
    private db: Db,
    private labels: LabelsService,
  ) {}

  @Get()
  async list(@CurrentCtx() ctx: Ctx, @Query('q') q?: string, @Query('category') category?: string, @Query('source') source?: string, @Query('page') page?: string) {
    const p = int(page, 0, 0, 10000);
    const where = {
      orgId: { in: [0, ctx.orgId] },
      ...(q ? { OR: [{ address: { contains: q.trim(), mode: 'insensitive' as const } }, { name: { contains: q.trim(), mode: 'insensitive' as const } }] } : {}),
      ...(category ? { category } : {}),
      ...(source ? { source } : {}),
    };
    const [rows, total] = await Promise.all([this.db.label.findMany({ where, orderBy: { id: 'desc' }, skip: p * 100, take: 100 }), this.db.label.count({ where })]);
    return { rows, total, page: p, pageSize: 100 };
  }

  @Get('status')
  async status(@CurrentCtx() ctx: Ctx) {
    const bySource = await this.db.label.groupBy({ by: ['source'], where: { orgId: { in: [0, ctx.orgId] } }, _count: true });
    const s = (k: string) => this.labels.getSetting(k).then((v) => (v ? Number(v) : null));
    return {
      counts: Object.fromEntries(bySource.map((r) => [r.source, r._count])),
      ofacLastSync: await s('ofac.lastSync'),
      tetherLastSync: await s('tether.lastSync'),
      etherscanKey: hasEtherscanKey(),
      categories: CATEGORIES,
    };
  }

  @Get('address/:addr')
  async forAddress(@CurrentCtx() ctx: Ctx, @Param('addr') addr: string) {
    const chain = detectChain(addr);
    if (!chain) throw new BadRequestException('Invalid address');
    return this.db.label.findMany({ where: { chain, address: norm(addr), orgId: { in: [0, ctx.orgId] } } });
  }

  @Post()
  async create(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const address = str(b.address, 'address');
    const chain = detectChain(address);
    if (!chain) throw new BadRequestException('Invalid address');
    const data = { chain, address: norm(address), name: str(b.name, 'name', { max: 200 }), category: oneOf(b.category, 'category', CATEGORIES), source: 'manual', orgId: ctx.orgId };
    const l = await this.db.label.upsert({
      where: { chain_address_source_orgId: { chain, address: data.address, source: 'manual', orgId: ctx.orgId } },
      create: data,
      update: { name: data.name, category: data.category },
    });
    await audit(this.db, ctx, 'label.create', `${chain}:${data.address}`, { name: data.name, category: data.category });
    return l;
  }

  @Delete(':id')
  async remove(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const l = await this.db.label.findUnique({ where: { id: id(raw) } });
    if (!l || (l.orgId !== ctx.orgId && l.orgId !== 0)) throw new BadRequestException('Label not found');
    if (l.orgId === 0) throw new ForbiddenException('Global labels (OFAC, Tether, public imports) are read-only');
    await this.db.label.delete({ where: { id: l.id } });
    await audit(this.db, ctx, 'label.delete', `${l.chain}:${l.address}`, { name: l.name });
    return { ok: true };
  }

  /** CSV import: with dryRun=true returns a preview; otherwise inserts valid rows as source "import". */
  @Post('import')
  async import(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const rows = this.labels.parseImport(str(b.csv, 'csv', { max: 5_000_000 }));
    const valid = rows.filter((r) => !r.error);
    if (b.dryRun) return { total: rows.length, valid: valid.length, errors: rows.filter((r) => r.error).slice(0, 200), preview: valid.slice(0, 20) };
    const r = await this.db.label.createMany({
      data: valid.map((v) => ({ chain: v.chain!, address: v.address, name: v.name, category: v.category, confidence: v.confidence, source: 'import', orgId: ctx.orgId })),
      skipDuplicates: true,
    });
    await audit(this.db, ctx, 'label.import', `labels`, { inserted: r.count, rows: rows.length });
    return { inserted: r.count, skipped: rows.length - r.count };
  }

  @Roles('admin')
  @Post('sync')
  async sync(@Body() b: any) {
    const which = oneOf(b.source, 'source', ['ofac', 'tether'] as const);
    try {
      return which === 'ofac' ? await this.labels.syncOfac() : await this.labels.syncTether();
    } catch (e) {
      throw new BadRequestException(`Sync failed: ${(e as Error).message}`);
    }
  }
}
