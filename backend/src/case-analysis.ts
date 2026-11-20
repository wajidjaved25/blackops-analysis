// Case analysis (Phase 8B): runs as a background job over the case's transactions, stores the full result per run (CaseAnalysis) so the UI and the report only read.
import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, OnModuleInit, Param, Post } from '@nestjs/common';
import { CaseAnalysis } from '@prisma/client';
import { CurrentCtx, Perm } from './auth';
import { CasesService } from './cases';
import { Chain, getBalances, getTransfers } from './chains';
import { audit, Ctx, Db } from './db';
import { Jobs } from './jobs';
import { LabelsService } from './labels';
import { RiskService } from './risk';
import {
  bySeverity, busyFindings, consolidations, DEFAULT_PARAMS, exchangeFindings, exposureFindings, Finding, internalTransfers, LIMITS, linkChart, MAX_SEEDS, nearThreshold, nodeKey, Params, passThroughFindings,
  pathText, pathTo, repeatedAmounts, Row, totals, trace, unusualHours, walletTable,
} from './analysis-rules';
import { found, id, int } from './util';

const MAX_TIMELINE = 500;
const MAX_ENDPOINTS = 100;
const ACTIVE = ['queued', 'running'];

/** A wallet read that hangs (free API saturated) becomes an error on that wallet instead of stalling the whole run. */
const timeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`upstream too slow (> ${ms / 1000} s)`)), ms))]);
const num = (raw: unknown, def: number, min: number, max: number) => {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new BadRequestException(`Expected a number, got "${String(raw)}"`);
  return Math.min(max, Math.max(min, n));
};

/** Request body -> validated, clamped params. Anything not given keeps its default; limits are documented in docs/api.md. */
export function parseParams(b: Record<string, unknown>): Params {
  const d = DEFAULT_PARAMS;
  const th = b.thresholds === undefined || b.thresholds === '' ? d.thresholds : (Array.isArray(b.thresholds) ? b.thresholds : String(b.thresholds).split(/[\s,;]+/)).filter((x) => x !== '').map(Number);
  if (!th.length || th.length > 10 || th.some((x) => !Number.isFinite(x) || x <= 0)) throw new BadRequestException('thresholds must be 1 to 10 positive numbers');
  return {
    hops: int(b.hops, d.hops, ...LIMITS.hops), fanout: int(b.fanout, d.fanout, ...LIMITS.fanout), maxWallets: int(b.maxWallets, d.maxWallets, ...LIMITS.maxWallets), budgetSec: int(b.budgetSec, d.budgetSec, ...LIMITS.budgetSec),
    thresholds: th, thresholdPct: num(b.thresholdPct, d.thresholdPct, 0.01, 5), repeatMin: int(b.repeatMin, d.repeatMin, 2, 100), consolidationMin: int(b.consolidationMin, d.consolidationMin, 2, 100),
    passShare: num(b.passShare, d.passShare, 0.5, 1), passHours: num(b.passHours, d.passHours, 1, 720), nightFrom: int(b.nightFrom, d.nightFrom, 0, 23), nightTo: int(b.nightTo, d.nightTo, 0, 24),
    nightShare: num(b.nightShare, d.nightShare, 0.1, 1), nightMin: int(b.nightMin, d.nightMin, 1, 1000), tzMin: int(b.tzMin, d.tzMin, -720, 840), busyTransfers: int(b.busyTransfers, d.busyTransfers, 50, 500),
  };
}

const view = (a: CaseAnalysis, withResult: boolean) => ({
  id: a.id, caseId: a.caseId, status: a.status, stage: a.stage, params: a.params, progress: a.progress, total: a.total, error: a.error, createdAt: a.createdAt, finishedAt: a.finishedAt,
  ...(withResult ? { result: a.result } : {}),
});

@Controller()
export class CaseAnalysisController implements OnModuleInit {
  constructor(
    private db: Db,
    private cases: CasesService,
    private jobs: Jobs,
    private labels: LabelsService,
    private risk: RiskService,
  ) {}

  onModuleInit() {
    this.jobs.register('case-analysis', async (job) => {
      const { analysisId } = job.payload as { analysisId: number };
      const a = await this.db.caseAnalysis.findFirst({ where: { id: analysisId, case: { orgId: job.orgId } } });
      if (!a) return { skipped: 'analysis or case deleted' };
      const upd = (data: Record<string, unknown>) => this.db.caseAnalysis.update({ where: { id: a.id }, data }).catch(() => undefined); // the case may be deleted mid-run
      try {
        await upd({ status: 'running', stage: 'reading transactions', progress: 0, error: null });
        const result = await this.analyse(a, job.orgId, (progress, stage) => upd({ progress, stage }));
        await upd({ status: 'done', stage: 'done', result, finishedAt: new Date() });
        return { findings: result.findings.length };
      } catch (e) {
        await upd({ status: 'failed', stage: 'failed', error: (e as Error).message.slice(0, 1000), finishedAt: new Date() });
        throw e;
      }
    });
  }

  private async analyse(a: CaseAnalysis, orgId: number, report: (progress: number, stage: string) => Promise<unknown>) {
    const started = Date.now();
    const p = parseParams(a.params as Record<string, unknown>);
    const txs = await this.db.caseTransaction.findMany({ where: { caseId: a.caseId }, orderBy: [{ claimedAt: 'asc' }, { id: 'asc' }] });
    const rows: Row[] = txs.map((t) => ({
      id: t.id, chain: t.chain, hash: t.hash, ref: t.ref, address: t.address ?? t.onTo, coin: (t.coin ?? t.onAsset ?? 'USDT').toUpperCase(), amount: t.amount ?? t.onAmount ?? 0,
      at: (t.claimedAt ?? t.onAt)?.getTime() ?? null, offChain: t.status === 'off_chain', status: t.status,
    }));
    const all = walletTable(rows);
    const seeds = all.slice(0, MAX_SEEDS);
    const notes: string[] = [];
    if (all.length > seeds.length) notes.push(`Only the ${seeds.length} largest of ${all.length} recipient wallets were traced (limit ${MAX_SEEDS}).`);
    if (rows.some((r) => r.status === 'pending')) notes.push('Some transactions were still waiting for on-chain verification when this analysis ran; they are counted as claimed.');

    await report(0, 'tracing wallets');
    const res = await trace(seeds.map((w) => ({ chain: w.chain, address: w.address, after: w.first ?? 0 })), p, {
      transfers: (c, addr, seed) => timeout(getTransfers(c as Chain, addr, seed ? 500 : 200, false, seed ? 'case' : 'graph'), 60_000), // recipients get a full backfill; onward hops never do
      labels: (c, addrs) => this.labels.lookup(c as Chain, addrs, orgId),
      capped: async (c, addrs) => new Set((await this.db.indexedAddress.findMany({ where: { chain: c, address: { in: addrs }, status: 'capped' }, select: { address: true } })).map((x) => x.address)),
      onProgress: (n) => report(n, 'tracing wallets'),
    });
    if (seeds.length && res.stats.failed === seeds.length && !res.stats.walletsTraced) throw new Error(`No recipient wallet could be read from the chain: ${[...res.nodes.values()].find((n) => n.error)?.error ?? 'unknown error'}`);

    // Per recipient wallet: balance + risk (labels, reasons). Own time budget so a slow upstream cannot stall the run.
    await report(res.stats.walletsTraced, 'scoring recipients');
    const deadline = Date.now() + p.budgetSec * 1000;
    const frozenFindings: Finding[] = [];
    const within = <T,>(p: Promise<T>) => timeout(p, 25_000); // one wallet's risk + balance may not stall the run
    const score = async (w: (typeof all)[number]) => {
      const n = res.nodes.get(nodeKey(w.chain, w.address));
      const out: Record<string, unknown> = { ...w, traced: !!n?.expanded, stopReason: n?.stopReason ?? null, error: n?.error ?? null, balance: null, labels: n?.labels.map((l) => ({ name: l.name, category: l.category, source: l.source })) ?? [], risk: null };
      if (!n) out.risk = { score: null, level: null, reasons: [`Not traced: outside the ${MAX_SEEDS} largest recipients`] };
      else if (Date.now() >= deadline) out.risk = { score: null, level: null, reasons: ['Not scored: the time budget ran out'] };
      else {
        const [rk, bal] = await Promise.allSettled([within(this.risk.assess(w.chain as Chain, w.address, orgId, { transfers: res.histories.get(n.key) ?? [], deep: false })), within(getBalances(w.chain as Chain, w.address))]);
        if (rk.status === 'fulfilled') {
          const r = rk.value;
          out.risk = { score: r.score, level: r.level, reasons: r.reasons, frozen: r.frozen, frozenBy: r.frozenBy, labels: r.labels.map((l) => ({ name: l.name, category: l.category, source: l.source })) };
          if (r.frozen && n.stop !== 'risk') {
            frozenFindings.push({ type: 'risk_exposure', severity: 'high', title: 'Recipient is frozen', statement: `Recipient wallet ${w.address} is frozen${r.frozenBy.length ? ` by ${r.frozenBy.join(' and ')}` : ''} (issuer blacklist checked live).`, evidence: [{ kind: 'wallet', chain: w.chain, address: w.address, note: r.reasons[0] }], evidenceTotal: 1 });
          }
        } else out.risk = { score: null, level: null, reasons: [`Risk could not be computed: ${(rk.reason as Error).message}`] };
        out.balance = bal.status === 'fulfilled' ? Object.values(bal.value).reduce((x, y) => x + y, 0) : null; // null is shown as "unavailable"
      }
      return out;
    }
    const wallets: Record<string, unknown>[] = [];
    for (let i = 0; i < all.length; i += 2) wallets.push(...(await Promise.all(all.slice(i, i + 2).map(score))));

    const onchain = rows.filter((r) => !r.offChain);
    const t = totals(rows);
    const findings = [
      ...exposureFindings(res.nodes), ...frozenFindings, ...exchangeFindings(res.nodes), ...busyFindings(res.nodes), ...consolidations(res.edges, res.nodes, p.consolidationMin),
      ...passThroughFindings(res, p.passShare, p.passHours), ...repeatedAmounts(rows, p.repeatMin), ...nearThreshold(rows, p.thresholds, p.thresholdPct), ...unusualHours(rows, p), ...internalTransfers(rows),
    ].sort(bySeverity);

    const s = res.stats;
    const hit = [
      s.hopLimit && `hop limit (${p.hops}) reached: wallets at the last hop were not followed`,
      s.fanoutCut > 0 && `fan-out cap (${p.fanout} per wallet) cut the counterparties of ${s.fanoutCut} wallet(s)`,
      s.walletCap && `wallet cap (${p.maxWallets} onward wallets) reached: further wallets were dropped`,
      s.timedOut && `time budget (${p.budgetSec} s) ran out: ${s.notFollowed} discovered wallet(s) were not traced`,
      s.failed > 0 && `${s.failed} wallet(s) could not be read from the chain`,
    ].filter(Boolean) as string[];
    const sorted = [...rows].filter((r) => r.at !== null).sort((x, y) => x.at! - y.at!);
    const endpoints = [...res.nodes.values()].filter((n) => n.stop).slice(0, MAX_ENDPOINTS).map((n) => {
      const l = n.labels[0];
      return { kind: n.stop, chain: n.chain, address: n.address, name: l?.name ?? null, category: l?.category ?? null, source: l?.source ?? null, reason: n.stopReason, hop: n.hop, amount: n.via?.amount ?? null, path: pathText(pathTo(res.nodes, n.key)) };
    });
    return {
      version: 1, params: p, bounds: { hops: p.hops, fanout: p.fanout, maxWallets: p.maxWallets, maxSeeds: MAX_SEEDS, budgetSec: p.budgetSec, busyTransfers: p.busyTransfers },
      totals: { ...t, onChain: { count: onchain.length, amount: onchain.reduce((x, r) => x + r.amount, 0) }, wallets: all.length },
      wallets,
      trace: { ...s, seedsTotal: all.length, seedsTraced: seeds.filter((w) => res.nodes.get(nodeKey(w.chain, w.address))?.expanded).length, hit, partial: hit.length > 0 || all.length > seeds.length, durationMs: Date.now() - started },
      findings, findingsBySeverity: Object.fromEntries(['high', 'medium', 'low', 'info'].map((k) => [k, findings.filter((f) => f.severity === k).length])),
      endpoints, chart: linkChart(wallets as never, res, t.offChain), notes,
      points: rows.filter((r) => r.at !== null).map((r) => [r.at, r.amount, r.offChain ? 1 : 0]),
      timeline: sorted.slice(0, MAX_TIMELINE).map((r) => ({ at: r.at, chain: r.chain, hash: r.hash, ref: r.ref, address: r.address, amount: r.amount, coin: r.coin, status: r.status, offChain: r.offChain })), timelineTotal: sorted.length,
    };
  }

  @Perm('cases.manage')
  @Post('cases/:id/analyses')
  async run(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: Record<string, unknown>) {
    const c = await this.cases.own(ctx, raw);
    const params = parseParams(b ?? {});
    if (!(await this.db.caseTransaction.count({ where: { caseId: c.id } }))) throw new BadRequestException('Add transactions (paste hashes or import a statement) before running an analysis');
    if (await this.db.caseAnalysis.findFirst({ where: { caseId: c.id, status: { in: ACTIVE } }, select: { id: true } })) throw new ConflictException('An analysis is already running for this case');
    const a = await this.db.caseAnalysis.create({ data: { caseId: c.id, params: params as never, total: MAX_SEEDS + params.maxWallets, createdById: ctx.userId } });
    const job = await this.jobs.enqueue(ctx.orgId, 'case-analysis', { analysisId: a.id }, a.total);
    await this.db.caseAnalysis.update({ where: { id: a.id }, data: { jobId: job.id } });
    await audit(this.db, ctx, 'case.analysis.run', `case:${c.id}`, { analysis: a.id, params });
    return view({ ...a, jobId: job.id }, false);
  }

  @Perm('cases.view')
  @Get('cases/:id/analyses')
  async list(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const c = await this.cases.own(ctx, raw);
    const rows = await this.db.caseAnalysis.findMany({ where: { caseId: c.id }, orderBy: { id: 'desc' }, take: 50, omit: { result: true } });
    return rows.map((a) => view(a as CaseAnalysis, false));
  }

  /** The newest finished run (what the printable report shows). */
  @Perm('cases.view')
  @Get('cases/:id/analyses/latest')
  async latest(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const c = await this.cases.own(ctx, raw);
    return view(found(await this.db.caseAnalysis.findFirst({ where: { caseId: c.id, status: 'done' }, orderBy: { id: 'desc' } }), 'No finished analysis for this case yet'), true);
  }

  @Perm('cases.view')
  @Get('cases/:id/analyses/:aid')
  async one(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Param('aid') aid: string) {
    const c = await this.cases.own(ctx, raw);
    const a = await this.db.caseAnalysis.findFirst({ where: { id: id(aid), caseId: c.id } });
    if (!a) throw new NotFoundException('Analysis not found');
    return view(a, true);
  }
}
