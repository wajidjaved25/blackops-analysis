import { BadRequestException, Body, Controller, Delete, Get, Injectable, Logger, OnModuleInit, Param, Patch, Post, Query } from '@nestjs/common';
import { Alert, Prisma } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { CurrentCtx, Perm } from './auth';
import { Chain, getTransfers } from './chains';
import { audit, Ctx, Db } from './db';
import { Jobs } from './jobs';
import { LabelsService } from './labels';
import { Hit, evaluateRiskChange, evaluateRules, riskSnap, RiskSnap, RULE_TYPES, ruleParams } from './monitor-rules';
import { RiskService } from './risk';
import { assertPublicUrl, extractAddresses, found, id, int, oneOf, str } from './util';

const ALERT_STATUSES = ['open', 'reviewing', 'closed'] as const;

/** Webhook URLs can embed secrets (tokens in the path/query), so logs only ever show the host. */
const safeHost = (url: string) => { try { return new URL(url).host; } catch { return 'invalid-url'; } };

@Injectable()
export class Notifier {
  private log = new Logger('Notifier');
  private mailer = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
    : null;

  constructor(private db: Db) {}

  async alertCreated(a: Alert) {
    const targets = await this.db.notifyTarget.findMany({ where: { orgId: a.orgId } });
    const payload = { event: 'alert.created', alert: { id: a.id, chain: a.chain, address: a.address, counterparty: a.counterparty, amount: a.amount, txHash: a.txHash, detail: a.detail, createdAt: a.createdAt } };
    await Promise.all(targets.map((t) => (t.type === 'webhook' ? this.webhook(t.target, t.secret ?? '', payload) : this.email(t.target, a))));
  }

  /** POST JSON; header X-USDT-Trace-Signature: sha256=<hex HMAC of the raw body with the target secret>. */
  async webhook(url: string, secret: string, payload: object) {
    const body = JSON.stringify(payload);
    try {
      await assertPublicUrl(url);
      const r = await fetch(url, {
        redirect: 'manual', // a redirect could point at an internal address
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-usdt-trace-signature': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) this.log.warn(`webhook ${new URL(url).host} returned HTTP ${r.status}`);
      return r.ok;
    } catch (e) {
      this.log.warn(`webhook ${safeHost(url)} failed: ${(e as Error).message}`);
      return false;
    }
  }

  async email(to: string, a: Alert) {
    if (!this.mailer) return this.log.warn(`email to ${to} skipped: SMTP_HOST not set`);
    try {
      await this.mailer.sendMail({
        from: process.env.SMTP_FROM ?? 'USDT Trace <alerts@localhost>',
        to,
        subject: `[USDT Trace] Alert on ${a.address.slice(0, 10)}…: ${a.detail.slice(0, 80)}`,
        text: `${a.detail}\n\nWallet: ${a.address} (${a.chain})\nCounterparty: ${a.counterparty ?? '—'}\nTransaction: ${a.txHash ?? '—'}\nTime: ${a.createdAt.toISOString()}\n\nOpen the alerts inbox in USDT Trace to review.`,
      });
    } catch (e) {
      this.log.warn(`email to ${to} failed: ${(e as Error).message}`);
    }
  }
}

@Injectable()
export class MonitorService implements OnModuleInit {
  private log = new Logger('Monitor');
  constructor(
    private db: Db,
    private jobs: Jobs,
    private labels: LabelsService,
    private notifier: Notifier,
    private risk: RiskService,
  ) {}

  onModuleInit() {
    const sec = Number(process.env.MONITOR_INTERVAL_SEC ?? 120);
    this.jobs.every('monitor', sec * 1000, () => this.poll(), 20_000);
  }

  /** Checks every watched address once (oldest-checked first). Returns number of new alerts. */
  async poll(orgId?: number): Promise<{ checked: number; alerts: number }> {
    const items = await this.db.watchItem.findMany({
      where: orgId ? { watchlist: { orgId } } : {},
      include: { watchlist: { include: { rules: { where: { enabled: true } } } } },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
    });
    // Risk re-scores are expensive (up to 500 transfers + label lookups per wallet): only wallets whose last score is older than
    // RISK_RECHECK_SEC (default 1 h) are due, and at most RISK_MAX_PER_POLL (default 5, longest-waiting first) run per pass.
    const every = Number(process.env.RISK_RECHECK_SEC ?? 3600) * 1000;
    const maxRisk = Number(process.env.RISK_MAX_PER_POLL ?? 5);
    const due = new Set(
      items
        .filter((i) => i.watchlist.rules.some((r) => r.type === 'risk_change') && (!i.lastRiskAt || Date.now() - i.lastRiskAt.getTime() >= every))
        .sort((a, b) => (a.lastRiskAt?.getTime() ?? 0) - (b.lastRiskAt?.getTime() ?? 0))
        .slice(0, maxRisk)
        .map((i) => i.id),
    );
    let alerts = 0;
    for (const it of items) {
      try {
        alerts += await this.check(it);
      } catch (e) {
        this.log.warn(`check ${it.address} failed: ${(e as Error).message}`);
      }
      if (due.has(it.id)) {
        try {
          alerts += await this.riskCheck(it);
        } catch (e) {
          this.log.warn(`risk re-score ${it.address} failed: ${(e as Error).message}`);
        }
      }
    }
    return { checked: items.length, alerts };
  }

  private async check(it: Prisma.WatchItemGetPayload<{ include: { watchlist: { include: { rules: true } } } }>): Promise<number> {
    const chain = it.chain as Chain;
    const history = await getTransfers(chain, it.address, 200, true, 'watch');
    const newest = history.reduce((m, t) => Math.max(m, t.timestamp), 0);
    const now = new Date();

    // First check only records a baseline; alerting starts from the next new transfer.
    if (it.lastSeenTs === null) {
      await this.db.watchItem.update({ where: { id: it.id }, data: { lastSeenTs: BigInt(newest), lastCheckedAt: now } });
      return 0;
    }
    const since = Number(it.lastSeenTs);
    const fresh = history.filter((t) => t.timestamp > since);
    const lm = await this.labels.lookup(chain, fresh.flatMap((t) => [t.from, t.to]), it.watchlist.orgId);
    const hits = evaluateRules(it.watchlist.rules, it.address, fresh, history, (a) => lm.get(a) ?? [], now.getTime());

    let created = 0;
    for (const h of hits) created += await this.raise(it, h);
    await this.db.watchItem.update({ where: { id: it.id }, data: { lastSeenTs: BigInt(Math.max(newest, since)), lastCheckedAt: now } });
    return created;
  }

  /** Stores an alert (a duplicate is ignored) and sends it through email / webhook. Returns 1 when a new alert was raised. */
  private async raise(it: { id: number; chain: string; address: string; watchlist: { orgId: number } }, h: Hit): Promise<number> {
    try {
      const a = await this.db.alert.create({
        data: { orgId: it.watchlist.orgId, watchItemId: it.id, ruleId: h.ruleId, dedupKey: h.dedupKey, chain: it.chain, address: it.address, counterparty: h.counterparty, amount: h.amount, asset: h.asset, txHash: h.txHash, detail: h.detail },
      });
      await this.notifier.alertCreated(a);
      return 1;
    } catch (e) {
      if ((e as Prisma.PrismaClientKnownRequestError).code !== 'P2002') throw e; // P2002 = duplicate alert, already raised
      return 0;
    }
  }

  /** Re-scores one watched wallet, alerts on a worse state (risk_change rule), and stores the new state. The first score is only a baseline. */
  private async riskCheck(it: Prisma.WatchItemGetPayload<{ include: { watchlist: { include: { rules: true } } } }>): Promise<number> {
    const rule = it.watchlist.rules.find((r) => r.type === 'risk_change');
    if (!rule) return 0;
    const a = await this.risk.assess(it.chain as Chain, it.address, it.watchlist.orgId, { deep: false });
    const next = riskSnap(a);
    const prev = it.lastRiskState && it.lastRiskLevel ? (it.lastRiskState as unknown as RiskSnap) : null;
    const hit = evaluateRiskChange(rule, prev, next, a.reasons, Date.now());
    const raised = hit ? await this.raise(it, hit) : 0;
    await this.db.watchItem.update({ where: { id: it.id }, data: { lastRiskScore: next.score, lastRiskLevel: next.level, lastRiskAt: new Date(), lastRiskState: next as unknown as Prisma.InputJsonValue } });
    return raised;
  }
}

/** BigInt is not JSON-serialisable. */
const item = <T extends { lastSeenTs: bigint | null }>(i: T) => ({ ...i, lastSeenTs: i.lastSeenTs === null ? null : Number(i.lastSeenTs) });

@Controller()
export class MonitorController {
  constructor(
    private db: Db,
    private monitor: MonitorService,
    private notifier: Notifier,
  ) {}

  private async own(ctx: Ctx, watchlistId: number) {
    return found(await this.db.watchlist.findFirst({ where: { id: watchlistId, orgId: ctx.orgId } }), 'Watchlist not found');
  }

  // ----- watchlists -----
  @Perm('monitor.view')
  @Get('watchlists')
  async lists(@CurrentCtx() ctx: Ctx) {
    const rows = await this.db.watchlist.findMany({ where: { orgId: ctx.orgId }, include: { _count: { select: { items: true, rules: true } } }, orderBy: { id: 'desc' } });
    const open = await this.db.alert.groupBy({ by: ['watchItemId'], where: { orgId: ctx.orgId, status: 'open' }, _count: true });
    const itemList = await this.db.watchItem.findMany({ where: { watchlist: { orgId: ctx.orgId } }, select: { id: true, watchlistId: true } });
    const listOf = new Map(itemList.map((i) => [i.id, i.watchlistId]));
    const openBy = new Map<number, number>();
    for (const o of open) openBy.set(listOf.get(o.watchItemId)!, (openBy.get(listOf.get(o.watchItemId)!) ?? 0) + o._count);
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, items: r._count.items, rules: r._count.rules, openAlerts: openBy.get(r.id) ?? 0 }));
  }

  @Perm('monitor.manage')
  @Post('watchlists')
  async createList(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const w = await this.db.watchlist.create({ data: { orgId: ctx.orgId, name: str(b.name, 'name', { max: 100 }) } });
    await audit(this.db, ctx, 'watchlist.create', `watchlist:${w.id}`, { name: w.name });
    return w;
  }

  @Perm('monitor.view')
  @Get('watchlists/:id')
  async getList(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const w = await this.own(ctx, id(raw));
    const [items, rules] = await Promise.all([
      this.db.watchItem.findMany({ where: { watchlistId: w.id }, orderBy: { id: 'desc' }, include: { _count: { select: { alerts: { where: { status: 'open' } } } } } }),
      this.db.rule.findMany({ where: { watchlistId: w.id }, orderBy: { id: 'asc' } }),
    ]);
    return { ...w, items: items.map(item), rules };
  }

  @Perm('monitor.manage')
  @Delete('watchlists/:id')
  async deleteList(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const w = await this.own(ctx, id(raw));
    await this.db.watchlist.delete({ where: { id: w.id } });
    await audit(this.db, ctx, 'watchlist.delete', `watchlist:${w.id}`, { name: w.name });
    return { ok: true };
  }

  // ----- items -----
  /** Body: { addresses: string[] } or { csv }, optional note. */
  @Perm('monitor.manage')
  @Post('watchlists/:id/items')
  async addItems(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const w = await this.own(ctx, id(raw));
    const addrs = extractAddresses(b, 5000);
    const note = str(b.note, 'note', { optional: true, max: 300 }) || null;
    const r = await this.db.watchItem.createMany({ data: addrs.map((a) => ({ watchlistId: w.id, chain: a.chain, address: a.addr, note })), skipDuplicates: true });
    await audit(this.db, ctx, 'watchlist.items.add', `watchlist:${w.id}`, { added: r.count });
    return { added: r.count, skipped: addrs.length - r.count };
  }

  @Perm('monitor.manage')
  @Delete('watch-items/:id')
  async removeItem(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const r = await this.db.watchItem.deleteMany({ where: { id: id(raw), watchlist: { orgId: ctx.orgId } } });
    if (!r.count) throw new BadRequestException('Item not found');
    return { ok: true };
  }

  // ----- rules -----
  @Perm('monitor.manage')
  @Post('watchlists/:id/rules')
  async addRule(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const w = await this.own(ctx, id(raw));
    const type = oneOf(b.type, 'type', RULE_TYPES);
    let params;
    try {
      params = ruleParams(type, b.params);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const r = await this.db.rule.create({ data: { watchlistId: w.id, type, params } });
    await audit(this.db, ctx, 'rule.create', `rule:${r.id}`, { type, params });
    return r;
  }

  @Perm('monitor.manage')
  @Patch('rules/:id')
  async updateRule(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const r = found(await this.db.rule.findFirst({ where: { id: id(raw), watchlist: { orgId: ctx.orgId } } }), 'Rule not found');
    const data: Prisma.RuleUpdateInput = {};
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    if (b.params !== undefined) {
      try {
        data.params = ruleParams(r.type as any, b.params);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }
    return this.db.rule.update({ where: { id: r.id }, data });
  }

  @Perm('monitor.manage')
  @Delete('rules/:id')
  async deleteRule(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const r = await this.db.rule.deleteMany({ where: { id: id(raw), watchlist: { orgId: ctx.orgId } } });
    if (!r.count) throw new BadRequestException('Rule not found');
    return { ok: true };
  }

  // ----- alerts -----
  @Perm('monitor.view')
  @Get('alerts')
  async alerts(@CurrentCtx() ctx: Ctx, @Query('status') status?: string, @Query('watchlistId') wl?: string, @Query('page') page?: string, @Query('asset') asset?: string) {
    const p = int(page, 0, 0, 10000);
    const where: Prisma.AlertWhereInput = {
      orgId: ctx.orgId,
      ...(status ? { status: oneOf(status, 'status', ALERT_STATUSES) } : {}),
      ...(wl ? { watchItem: { watchlistId: id(wl) } } : {}),
      ...(asset && asset !== 'all' ? { asset: oneOf(asset, 'asset', ['usdt', 'usdc'] as const) } : {}), // alerts of rules that span every asset (asset = all) show under All only
    };
    const [rows, total] = await Promise.all([
      this.db.alert.findMany({ where, orderBy: { id: 'desc' }, skip: p * 50, take: 50, include: { rule: { select: { type: true } }, watchItem: { select: { note: true, watchlist: { select: { id: true, name: true } } } } } }),
      this.db.alert.count({ where }),
    ]);
    return { rows, total, page: p, pageSize: 50 };
  }

  @Perm('alerts.triage')
  @Patch('alerts/:id')
  async updateAlert(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const status = oneOf(b.status, 'status', ALERT_STATUSES);
    const r = await this.db.alert.updateMany({ where: { id: id(raw), orgId: ctx.orgId }, data: { status } });
    if (!r.count) throw new BadRequestException('Alert not found');
    await audit(this.db, ctx, 'alert.status', `alert:${raw}`, { status });
    return { ok: true };
  }

  /** Runs one monitoring pass for this org now (normally automatic every MONITOR_INTERVAL_SEC). */
  @Perm('monitor.manage')
  @Post('monitor/run')
  run(@CurrentCtx() ctx: Ctx) {
    return this.monitor.poll(ctx.orgId);
  }

  // ----- notification targets -----
  @Perm('notify.manage')
  @Get('notify-targets')
  async targets(@CurrentCtx() ctx: Ctx) {
    const rows = await this.db.notifyTarget.findMany({ where: { orgId: ctx.orgId }, orderBy: { id: 'asc' } });
    return rows.map(({ secret, ...t }) => t); // the webhook secret is shown once, when the target is created
  }

  @Perm('notify.manage')
  @Post('notify-targets')
  async addTarget(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const type = oneOf(b.type, 'type', ['email', 'webhook'] as const);
    const target = str(b.target, 'target', { max: 500 });
    if (type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) throw new BadRequestException('Invalid email address');
    if (type === 'webhook') await assertPublicUrl(target);
    const t = await this.db.notifyTarget.create({ data: { orgId: ctx.orgId, type, target, secret: type === 'webhook' ? randomBytes(24).toString('hex') : null } });
    await audit(this.db, ctx, 'notify.create', `notify:${t.id}`, { type, target });
    return t;
  }

  @Perm('notify.manage')
  @Delete('notify-targets/:id')
  async removeTarget(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const r = await this.db.notifyTarget.deleteMany({ where: { id: id(raw), orgId: ctx.orgId } });
    if (!r.count) throw new BadRequestException('Target not found');
    return { ok: true };
  }

  /** Sends a sample alert to one target so admins can verify delivery. */
  @Perm('notify.manage')
  @Post('notify-targets/:id/test')
  async testTarget(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const t = found(await this.db.notifyTarget.findFirst({ where: { id: id(raw), orgId: ctx.orgId } }), 'Target not found');
    const sample = { id: 0, orgId: ctx.orgId, watchItemId: 0, ruleId: 0, dedupKey: 'test', chain: 'tron', asset: 'usdt', address: 'TEST', counterparty: null, amount: null, txHash: null, detail: 'Test notification from USDT Trace', status: 'open', createdAt: new Date(), updatedAt: new Date() } as Alert;
    if (t.type === 'webhook') return { ok: await this.notifier.webhook(t.target, t.secret ?? '', { event: 'test', alert: sample }) };
    await this.notifier.email(t.target, sample);
    return { ok: true };
  }
}
