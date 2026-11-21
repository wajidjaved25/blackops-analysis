// Case transactions (Phase 8A): paste hashes or import an exchange statement, then verify each row against the chain in a background job.
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, OnModuleInit, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { diskStorage } from 'multer';
import { CurrentCtx, Perm } from './auth';
import { MAX_SELECTED } from './case-scope';
import { CasesService, cleanName, ext, FILE_TYPES, rm, ROLES, startsWith, UPLOAD_DIR } from './cases';
import { Chain, getTx, isTxHash } from './chains';
import { audit, Ctx, Db } from './db';
import { Jobs } from './jobs';
import { Cell, DEFAULT_TIME_TOL_MIN, detectFormat, Mapping, MAPPING_KEYS, MAX_ROWS, matchTx, NormRow, normalizeRows, statementDepositLabels, tzMinutes } from './statements';
import { found, id, int, oneOf, parseCsv, toCsv } from './util';

const MAX_STATEMENT = 5 * 1024 * 1024;
const MAX_UNZIPPED = 60 * 1024 * 1024; // zip-bomb guard: a 5 MB xlsx may not inflate past this
const MAX_COLS = 60;
const MAX_PASTE = 200;
const OFF_CHAIN_NOTE = 'Internal exchange transfer — no on-chain trace; request records from the exchange';
const STATUSES = ['pending', 'verified', 'mismatch', 'not_found', 'off_chain', 'error'] as const;

/** Sum of the uncompressed sizes in the zip central directory (xlsx = zip), read without inflating anything. */
function unzippedSize(buf: Buffer): number {
  let e = buf.length - 22;
  while (e >= 0 && e > buf.length - 65_600 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0 || buf.readUInt32LE(e) !== 0x06054b50) throw new BadRequestException('The file is not a valid .xlsx (zip) file');
  let n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  let total = 0;
  while (n-- > 0 && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    total += buf.readUInt32LE(p + 24);
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return total;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Cell -> plain value. Formulas are reduced to their cached result and never kept; rich text, links and errors become text/null. */
function cellVal(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
  const o = v as unknown as Record<string, unknown>;
  if ('result' in o) return cellVal(o.result as ExcelJS.CellValue);
  if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
  if ('text' in o) return cellVal(o.text as ExcelJS.CellValue);
  return null;
}

/** Statement file -> grid (row 0 = header). For .xlsx the first sheet whose headers look like an exchange export wins, else the first non-empty sheet. */
export async function readGrid(path: string, name: string): Promise<{ sheet: string | null; grid: Cell[][] }> {
  const tooBig = () => new BadRequestException(`Too many rows (max ${MAX_ROWS})`);
  if (ext(name) === 'csv') {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    if (text.includes('\0')) throw new BadRequestException('The file content does not look like a .csv file');
    const grid = parseCsv(text).slice(0, MAX_ROWS + 2);
    if (grid.length > MAX_ROWS + 1) throw tooBig();
    return { sheet: null, grid };
  }
  const buf = readFileSync(path);
  if (unzippedSize(buf) > MAX_UNZIPPED) throw new BadRequestException('The spreadsheet is too large once unpacked');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw new BadRequestException('The file could not be read as an .xlsx spreadsheet');
  }
  const grids = wb.worksheets.map((ws) => {
    const grid: Cell[][] = [];
    let rows = 0;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (++rows > MAX_ROWS + 1) throw tooBig();
      const vals = (row.values as ExcelJS.CellValue[]).slice(1, MAX_COLS + 1);
      while (grid.length < n - 1) grid.push([]);
      grid[n - 1] = Array.from(vals, (c) => cellVal(c));
    });
    return { sheet: ws.name, grid };
  });
  const pick = grids.find((g) => g.grid.length && detectFormat(g.grid[0]).format !== 'generic') ?? grids.find((g) => g.grid.length);
  if (!pick) throw new BadRequestException('The spreadsheet has no data');
  return pick;
}

/** Everything the preview and the import share: parse the upload, detect the format, apply the user's overrides, normalise rows. */
async function parseStatement(path: string, name: string, b: any) {
  const { sheet, grid } = await readGrid(path, name);
  if (grid.length < 2) throw new BadRequestException('The file has a header row but no data rows');
  const det = detectFormat(grid[0]);
  let mapping: Mapping = det.mapping;
  if (b.mapping) {
    let m: any;
    try {
      m = typeof b.mapping === 'string' ? JSON.parse(b.mapping) : b.mapping;
    } catch {
      throw new BadRequestException('mapping must be JSON');
    }
    mapping = {};
    for (const k of MAPPING_KEYS) if (m?.[k] !== undefined && m[k] !== null && m[k] !== '') mapping[k] = int(m[k], 0, 0, MAX_COLS - 1);
  }
  const given = b.tz !== undefined && b.tz !== '' ? tzMinutes(String(b.tz)) : null;
  if (b.tz !== undefined && b.tz !== '' && given === null) throw new BadRequestException('tz must look like UTC+5 or UTC-3:30');
  const tz = given ?? det.tz ?? 0;
  const defaultChain = b.defaultChain ? oneOf(b.defaultChain, 'defaultChain', ['tron', 'eth', 'bsc'] as const) : null;
  if (mapping.hash === undefined || mapping.amount === undefined) throw new BadRequestException('Map at least the transaction hash and amount columns');
  const rows = normalizeRows(grid, mapping, { tz, defaultChain });
  if (!rows.length) throw new BadRequestException('The file has no data rows');
  return { sheet, headers: grid[0].map((h, i) => (h === null ? '' : String(h)) || `column ${i + 1}`), format: det.format, mapping, tz, tzDetected: det.tz !== null, rows };
}

const uploadOpts = {
  storage: diskStorage({ destination: UPLOAD_DIR, filename: (_req, _file, cb) => cb(null, randomBytes(16).toString('hex')) }),
  limits: { fileSize: MAX_STATEMENT, files: 1 },
  fileFilter: (_req: unknown, file: Express.Multer.File, cb: (e: Error | null, ok: boolean) => void) => {
    const t = ext(cleanName(file.originalname));
    cb(t === 'xlsx' || t === 'csv' ? null : new BadRequestException(t === 'xls' ? 'Old .xls files are not supported: save the statement as .xlsx or .csv' : `File type ".${t}" is not supported. Use .xlsx or .csv`), t === 'xlsx' || t === 'csv');
  },
};

const view = (t: Prisma.CaseTransactionGetPayload<object>) => ({
  id: t.id, chain: t.chain, hash: t.hash, source: t.source, fileId: t.fileId, rowNo: t.rowNo, claimedAt: t.claimedAt, coin: t.coin, network: t.network,
  amount: t.amount, fee: t.fee, address: t.address, ref: t.ref, status: t.status, onFrom: t.onFrom, onTo: t.onTo, onAmount: t.onAmount, onAsset: t.onAsset,
  onAt: t.onAt, reasons: t.reasons as string[], verifiedAt: t.verifiedAt,
});

const tolerance = (raw: unknown) => int(raw, DEFAULT_TIME_TOL_MIN, 1, 7 * 24 * 60);

@Controller()
export class CaseTxController implements OnModuleInit {
  constructor(
    private db: Db,
    private cases: CasesService,
    private jobs: Jobs,
  ) {}

  onModuleInit() {
    this.jobs.register('verify-tx', async (job, progress) => {
      const { caseId, timeTolMin } = job.payload as { caseId: number; timeTolMin: number };
      const rows = await this.db.caseTransaction.findMany({ where: { caseId, status: 'pending', chain: { not: null }, hash: { not: null }, case: { orgId: job.orgId } }, orderBy: { id: 'asc' } });
      const tally: Record<string, number> = {};
      for (const [i, r] of rows.entries()) {
        let data: Prisma.CaseTransactionUpdateInput;
        try {
          const tx = await getTx(r.chain as Chain, r.hash!);
          const o = matchTx({ address: r.address, amount: r.amount, fee: r.fee, asset: r.coin === 'USDT' ? 'usdt' : r.coin === 'USDC' ? 'usdc' : null, claimedAt: r.claimedAt }, tx, timeTolMin);
          data = { status: o.status, reasons: o.reasons, onFrom: o.onFrom, onTo: o.onTo, onAmount: o.onAmount, onAsset: o.onAsset, onAt: o.onAt };
        } catch (e) {
          const notFound = e instanceof NotFoundException;
          data = { status: notFound ? 'not_found' : 'error', reasons: [(e as Error).message.slice(0, 300)] };
        }
        tally[data.status as string] = (tally[data.status as string] ?? 0) + 1;
        await this.db.caseTransaction.update({ where: { id: r.id }, data: { ...data, verifiedAt: new Date() } }).catch(() => undefined); // row deleted mid-run
        if (i % 2 === 1 || i === rows.length - 1) await progress(i + 1);
      }
      return tally;
    });
  }

  private async summary(caseId: number) {
    const g = await this.db.caseTransaction.groupBy({ by: ['status'], where: { caseId }, _count: { _all: true }, _sum: { amount: true } });
    const byStatus = Object.fromEntries(g.map((x) => [x.status, { count: x._count._all, amount: x._sum.amount ?? 0 }]));
    const sum = (f: (s: string) => boolean) => g.filter((x) => f(x.status)).reduce((s, x) => s + (x._sum.amount ?? 0), 0);
    return { total: g.reduce((s, x) => s + x._count._all, 0), pending: byStatus.pending?.count ?? 0, byStatus, claimed: sum(() => true), verified: sum((s) => s === 'verified') };
  }

  private queue(ctx: Ctx, caseId: number, pending: number, timeTolMin: number) {
    return pending ? this.jobs.enqueue(ctx.orgId, 'verify-tx', { caseId, timeTolMin }, pending).then((j) => j.id) : Promise.resolve(null);
  }

  @Perm('cases.view')
  @Get('cases/:id/transactions')
  async list(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Query('status') status?: string, @Query('q') q?: string, @Query('limit') limit?: string, @Query('offset') offset?: string, @Query('idsOnly') idsOnly?: string) {
    const c = await this.cases.own(ctx, raw);
    const where: Prisma.CaseTransactionWhereInput = { caseId: c.id };
    if (status) where.status = oneOf(status, 'status', STATUSES);
    const term = (q ?? '').trim().slice(0, 100);
    if (term) where.OR = [{ hash: { contains: term, mode: 'insensitive' } }, { address: { contains: term, mode: 'insensitive' } }, { ref: { contains: term, mode: 'insensitive' } }];
    if (idsOnly) return { ids: (await this.db.caseTransaction.findMany({ where, select: { id: true }, orderBy: { id: 'asc' }, take: MAX_SELECTED })).map((r) => r.id) }; // "select all matching the filter" for Analyse selected
    const [rows, count, summary] = await Promise.all([
      this.db.caseTransaction.findMany({ where, orderBy: [{ claimedAt: 'asc' }, { id: 'asc' }], take: int(limit, 200, 1, 1000), skip: int(offset, 0, 0, 1_000_000) }),
      this.db.caseTransaction.count({ where }),
      this.summary(c.id),
    ]);
    return { summary, count, rows: rows.map(view) };
  }

  @Perm('cases.manage')
  @Post('cases/:id/transactions')
  async paste(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const c = await this.cases.own(ctx, raw);
    const tokens: string[] = Array.isArray(b.hashes) ? b.hashes.map(String) : typeof b.hashes === 'string' ? b.hashes.split(/[\s,;]+/) : [];
    const hint = b.chain ? oneOf(b.chain, 'chain', ['eth', 'bsc'] as const) : 'eth'; // a 0x hash could be Ethereum or BNB Chain: the caller says which
    const unique = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))];
    if (!unique.length) throw new BadRequestException('Paste at least one transaction hash');
    if (unique.length > MAX_PASTE) throw new BadRequestException(`Too many hashes (${unique.length}); max ${MAX_PASTE} per paste`);
    const skipped: { value: string; reason: string }[] = [];
    const ok: { chain: Chain; hash: string }[] = [];
    for (const t of unique) {
      const chain = isTxHash('tron', t) ? 'tron' : isTxHash('eth', t) ? hint : null;
      if (chain) ok.push({ chain, hash: t.toLowerCase() });
      else skipped.push({ value: t.slice(0, 80), reason: 'Not a Tron (64 hex) or 0x… (66 chars) transaction hash' });
    }
    const exists = ok.length ? await this.db.caseTransaction.findMany({ where: { caseId: c.id, OR: ok.map((o) => ({ chain: o.chain, hash: o.hash })) }, select: { chain: true, hash: true } }) : [];
    const have = new Set(exists.map((e) => `${e.chain}|${e.hash}`));
    const fresh = ok.filter((o) => (have.has(`${o.chain}|${o.hash}`) ? (skipped.push({ value: o.hash, reason: 'Already in this case' }), false) : true));
    if (fresh.length) await this.db.caseTransaction.createMany({ data: fresh.map((o) => ({ caseId: c.id, chain: o.chain, hash: o.hash, source: 'manual' })), skipDuplicates: true });
    const jobId = await this.queue(ctx, c.id, fresh.length, tolerance(b.timeTolMin));
    await audit(this.db, ctx, 'case.tx.add', `case:${c.id}`, { added: fresh.length, skipped: skipped.length });
    return { added: fresh.length, skipped, jobId };
  }

  /** Dry run: parse + detect + validate, store nothing. The wizard shows this, then calls /import with the same file and options. */
  @Perm('cases.manage')
  @Post('cases/:id/transactions/preview')
  @UseInterceptors(FileInterceptor('file', uploadOpts))
  async preview(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Attach the statement in the "file" form field (.xlsx or .csv, max 5 MB)');
    try {
      await this.cases.own(ctx, raw);
      const name = cleanName(file.originalname);
      if (ext(name) === 'xlsx' && !startsWith(file.path, FILE_TYPES.xlsx.magic!)) throw new BadRequestException('The file content does not look like an .xlsx file');
      const p = await parseStatement(file.path, name, b);
      const bad = p.rows.filter((r) => r.problems.length);
      return {
        file: name, format: p.format, sheet: p.sheet, headers: p.headers, mapping: p.mapping, tz: p.tz, tzDetected: p.tzDetected,
        counts: { rows: p.rows.length, onChain: p.rows.filter((r) => !r.offChain && !r.problems.length).length, offChain: p.rows.filter((r) => r.offChain && !r.problems.length).length, withProblems: bad.length },
        claimed: p.rows.filter((r) => !r.problems.length).reduce((s, r) => s + (r.amount ?? 0), 0),
        wallets: new Set(p.rows.filter((r) => !r.problems.length && !r.offChain && r.address).map((r) => r.chain + '|' + r.address)).size,
        rows: p.rows.map((r) => ({ row: r.row, chain: r.chain, hash: r.hash, ref: r.ref, offChain: r.offChain, address: r.address, amount: r.amount, fee: r.fee, coin: r.coin, claimedAt: r.claimedAt, problems: r.problems })),
      };
    } finally {
      rm(file.path);
    }
  }

  @Perm('cases.manage')
  @Post('cases/:id/transactions/import')
  @UseInterceptors(FileInterceptor('file', uploadOpts))
  async import(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Attach the statement in the "file" form field (.xlsx or .csv, max 5 MB)');
    let keep = false;
    try {
      const c = await this.cases.own(ctx, raw);
      const name = cleanName(file.originalname);
      if (ext(name) === 'xlsx' && !startsWith(file.path, FILE_TYPES.xlsx.magic!)) throw new BadRequestException('The file content does not look like an .xlsx file');
      const role = b.walletRole && b.walletRole !== 'none' ? oneOf(b.walletRole, 'walletRole', ROLES) : null;
      const timeTolMin = tolerance(b.timeTolMin);
      const p = await parseStatement(file.path, name, b);
      const good = p.rows.filter((r) => !r.problems.length);
      if (!good.length) throw new BadRequestException('No importable rows: every row has a problem (see the preview)');

      const have = new Set(
        (await this.db.caseTransaction.findMany({ where: { caseId: c.id, hash: { not: null } }, select: { chain: true, hash: true } })).map((e) => `${e.chain}|${e.hash}`),
      );
      const dupes = good.filter((r) => r.hash && have.has(`${r.chain}|${r.hash}`));
      const rows = good.filter((r) => !dupes.includes(r));

      const f = await this.db.caseFile.create({ data: { caseId: c.id, name, storedName: file.filename, size: file.size, mime: FILE_TYPES[ext(name)].mime, uploadedById: ctx.userId } });
      keep = true; // the stored statement is evidence now
      const toData = (r: NormRow): Prisma.CaseTransactionCreateManyInput => ({
        caseId: c.id, chain: r.chain, hash: r.hash, source: 'import', fileId: f.id, rowNo: r.row, claimedAt: r.claimedAt, coin: r.coin, network: r.network, amount: r.amount, fee: r.fee,
        address: r.address, ref: r.ref, raw: r.raw as Prisma.InputJsonObject, status: r.offChain ? 'off_chain' : 'pending', reasons: r.offChain ? [OFF_CHAIN_NOTE] : [],
      });
      await this.db.caseTransaction.createMany({ data: rows.map(toData), skipDuplicates: true });

      // 8.19 / 9C: a statement proves its addresses are CUSTOMER accounts at the exchange (deposit address of the holder, or of another customer
      // for an internal transfer), never the exchange's own wallets: category exchange_deposit. Org-private; a later statement refreshes the case in the name.
      const deposits = statementDepositLabels(p.format, rows, c.id);
      for (const d of deposits) {
        const where = { chain_address_source_orgId: { chain: d.chain, address: d.address, source: 'statement', orgId: ctx.orgId } };
        await this.db.label.upsert({ where, create: { chain: d.chain, address: d.address, name: d.name, category: 'exchange_deposit', source: 'statement', confidence: 0.9, orgId: ctx.orgId }, update: { name: d.name, category: 'exchange_deposit', confidence: 0.9 } });
      }

      let wallets = 0;
      if (role) {
        const by = new Map<string, { chain: string; address: string; n: number; sum: number }>();
        for (const r of rows) {
          if (r.offChain || !r.address || !r.chain) continue;
          const w = by.get(r.chain + '|' + r.address) ?? { chain: r.chain, address: r.address, n: 0, sum: 0 };
          by.set(r.chain + '|' + r.address, { ...w, n: w.n + 1, sum: w.sum + (r.amount ?? 0) });
        }
        const r = await this.db.caseAddress.createMany({
          data: [...by.values()].map((w) => ({ caseId: c.id, chain: w.chain, address: w.address, role, note: `From statement "${name}" (case file #${f.id}): ${w.n} transaction${w.n === 1 ? '' : 's'}, ${w.sum.toLocaleString('en-US', { maximumFractionDigits: 6 })} claimed` })),
          skipDuplicates: true,
        });
        wallets = r.count;
      }
      const pending = rows.filter((r) => !r.offChain).length;
      const jobId = await this.queue(ctx, c.id, pending, timeTolMin);
      await audit(this.db, ctx, 'case.tx.import', `case:${c.id}`, { file: f.id, name, format: p.format, imported: rows.length, offChain: rows.filter((r) => r.offChain).length, skipped: p.rows.length - rows.length, wallets, depositLabels: deposits.length });
      return { fileId: f.id, format: p.format, imported: rows.length, offChain: rows.filter((r) => r.offChain).length, alreadyInCase: dupes.length, skipped: p.rows.length - good.length, wallets, depositLabels: deposits.length, jobId };
    } finally {
      if (!keep) rm(file.path); // rejected uploads are never kept
    }
  }

  /** Re-check rows (all on-chain rows, or `ids`) against the chain. */
  @Perm('cases.manage')
  @Post('cases/:id/transactions/verify')
  async verify(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const c = await this.cases.own(ctx, raw);
    const ids: number[] | null = Array.isArray(b.ids) ? b.ids.map(id) : null;
    const r = await this.db.caseTransaction.updateMany({
      where: { caseId: c.id, hash: { not: null }, chain: { not: null }, status: { not: 'off_chain' }, ...(ids ? { id: { in: ids } } : {}) },
      data: { status: 'pending', reasons: [], onFrom: null, onTo: null, onAmount: null, onAsset: null, onAt: null },
    });
    const jobId = await this.queue(ctx, c.id, r.count, tolerance(b.timeTolMin));
    await audit(this.db, ctx, 'case.tx.verify', `case:${c.id}`, { rows: r.count });
    return { queued: r.count, jobId };
  }

  @Perm('cases.manage')
  @Delete('case-transactions/:id')
  async remove(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const t = found(await this.db.caseTransaction.findFirst({ where: { id: id(raw), case: { orgId: ctx.orgId } } }), 'Transaction not found');
    await this.db.caseTransaction.delete({ where: { id: t.id } });
    await audit(this.db, ctx, 'case.tx.delete', `case:${t.caseId}`, { tx: t.id, hash: t.hash });
    return { ok: true };
  }

  @Perm('export.data')
  @Get('cases/:id/transactions.csv')
  async csv(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Res() res: Response) {
    const c = await this.cases.own(ctx, raw);
    const rows = await this.db.caseTransaction.findMany({ where: { caseId: c.id }, orderBy: [{ claimedAt: 'asc' }, { id: 'asc' }] });
    await audit(this.db, ctx, 'case.tx.export', `case:${c.id}`, { rows: rows.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="case-${c.id}-transactions.csv"`);
    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    res.send(
      toCsv([
        ['status', 'chain', 'tx_hash', 'exchange_ref', 'statement_time_utc', 'coin', 'network', 'claimed_amount', 'fee', 'claimed_address', 'onchain_time_utc', 'onchain_from', 'onchain_to', 'onchain_amount', 'onchain_asset', 'reasons'],
        ...rows.map((t) => [t.status, t.chain, t.hash, t.ref, iso(t.claimedAt), t.coin, t.network, t.amount, t.fee, t.address, iso(t.onAt), t.onFrom, t.onTo, t.onAmount, t.onAsset, (t.reasons as string[]).join(' | ')]),
      ]),
    );
  }
}
