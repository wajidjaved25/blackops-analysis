import { BadRequestException, Body, Controller, Get, Injectable, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { CurrentCtx, Perm } from './auth';
import { Chain, getTransfers, norm } from './chains';
import { clusterConfidence, depositEvidence } from './cluster';
import { audit, Ctx, Db } from './db';
import { Jobs } from './jobs';
import { LabelsService } from './labels';
import { found, id, oneOf } from './util';

const MAX_HOT_WALLETS = 20;
const MAX_CANDIDATES = 30; // senders checked per hot wallet; each is one chain-API call
const STATUSES = ['pending', 'accepted', 'rejected'] as const;

interface Hot {
  chain: Chain;
  address: string;
  name: string;
}

@Injectable()
export class ClusterWorker implements OnModuleInit {
  constructor(
    private db: Db,
    private jobs: Jobs,
    private labels: LabelsService,
  ) {}

  onModuleInit() {
    this.jobs.register('cluster', async (job, progress) => {
      const hots = (job.payload as any).hots as Hot[];
      let created = 0;
      for (const [i, hot] of hots.entries()) {
        created += await this.cluster(hot, job.orgId);
        await progress(i + 1);
      }
      return { created };
    });
  }

  /** Finds deposit addresses of one hot wallet and stores them as pending suggestions. */
  private async cluster(hot: Hot, orgId: number): Promise<number> {
    const incoming = new Map<string, number>(); // sender -> volume into the hot wallet
    for (const t of await getTransfers(hot.chain, hot.address, 300, false, 'graph')) {
      if (norm(t.to) === norm(hot.address)) incoming.set(norm(t.from), (incoming.get(norm(t.from)) ?? 0) + t.amount);
    }
    const ranked = [...incoming].sort((a, b) => b[1] - a[1]).map(([a]) => a);
    // Already-labelled wallets and wallets we have already suggested are not candidates.
    const labelled = await this.labels.lookup(hot.chain, ranked, orgId);
    const known = new Set((await this.db.clusterSuggestion.findMany({ where: { orgId, chain: hot.chain, address: { in: ranked } }, select: { address: true } })).map((s) => s.address));
    const candidates = ranked.filter((a) => !labelled.has(a) && !known.has(a)).slice(0, MAX_CANDIDATES);

    let created = 0;
    for (const addr of candidates) {
      try {
        const ev = depositEvidence(addr, await getTransfers(hot.chain, addr, 300, false, 'graph'), hot.address);
        if (!ev) continue;
        const r = await this.db.clusterSuggestion.createMany({
          data: [{ orgId, chain: hot.chain, address: addr, name: `${hot.name} deposit`, category: 'exchange', confidence: clusterConfidence(ev), evidence: ev as any }],
          skipDuplicates: true,
        });
        created += r.count;
      } catch {
        /* one unreachable candidate must not fail the run */
      }
    }
    return created;
  }
}

@Controller('attribution')
export class AttributionController {
  constructor(
    private db: Db,
    private jobs: Jobs,
  ) {}

  @Perm('attribution.run')
  @Post('run')
  async run(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    // Cluster labels are deposit addresses, not hot wallets, so they are never used as the anchor.
    const where = { category: 'exchange', source: { not: 'cluster' }, orgId: { in: [0, ctx.orgId] }, ...(b.labelId !== undefined ? { id: id(b.labelId) } : {}) };
    const rows = await this.db.label.findMany({ where, orderBy: { id: 'asc' }, take: 200 });
    if (!rows.length) {
      throw new BadRequestException(
        b.labelId !== undefined ? 'That label does not exist or is not in the "exchange" category' : 'No exchange labels to cluster around. Add or import a labelled exchange hot wallet (category "exchange") first.',
      );
    }
    const seen = new Set<string>();
    const hots = rows.filter((l) => !seen.has(l.chain + l.address) && seen.add(l.chain + l.address)).slice(0, MAX_HOT_WALLETS).map((l) => ({ chain: l.chain as Chain, address: l.address, name: l.name }));
    const job = await this.jobs.enqueue(ctx.orgId, 'cluster', { hots }, hots.length);
    await audit(this.db, ctx, 'attribution.run', `job:${job.id}`, { hotWallets: hots.length });
    return { jobId: job.id };
  }

  @Perm('attribution.run', 'attribution.review')
  @Get('jobs')
  async jobsList(@CurrentCtx() ctx: Ctx) {
    return this.db.job.findMany({ where: { orgId: ctx.orgId, type: 'cluster' }, orderBy: { id: 'desc' }, take: 50, select: { id: true, status: true, progress: true, total: true, createdAt: true, error: true } });
  }

  @Perm('attribution.run', 'attribution.review')
  @Get('suggestions')
  async suggestions(@CurrentCtx() ctx: Ctx, @Query('status') status?: string) {
    const rows = await this.db.clusterSuggestion.findMany({ where: { orgId: ctx.orgId, status: oneOf(status ?? 'pending', 'status', STATUSES) }, orderBy: [{ confidence: 'desc' }, { id: 'desc' }], take: 500 });
    return rows.map((s) => ({ id: s.id, chain: s.chain, address: s.address, name: s.name, category: s.category, confidence: s.confidence, evidence: s.evidence, status: s.status, createdAt: s.createdAt }));
  }

  private async pending(ctx: Ctx, raw: string) {
    const s = found(await this.db.clusterSuggestion.findFirst({ where: { id: id(raw), orgId: ctx.orgId } }), 'Suggestion not found');
    if (s.status !== 'pending') throw new BadRequestException(`This suggestion was already ${s.status}`);
    return s;
  }

  /** Accepting creates an org label (source "cluster"), which risk scoring and graphs pick up automatically. */
  @Perm('attribution.review')
  @Post('suggestions/:id/accept')
  async accept(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const s = await this.pending(ctx, raw);
    const [label] = await this.db.$transaction([
      this.db.label.upsert({
        where: { chain_address_source_orgId: { chain: s.chain, address: s.address, source: 'cluster', orgId: ctx.orgId } },
        create: { chain: s.chain, address: s.address, name: s.name, category: s.category, source: 'cluster', confidence: s.confidence, orgId: ctx.orgId },
        update: { name: s.name, category: s.category, confidence: s.confidence },
      }),
      this.db.clusterSuggestion.update({ where: { id: s.id }, data: { status: 'accepted' } }),
    ]);
    await audit(this.db, ctx, 'attribution.accept', `${s.chain}:${s.address}`, { name: s.name, confidence: s.confidence });
    return { ok: true, label };
  }

  @Perm('attribution.review')
  @Post('suggestions/:id/reject')
  async reject(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const s = await this.pending(ctx, raw);
    await this.db.clusterSuggestion.update({ where: { id: s.id }, data: { status: 'rejected' } });
    await audit(this.db, ctx, 'attribution.reject', `${s.chain}:${s.address}`);
    return { ok: true };
  }
}
