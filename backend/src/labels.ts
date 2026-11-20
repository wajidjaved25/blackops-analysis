import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Logger, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { Label } from '@prisma/client';
import { issuerName } from './assets';
import { CurrentCtx, Perm } from './auth';
import { Chain, detectChain, ethFreezeEvents, hasEtherscanKey, norm, tronFreezeEvents } from './chains';
import { audit, Ctx, Db } from './db';
import { Jobs } from './jobs';
import { CATEGORIES } from './risk-score';
import { assertPublicUrl, id, int, oneOf, parseCsv, str } from './util';

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
    // Daily OFAC refresh, Tether and Circle freeze syncs every 30 minutes. All are cheap no-ops when up to date.
    this.jobs.every('ofac-sync', 60 * 60_000, async () => {
      const last = Number((await this.getSetting('ofac.lastSync')) ?? 0);
      if (Date.now() - last > DAY) await this.syncOfac();
    });
    this.jobs.every('tether-sync', 30 * 60_000, () => this.syncTether(), 15_000);
    this.jobs.every('circle-sync', 30 * 60_000, () => this.syncCircle(), 45_000);
  }

  /** Labels for many addresses on one chain, visible to the org (global + its own). */
  async lookup(chain: Chain, addresses: string[], orgId: number): Promise<Map<string, LabelLite[]>> {
    const m = new Map<string, LabelLite[]>();
    if (!addresses.length) return m;
    // BNB Chain shares 0x addresses with Ethereum: sanctions and user labels carry over, issuer freezes (Tether/Circle on Ethereum) do not.
    const chainWhere = chain === 'bsc' ? { OR: [{ chain: 'bsc' }, { chain: 'eth', source: { notIn: ['tether', 'circle'] } }] } : { chain };
    const rows = await this.db.label.findMany({
      where: { ...chainWhere, address: { in: [...new Set(addresses.map(norm))] }, orgId: { in: [0, orgId] } },
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

  private async applyFreeze(issuer: 'tether' | 'circle', chain: Chain, events: { address: string; added: boolean }[]) {
    for (const e of events) {
      const where = { chain_address_source_orgId: { chain, address: e.address, source: issuer, orgId: 0 } };
      if (e.added) {
        await this.db.label.upsert({ where, create: { chain, address: e.address, name: `Frozen by ${issuerName[issuer]}`, category: 'frozen', source: issuer, orgId: 0 }, update: {} });
      } else {
        await this.db.label.deleteMany({ where: { chain, address: e.address, source: issuer, orgId: 0 } });
      }
    }
  }

  private runs: Partial<Record<'tether' | 'circle', Promise<unknown>>> = {};

  /** Imports Tether's freeze/unfreeze events since the last cursor. Safe to re-run; concurrent calls share one run. */
  syncTether() {
    return this.syncIssuer('tether');
  }
  /** Same for Circle's USDC blacklist (Blacklisted / UnBlacklisted events). */
  syncCircle() {
    return this.syncIssuer('circle');
  }
  private syncIssuer(issuer: 'tether' | 'circle') {
    this.runs[issuer] ??= this.doSyncIssuer(issuer).finally(() => delete this.runs[issuer]);
    return this.runs[issuer];
  }

  private async doSyncIssuer(issuer: 'tether' | 'circle') {
    const out = { tron: 0, eth: 0 as number | string };
    // Tron: everything since the cursor (events at the cursor itself are re-applied; that is idempotent).
    const cursor = Number((await this.getSetting(`${issuer}.tron.ts`)) ?? 0);
    const tronEvents = await tronFreezeEvents(issuer, cursor);
    await this.applyFreeze(issuer, 'tron', tronEvents);
    out.tron = tronEvents.length;
    if (tronEvents.length) await this.setSetting(`${issuer}.tron.ts`, String(tronEvents[tronEvents.length - 1].ts));
    // Ethereum: needs an Etherscan key.
    if (hasEtherscanKey()) {
      let from = Number((await this.getSetting(`${issuer}.eth.block`)) ?? 0);
      out.eth = 0;
      for (let page = 0; page < 50; page++) {
        const r = await ethFreezeEvents(issuer, from);
        await this.applyFreeze(issuer, 'eth', r.events);
        out.eth += r.events.length;
        if (r.events.length) from = r.events[r.events.length - 1].ts; // same block re-read next time is harmless
        await this.setSetting(`${issuer}.eth.block`, String(from));
        if (!r.full) break;
      }
    } else out.eth = 'skipped (no ETHERSCAN_API_KEY)';
    await this.setSetting(`${issuer}.lastSync`, String(Date.now()));
    this.log.log(`${issuerName[issuer]} sync: tron +${out.tron} events, eth ${out.eth}`);
    return out;
  }

  /** Text body of a URL, capped at 5 MB and 15 s. Redirects are refused (they could point at an internal address). */
  async download(url: URL): Promise<string> {
    const MAX = 5_000_000;
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'text/csv,text/plain' } });
    } catch (e) {
      throw new BadRequestException(`Could not download ${url.host}: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) throw new BadRequestException('The URL redirects somewhere else; use the final URL directly');
    if (!res.ok || !res.body) throw new BadRequestException(`${url.host} returned HTTP ${res.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += c.length;
        if (size > MAX) throw new BadRequestException('The file is larger than 5 MB');
        chunks.push(c);
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`Download failed: ${(e as Error).message}`);
    }
    return Buffer.concat(chunks).toString('utf8');
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

  @Perm('labels.view')
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

  @Perm('labels.view')
  @Get('status')
  async status(@CurrentCtx() ctx: Ctx) {
    const bySource = await this.db.label.groupBy({ by: ['source'], where: { orgId: { in: [0, ctx.orgId] } }, _count: true });
    const s = (k: string) => this.labels.getSetting(k).then((v) => (v ? Number(v) : null));
    return {
      counts: Object.fromEntries(bySource.map((r) => [r.source, r._count])),
      ofacLastSync: await s('ofac.lastSync'),
      tetherLastSync: await s('tether.lastSync'),
      circleLastSync: await s('circle.lastSync'),
      etherscanKey: hasEtherscanKey(),
      categories: CATEGORIES,
    };
  }

  @Perm('labels.view')
  @Get('address/:addr')
  async forAddress(@CurrentCtx() ctx: Ctx, @Param('addr') addr: string) {
    const chain = detectChain(addr);
    if (!chain) throw new BadRequestException('Invalid address');
    return this.db.label.findMany({ where: { chain, address: norm(addr), orgId: { in: [0, ctx.orgId] } } });
  }

  @Perm('labels.manage')
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

  @Perm('labels.manage')
  @Delete(':id')
  async remove(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const l = await this.db.label.findUnique({ where: { id: id(raw) } });
    if (!l || (l.orgId !== ctx.orgId && l.orgId !== 0)) throw new BadRequestException('Label not found');
    if (l.orgId === 0) throw new ForbiddenException('Global labels (OFAC, Tether, public imports) are read-only');
    await this.db.label.delete({ where: { id: l.id } });
    await audit(this.db, ctx, 'label.delete', `${l.chain}:${l.address}`, { name: l.name });
    return { ok: true };
  }

  /** Dry run returns a preview; otherwise inserts the valid rows as source "import" (private to the org, or global when `orgId` is 0). */
  private async importRows(ctx: Ctx, rows: ReturnType<LabelsService['parseImport']>, dryRun: boolean, orgId: number, via: string) {
    const valid = rows.filter((r) => !r.error);
    if (dryRun) return { total: rows.length, valid: valid.length, errors: rows.filter((r) => r.error).slice(0, 200), preview: valid.slice(0, 20) };
    const r = await this.db.label.createMany({
      data: valid.map((v) => ({ chain: v.chain!, address: v.address, name: v.name, category: v.category, confidence: v.confidence, source: 'import', orgId })),
      skipDuplicates: true,
    });
    await audit(this.db, ctx, 'label.import', via, { inserted: r.count, rows: rows.length, global: orgId === 0 });
    return { inserted: r.count, skipped: rows.length - r.count };
  }

  @Perm('labels.manage')
  @Post('import')
  import(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    return this.importRows(ctx, this.labels.parseImport(str(b.csv, 'csv', { max: 5_000_000 })), !!b.dryRun, ctx.orgId, 'labels');
  }

  /** Fetches a CSV from a public URL (http/https, 5 MB, 15 s, no redirects) and imports it as global labels. */
  @Perm('labels.sync')
  @Post('import-url')
  async importUrl(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const url = await assertPublicUrl(str(b.url, 'url', { max: 2000 }));
    const text = await this.labels.download(url);
    return this.importRows(ctx, this.labels.parseImport(text), !!b.dryRun, 0, `url:${url.host}`);
  }

  @Perm('labels.sync')
  @Post('sync')
  async sync(@Body() b: any) {
    const which = oneOf(b.source, 'source', ['ofac', 'tether', 'circle'] as const);
    try {
      return which === 'ofac' ? await this.labels.syncOfac() : which === 'tether' ? await this.labels.syncTether() : await this.labels.syncCircle();
    } catch (e) {
      throw new BadRequestException(`Sync failed: ${(e as Error).message}`);
    }
  }
}
