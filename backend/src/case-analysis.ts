// Case analysis (Phase 8B): runs as a background job over the case's transactions, stores the full result per run (CaseAnalysis) so the UI and the report only read.
import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, OnModuleInit, Param, Post } from '@nestjs/common';
import { CaseAnalysis } from '@prisma/client';
import { CurrentCtx, Perm } from './auth';
import { assertNotEmpty, assertSelectedInCase, describeScope, filterScope, parseScope, Scope } from './case-scope';
import { CasesService } from './cases';
import { Chain, getBalances, getTransfers, norm } from './chains';
import { BinancePor } from './binance-por';
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
  const scope = parseScope(b.scope);
  return {
    hops: int(b.hops, d.hops, ...LIMITS.hops), fanout: int(b.fanout, d.fanout, ...LIMITS.fanout), maxWallets: int(b.maxWallets, d.maxWallets, ...LIMITS.maxWallets), budgetSec: int(b.budgetSec, d.budgetSec, ...LIMITS.budgetSec),
    thresholds: th, thresholdPct: num(b.thresholdPct, d.thresholdPct, 0.01, 5), repeatMin: int(b.repeatMin, d.repeatMin, 2, 100), consolidationMin: int(b.consolidationMin, d.consolidationMin, 2, 100),
    passShare: num(b.passShare, d.passShare, 0.5, 1), passHours: num(b.passHours, d.passHours, 1, 720), nightFrom: int(b.nightFrom, d.nightFrom, 0, 23), nightTo: int(b.nightTo, d.nightTo, 0, 24),
    nightShare: num(b.nightShare, d.nightShare, 0.1, 1), nightMin: int(b.nightMin, d.nightMin, 1, 1000), tzMin: int(b.tzMin, d.tzMin, -720, 840), busyTransfers: int(b.busyTransfers, d.busyTransfers, 50, 500),
    direction: oneOf(b.direction ?? d.direction, 'direction', ['forward', 'backward', 'both'] as const),
    ...(scope ? { scope } : {}),
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

/** The scope stored in a run's params, in words (old runs have none: all transactions). */
const scopeLine = (params: unknown) => {
  try {
    return describeScope(parseScope((params as Record<string, unknown>)?.scope));
  } catch {
    return 'Scope: unreadable';
  }
};

const view = (a: CaseAnalysis, withResult: boolean) => ({
  scopeSummary: scopeLine(a.params), id: a.id, caseId: a.caseId, status: a.status, stage: a.stage, params: a.params, progress: a.progress, total: a.total, error: a.error, createdAt: a.createdAt, finishedAt: a.finishedAt,
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
    private por: BinancePor,
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

  /** The case's transactions and the part a scope keeps (raw statement rows are only read when the direction filter needs them). */
  private async scoped(caseId: number, scope: Scope | null) {
    const everything = await this.db.caseTransaction.findMany({ where: { caseId }, omit: scope?.direction ? {} : { raw: true }, orderBy: [{ claimedAt: 'asc' }, { id: 'asc' }] });
    return { everything, txs: filterScope(everything, scope) };
  }

  /** Checks that need the database: selected ids and statement files must belong to this case, and the scope must keep something. */
  private async checkedScope(caseId: number, scope: Scope | null) {
    const s = await this.scoped(caseId, scope);
    if (scope?.mode === 'selected') assertSelectedInCase(scope.transactionIds!, new Set(s.everything.map((t) => t.id)));
    if (scope?.fileIds) {
      const have = new Set((await this.db.caseFile.findMany({ where: { caseId, id: { in: scope.fileIds } }, select: { id: true } })).map((f) => f.id));
      const bad = scope.fileIds.filter((x) => !have.has(x));
      if (bad.length) throw new BadRequestException(`Statement file ${bad.join(', ')} does not belong to this case`);
    }
    assertNotEmpty(s.txs.length, s.everything.length);
    return s;
  }

  private async analyse(a: CaseAnalysis, orgId: number, report: (progress: number, stage: string) => Promise<unknown>) {
    const started = Date.now();
    const p = parseParams(a.params as Record<string, unknown>);
    const { txs, everything } = await this.scoped(a.caseId, p.scope ?? null);
    if (!txs.length) throw new Error(`No transactions in scope (0 of ${everything.length}): they may have been deleted since the run was queued`);
    const rows: Row[] = txs.map((t) => ({
      id: t.id, chain: t.chain, hash: t.hash, ref: t.ref, address: t.address ?? t.onTo, coin: (t.coin ?? t.onAsset ?? 'USDT').toUpperCase(), amount: t.amount ?? t.onAmount ?? 0,
      at: (t.claimedAt ?? t.onAt)?.getTime() ?? null, offChain: t.status === 'off_chain', status: t.status,
    }));
    const all = walletTable(rows);
    const seeds = all.slice(0, MAX_SEEDS);
    const notes: string[] = [];
    if (all.length > seeds.length) notes.push(`Only the ${seeds.length} largest of ${all.length} recipient wallets were traced (limit ${MAX_SEEDS}).`);
    if (rows.some((r) => r.status === 'pending')) notes.push('Some transactions were still waiting for on-chain verification when this analysis ran; they are counted as claimed.');

    // Binance proof-of-reserves: mark recipients that are Binance wallets before tracing, so the trace ends there (nothing from the list is stored).
    const porCheck = async (list: { chain: string; address: string }[], what: string) => {
      if (!list.length) return;
      try {
        const r = await this.por.check(list.map((w) => ({ chain: w.chain as 'tron' | 'eth' | 'bsc', address: w.address })));
        if (r.matches.length) notes.push(`${r.matches.length} ${what} matched Binance's proof-of-reserves list (snapshot ${r.snapshot}).`);
      } catch (e) {
        notes.push(`Binance proof-of-reserves check skipped for ${what}: ${(e as Error).message}`);
      }
    };
    await report(0, 'checking Binance proof-of-reserves');
    await porCheck(all, 'recipient wallet(s)');

    const deps = {
      labels: (c: string, addrs: string[]) => this.labels.lookup(c as Chain, addrs, orgId),
      capped: async (c: string, addrs: string[]) => new Set((await this.db.indexedAddress.findMany({ where: { chain: c, address: { in: addrs }, status: 'capped' }, select: { address: true } })).map((x) => x.address)),
    };
    const transfers = (c: string, addr: string, seed: boolean) => timeout(getTransfers(c as Chain, addr, seed ? 500 : 200, false, seed ? 'case' : 'graph'), 60_000); // seeds get a full backfill; further hops never do
    // Unlabelled high-activity endpoints are often exchange wallets: check them against Binance's list and relabel matches.
    const relabelBusy = async (r: TraceResult) => {
      const busy = [...r.nodes.values()].filter((n) => n.stop === 'busy' && !n.labels.length);
      if (!busy.length) return;
      await report(r.stats.walletsTraced, 'checking endpoints against Binance proof-of-reserves');
      await porCheck(busy, 'high-activity endpoint(s)');
      for (const chain of new Set(busy.map((n) => n.chain))) {
        const found = await this.labels.lookup(chain as Chain, busy.filter((n) => n.chain === chain).map((n) => n.address), orgId);
        for (const n of busy.filter((x) => x.chain === chain)) {
          const l = found.get(n.address) ?? [];
          const stop = stopOf(l);
          if (l.length && stop) Object.assign(n, { labels: l, stop, stopReason: `labelled ${stop} wallet (${l[0].name}): endpoint, not traced further` });
        }
      }
    };
    const fwdSeeds = p.direction === 'backward' ? [] : seeds;
    await report(0, 'tracing wallets');
    const res = await trace(fwdSeeds.map((w) => ({ chain: w.chain, address: w.address, after: w.first ?? 0 })), p, { ...deps, transfers, onProgress: (n) => report(n, 'tracing wallets') });
    if (fwdSeeds.length && res.stats.failed === fwdSeeds.length && !res.stats.walletsTraced) throw new Error(`No recipient wallet could be read from the chain: ${[...res.nodes.values()].find((n) => n.error)?.error ?? 'unknown error'}`);
    await relabelBusy(res);

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
        await porCheck(bseeds.filter((x) => x.tag === 'sender'), 'sender wallet(s)');
        await report(0, 'tracing sources');
        const left = Math.max(10, p.budgetSec - Math.round((Date.now() - started) / 1000)); // one budget for the whole run: sources get what the onward trace left
        back = await trace(bseeds, { ...p, budgetSec: left }, { ...deps, transfers, onProgress: (n) => report(res.stats.walletsTraced + n, 'tracing sources') }, 'backward');
        await relabelBusy(back);
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
      const out: Record<string, unknown> = { ...w, role: roles.get(nodeKey(w.chain, w.address)) ?? null, traced: !!n?.expanded, stopReason: n?.stopReason ?? null, error: n?.error ?? null, balance: null, labels: n?.labels.map((l) => ({ name: l.name, category: l.category, source: l.source })) ?? [], risk: null };
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
    const dateless = p.scope && (p.scope.from || p.scope.to) ? filterScope(everything, { ...p.scope, from: undefined, to: undefined }).filter((t) => !(t.claimedAt ?? t.onAt)).length : 0;
    return {
      version: 1, params: p,
      scope: { applied: p.scope ?? null, summary: describeScope(p.scope ?? null), inScope: txs.length, total: everything.length, ...(dateless ? { undatedExcluded: dateless } : {}) }, bounds: { hops: p.hops, fanout: p.fanout, maxWallets: p.maxWallets, maxSeeds: MAX_SEEDS, budgetSec: p.budgetSec, busyTransfers: p.busyTransfers },
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
    await this.checkedScope(c.id, params.scope ?? null);
    if (await this.db.caseAnalysis.findFirst({ where: { caseId: c.id, status: { in: ACTIVE } }, select: { id: true } })) throw new ConflictException('An analysis is already running for this case');
    const a = await this.db.caseAnalysis.create({ data: { caseId: c.id, params: params as never, total: (MAX_SEEDS + params.maxWallets) * (params.direction === 'both' ? 2 : 1), createdById: ctx.userId } });
    const job = await this.jobs.enqueue(ctx.orgId, 'case-analysis', { analysisId: a.id }, a.total);
    await this.db.caseAnalysis.update({ where: { id: a.id }, data: { jobId: job.id } });
    await audit(this.db, ctx, 'case.analysis.run', `case:${c.id}`, { analysis: a.id, params });
    return view({ ...a, jobId: job.id }, false);
  }

  /** Live count for the scope picker: how many of the case's transactions a scope keeps, plus the values the filters can offer. Nothing is stored. */
  @Perm('cases.view')
  @Post('cases/:id/analyses/scope-preview')
  async scopePreview(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: Record<string, unknown>) {
    const c = await this.cases.own(ctx, raw);
    const scope = parseScope(b?.scope);
    const { everything, txs } = await this.scoped(c.id, scope);
    if (scope?.mode === 'selected') assertSelectedInCase(scope.transactionIds!, new Set(everything.map((t) => t.id)));
    const count = <K,>(f: (t: (typeof everything)[number]) => K | null) => {
      const m = new Map<K, number>();
      for (const t of everything) { const k = f(t); if (k !== null) m.set(k, (m.get(k) ?? 0) + 1); }
      return m;
    };
    const files = await this.db.caseFile.findMany({ where: { caseId: c.id, id: { in: [...new Set(everything.flatMap((t) => (t.fileId === null ? [] : [t.fileId])))] } }, select: { id: true, name: true } });
    const perFile = count((t) => t.fileId);
    const wallets = [...count((t) => t.address ?? t.onTo)].sort((x, y) => y[1] - x[1]).slice(0, 200);
    return {
      inScope: txs.length, total: everything.length, summary: describeScope(scope),
      undatedExcluded: scope && (scope.from || scope.to) ? filterScope(everything, { ...scope, mode: 'all', from: undefined, to: undefined }).filter((t) => !(t.claimedAt ?? t.onAt)).length : 0,
      facets: {
        statuses: Object.fromEntries(count((t) => t.status)), chains: Object.fromEntries(count((t) => t.chain)), assets: Object.fromEntries(count((t) => (t.coin ?? t.onAsset ?? 'USDT').toUpperCase())),
        files: files.map((f) => ({ id: f.id, name: f.name, count: perFile.get(f.id) ?? 0 })), pasted: everything.filter((t) => t.source === 'manual' && t.fileId === null).length,
        wallets: wallets.map(([address, n]) => ({ address, count: n })), walletsTotal: new Set(everything.map((t) => t.address ?? t.onTo).filter(Boolean)).size,
      },
    };
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
