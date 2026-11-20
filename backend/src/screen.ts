import { Body, Controller, Get, Injectable, OnModuleInit, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentCtx, Perm } from './auth';
import { Chain } from './chains';
import { audit, Ctx, Db } from './db';
import { Jobs } from './jobs';
import { RiskService } from './risk';
import { assetParam, extractAddresses, found, id, toCsv } from './util';

const MAX = 1000;

interface ScreenRow {
  chain: Chain;
  address: string;
  score: number | null;
  level: string | null;
  frozen: boolean | null;
  frozenBy: string; // issuers, e.g. "Tether; Circle"
  labels: string;
  reasons: string;
  error?: string;
}

@Injectable()
export class ScreenWorker implements OnModuleInit {
  constructor(
    private jobs: Jobs,
    private risk: RiskService,
  ) {}

  onModuleInit() {
    this.jobs.register('screen', async (job, progress) => {
      const items = (job.payload as any).items as { chain: Chain; addr: string }[];
      const asset = assetParam((job.payload as any).asset); // jobs queued before 7B have none = all
      const rows: ScreenRow[] = [];
      for (const [i, it] of items.entries()) {
        try {
          const a = await this.risk.assess(it.chain, it.addr, job.orgId, { deep: false, asset });
          rows.push({
            chain: it.chain,
            address: it.addr,
            score: a.score,
            level: a.level,
            frozen: a.frozen,
            frozenBy: a.frozenBy.join('; '),
            labels: a.labels.map((l) => `${l.name} (${l.category})`).join('; '),
            reasons: a.reasons.join(' | '),
          });
        } catch (e) {
          // One bad address must not fail the whole batch.
          rows.push({ chain: it.chain, address: it.addr, score: null, level: null, frozen: null, frozenBy: '', labels: '', reasons: '', error: (e as Error).message });
        }
        if (i % 5 === 4 || i === items.length - 1) await progress(i + 1);
      }
      return { rows };
    });
  }
}

@Controller('screen')
export class ScreenController {
  constructor(
    private db: Db,
    private jobs: Jobs,
  ) {}

  /** Body: { addresses: string[] } or { csv: "…" } (any cell that is an address is used), optional `chain` ("eth" default | "bsc") for the 0x addresses and `asset` (usdt | usdc | all) the exposure is measured in. Max 1000. */
  @Perm('screen.run')
  @Post()
  async create(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const items = extractAddresses(b, MAX);
    const job = await this.jobs.enqueue(ctx.orgId, 'screen', { items, asset: assetParam(b.asset), name: typeof b.name === 'string' ? b.name.slice(0, 100) : '' }, items.length);
    await audit(this.db, ctx, 'screen.create', `job:${job.id}`, { count: items.length });
    return { id: job.id, total: items.length };
  }

  @Perm('investigate.view')
  @Get()
  async list(@CurrentCtx() ctx: Ctx) {
    const jobs = await this.db.job.findMany({
      where: { orgId: ctx.orgId, type: 'screen' },
      orderBy: { id: 'desc' },
      take: 50,
      select: { id: true, status: true, progress: true, total: true, createdAt: true, updatedAt: true, error: true, payload: true },
    });
    return jobs.map(({ payload, ...j }) => ({ ...j, name: (payload as any).name ?? '', asset: (payload as any).asset ?? 'all' }));
  }

  @Perm('investigate.view')
  @Get(':id')
  async get(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const j = found(await this.db.job.findFirst({ where: { id: id(raw), orgId: ctx.orgId, type: 'screen' } }), 'Screening job not found');
    return { id: j.id, status: j.status, progress: j.progress, total: j.total, error: j.error, asset: (j.payload as any)?.asset ?? 'all', rows: (j.result as any)?.rows ?? [] };
  }

  @Perm('export.data')
  @Get(':id/csv')
  async csv(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Res() res: Response) {
    const j = found(await this.db.job.findFirst({ where: { id: id(raw), orgId: ctx.orgId, type: 'screen' } }), 'Screening job not found');
    const rows: ScreenRow[] = (j.result as any)?.rows ?? [];
    await audit(this.db, ctx, 'screen.export', `job:${j.id}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="screening-${j.id}.csv"`);
    res.send(
      toCsv([
        ['address', 'chain', 'risk_score', 'risk_level', 'frozen', 'frozen_by', 'labels', 'reasons', 'error'],
        ...rows.map((r) => [r.address, r.chain, r.score, r.level, r.frozen, r.frozenBy ?? '', r.labels, r.reasons, r.error ?? '']),
      ]),
    );
  }
}
