// Case analysis (Phase 8B): runs as a background job over the case's transactions, stores the full result per run (CaseAnalysis) so the UI and the report only read.
import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, OnModuleInit, Param, Post } from '@nestjs/common';
import { CaseAnalysis } from '@prisma/client';
import { CurrentCtx, Perm } from './auth';
import { CasesService } from './cases';
import { Chain, getBalances, getTransfers, norm } from './chains';
import { audit, Ctx, Db } from './db';
import { Jobs } from './jobs';
import { LabelsService } from './labels';
import { RiskService } from './risk';
import {
  bySeverity, busyFindings, consolidations, DEFAULT_PARAMS, exchangeFindings, exposureFindings, Finding, internalTransfers, LIMITS, linkChart, MAX_SEEDS, nearThreshold, nodeKey, Params, passThroughFindings,
  pathText, pathTo, repeatedAmounts, Row, sourceEndpoints, sourceFindings, sourcePaths, stopOf, totals, trace, TraceResult, TraceStats, unusualHours, walletTable,
} from './analysis-rules';
import { found, id, int, oneOf } from './util';
import { GROUP_NOTE, groupFindings, groupWallets, WalletGroup } from './wallet-groups';
import { groupPredicates } from './wallet-groups.controller';

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
    direction: oneOf(b.direction ?? d.direction, 'direction', ['forward', 'backward', 'both'] as const),
  };
}

/** Which bounds a trace reached, in words (shown in the partial-result notice). */
const boundsHit = (s: TraceStats, p: Params) => [
  s.hopLimit && `hop limit (${p.hops}) reached: wallets at the last hop were not followed`,
  s.fanoutCut > 0 && `fan-out cap (${p.fanout} per wallet) cut the counterparties of ${s.fanoutCut} wallet(s)`,
  s.walletCap && `wallet cap (${p.maxWallets} wallets) reached: further wallets were dropped`,
  s.timedOut && `time budget (${p.budgetSec} s) ran out: ${s.notFollowed} discovered wallet(s) were not traced`,
  s.failed > 0 && `${s.failed} wallet(s) could not be read from the chain`,
].filter(Boolean) as string[];

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

    const deps = {
      labels: (c: string, addrs: string[]) => this.labels.lookup(c as Chain, addrs, orgId),
      capped: async (c: string, addrs: string[]) => new Set((await this.db.indexedAddress.findMany({ where: { chain: c, address: { in: addrs }, status: 'capped' }, select: { address: true } })).map((x) => x.address)),
    };
    const transfers = (c: string, addr: string, seed: boolean) => timeout(getTransfers(c as Chain, addr, seed ? 500 : 200, false, seed ? 'case' : 'graph'), 60_000); // seeds get a full backfill; further hops never do
    const fwdSeeds = p.direction === 'backward' ? [] : seeds;
    await report(0, 'tracing wallets');
    const res = await trace(fwdSeeds.map((w) => ({ chain: w.chain, address: w.address, after: w.first ?? 0 })), p, { ...deps, transfers, onProgress: (n) => report(n, 'tracing wallets') });
    if (fwdSeeds.length && res.stats.failed === fwdSeeds.length && !res.stats.walletsTraced) throw new Error(`No recipient wallet could be read from the chain: ${[...res.nodes.values()].find((n) => n.error)?.error ?? 'unknown error'}`);

    // Backward (source of funds). Seeds: (1) the on-chain sender of every case transaction, bounded by the time it was sent;
    // (2) every recipient wallet, bounded by its LAST payment time (what could have funded it by then). Senders first, at most MAX_SEEDS.
    let back: TraceResult | null = null;
    const bseedAll = new Map<string, { chain: string; address: string; after: number; tag?: string }>();
    if (p.direction !== 'forward') {
      for (const t of txs) {
        if (!t.chain || !t.onFrom || !t.onAt || t.status === 'off_chain') continue; // only verified senders: the time bound must be the on-chain time
        const k = nodeKey(t.chain, t.onFrom);
        bseedAll.set(k, { chain: t.chain, address: t.onFrom, after: Math.max(bseedAll.get(k)?.after ?? 0, t.onAt.getTime()), tag: 'sender' });
      }
      for (const w of seeds) if (!bseedAll.has(nodeKey(w.chain, w.address))) bseedAll.set(nodeKey(w.chain, w.address), { chain: w.chain, address: w.address, after: w.last ?? Date.now() });
      const all2 = [...bseedAll.values()];
      const bseeds = [...all2.filter((x) => x.tag).slice(0, MAX_SEEDS / 2), ...all2.filter((x) => !x.tag)].slice(0, MAX_SEEDS); // senders cannot crowd out every recipient
      if (bseedAll.size > bseeds.length) notes.push(`Source tracing started from ${bseeds.length} of ${bseedAll.size} wallets (limit ${MAX_SEEDS}).`);
      if (bseeds.length) {
        await report(0, 'tracing sources');
        const left = Math.max(10, p.budgetSec - Math.round((Date.now() - started) / 1000)); // one budget for the whole run: sources get what the onward trace left
        back = await trace(bseeds, { ...p, budgetSec: left }, { ...deps, transfers, onProgress: (n) => report(res.stats.walletsTraced + n, 'tracing sources') }, 'backward');
      } else notes.push('Source tracing skipped: the case has no verified sender or recipient wallet yet.');
    }

    // 9C: wallets of this case that may share an owner (common funder, shared exchange customer account, round trips). Heuristics from the histories already read.
    await report(res.stats.walletsTraced, 'looking for wallets with a common owner');
    const ownerGroups: WalletGroup[] = [];
    try {
      for (const chain of new Set(seeds.map((w) => w.chain))) {
        const histories = new Map(seeds.filter((w) => w.chain === chain).flatMap((w) => { const h = res.histories.get(nodeKey(w.chain, w.address)); return h ? [[norm(w.address), h] as const] : []; }));
        if (histories.size < 1) continue;
        const pred = await groupPredicates(this.labels, this.db, chain as Chain, [...histories.values()].flatMap((h) => h.flatMap((t) => [t.from, t.to])), orgId);
        ownerGroups.push(...groupWallets({ chain, histories, ...pred }));
      }
    } catch (e) {
      notes.push(`Wallet grouping skipped: ${(e as Error).message}`);
    }
    const roles = new Map((await this.db.caseAddress.findMany({ where: { caseId: a.caseId }, select: { chain: true, address: true, role: true } })).map((r) => [`${r.chain}|${norm(r.address)}`, r.role]));

    // Per recipient wallet: balance + risk (labels, reasons). Own time budget so a slow upstream cannot stall the run.
    await report(res.stats.walletsTraced, 'scoring recipients');
    const deadline = Date.now() + p.budgetSec * 1000;
    const frozenFindings: Finding[] = [];
    const within = <T,>(p: Promise<T>) => timeout(p, 25_000); // one wallet's risk + balance may not stall the run
    const score = async (w: (typeof all)[number]) => {
      const n = res.nodes.get(nodeKey(w.chain, w.address)) ?? back?.nodes.get(nodeKey(w.chain, w.address));
      const out: Record<string, unknown> = { ...w, role: roles.get(nodeKey(w.chain, w.address)) ?? null, traced: !!n?.expanded, stopReason: n?.stopReason ?? null, error: n?.error ?? null, balance: null, labels: n?.labels.map((l) => ({ name: l.name, category: l.category, source: l.source, sourceUrl: l.sourceUrl ?? null })) ?? [], risk: null };
      if (!n) out.risk = { score: null, level: null, reasons: [`Not traced: outside the wallets traced (limit ${MAX_SEEDS})`] };
      else if (Date.now() >= deadline) out.risk = { score: null, level: null, reasons: ['Not scored: the time budget ran out'] };
      else {
        const [rk, bal] = await Promise.allSettled([within(this.risk.assess(w.chain as Chain, w.address, orgId, { transfers: res.histories.get(n.key) ?? back?.histories.get(n.key) ?? [], deep: false })), within(getBalances(w.chain as Chain, w.address))]);
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
      ...(back ? sourceFindings(back.nodes) : []), ...passThroughFindings(res, p.passShare, p.passHours), ...groupFindings(ownerGroups), ...repeatedAmounts(rows, p.repeatMin), ...nearThreshold(rows, p.thresholds, p.thresholdPct), ...unusualHours(rows, p), ...internalTransfers(rows),
    ].sort(bySeverity);

    const s = res.stats;
    const hit = boundsHit(s, p);
    const backHit = back ? boundsHit(back.stats, p) : [];
    const sorted = [...rows].filter((r) => r.at !== null).sort((x, y) => x.at! - y.at!);
    const endpoints = [...res.nodes.values()].filter((n) => n.stop).slice(0, MAX_ENDPOINTS).map((n) => {
      const l = n.labels[0];
      return { kind: n.stop, chain: n.chain, address: n.address, name: l?.name ?? null, category: l?.category ?? null, source: l?.source ?? null, reason: n.stopReason, hop: n.hop, amount: n.via?.amount ?? null, path: pathText(pathTo(res.nodes, n.key)) };
    });
    return {
      version: 1, params: p, bounds: { hops: p.hops, fanout: p.fanout, maxWallets: p.maxWallets, maxSeeds: MAX_SEEDS, budgetSec: p.budgetSec, busyTransfers: p.busyTransfers },
      totals: { ...t, onChain: { count: onchain.length, amount: onchain.reduce((x, r) => x + r.amount, 0) }, wallets: all.length },
      wallets,
      trace: { ...s, seedsTotal: all.length, seedsTraced: seeds.filter((w) => (res.nodes.get(nodeKey(w.chain, w.address)) ?? back?.nodes.get(nodeKey(w.chain, w.address)))?.expanded).length, hit, partial: hit.length > 0 || backHit.length > 0 || all.length > seeds.length, durationMs: Date.now() - started },
      direction: p.direction,
      sources: back ? { stats: back.stats, hit: backHit, seeds: bseedAll.size, endpoints: sourceEndpoints(back.nodes, MAX_ENDPOINTS), paths: sourcePaths(back.nodes, 30) } : null,
      findings, findingsBySeverity: Object.fromEntries(['high', 'medium', 'low', 'info'].map((k) => [k, findings.filter((f) => f.severity === k).length])),
      ownerGroups, ownerGroupNote: GROUP_NOTE,
      endpoints, chart: linkChart(wallets as never, res, t.offChain, back ?? undefined), notes,
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
    const a = await this.db.caseAnalysis.create({ data: { caseId: c.id, params: params as never, total: (MAX_SEEDS + params.maxWallets) * (params.direction === 'both' ? 2 : 1), createdById: ctx.userId } });
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
