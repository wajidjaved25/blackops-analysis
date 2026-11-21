import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diskStorage } from 'multer';
import { CurrentCtx, Perm } from './auth';
import { Chain, getTransfers, norm } from './chains';
import { audit, Ctx, Db } from './db';
import { RiskService } from './risk';
import { boundedMap, graphAddresses, graphStats, pickSources, timelineHops } from './timeline';
import { found, id, int, oneOf, parseAddr, str, toCsv } from './util';

export const ROLES = ['suspect', 'victim', 'exchange', 'intermediary', 'other'] as const;
const STATUSES = ['open', 'closed'] as const;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_PNG = 8 * 1024 * 1024;
const MAX_BULK_ADDRESSES = 500;
const MAX_TIMELINE_ADDRESSES = 25; // each address is a live chain-API call
const TIMELINE_CONCURRENCY = 4; // wallets read at once
const TIMELINE_WALLET_MS = 25_000; // one slow wallet is skipped (with a warning) after this
const TIMELINE_TOTAL_MS = 120_000; // wallets not started by then are skipped; the Next proxy allows 170 s
const MAX_REPORT_IMAGES = 6; // snapshot images embedded in the report JSON (they are large): the newest few
const GRAPH_COLS = { id: true, name: true, remarks: true, chain: true, rootAddress: true, depth: true, filters: true, nodeCount: true, edgeCount: true, createdById: true, createdAt: true, updatedAt: true } as const;
export const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || 'uploads');

/** Allowed upload types. The stored mime comes from here, never from the client; magic bytes catch renamed files. */
export const FILE_TYPES: Record<string, { mime: string; magic?: number[] }> = {
  pdf: { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  png: { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  jpeg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  gif: { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  webp: { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [0x50, 0x4b] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [0x50, 0x4b] },
  txt: { mime: 'text/plain' },
  csv: { mime: 'text/csv' },
  json: { mime: 'application/json' },
  md: { mime: 'text/markdown' },
};
export const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/** Strips path parts and control characters from a client-supplied file name. */
export function cleanName(raw: string): string {
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8'); // multer decodes names as latin1
  return (utf8.split(/[\\/]/).pop() ?? '').replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 200) || 'file';
}

export function startsWith(path: string, magic: number[]): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(magic.length);
    readSync(fd, buf, 0, magic.length, 0);
    return magic.every((b, i) => buf[i] === b);
  } finally {
    closeSync(fd);
  }
}
export const rm = (path: string) => {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
};

const addrView = (a: { id: number; chain: string; address: string; role: string; note: string }) => ({ id: a.id, chain: a.chain, address: a.address, role: a.role, note: a.note });

@Injectable()
export class CasesService {
  constructor(private db: Db) {}

  async own(ctx: Ctx, raw: string) {
    return found(await this.db.case.findFirst({ where: { id: id(raw), orgId: ctx.orgId } }), 'Case not found');
  }

  /** Summary rows of a case's graph snapshots (no graph JSON, no image), newest first, with the author's name. */
  async graphList(ctx: Ctx, caseId: number) {
    const rows = await this.db.caseGraph.findMany({ where: { caseId }, orderBy: { createdAt: 'desc' }, select: { ...GRAPH_COLS, graphPng: true } });
    const users = await this.db.user.findMany({ where: { orgId: ctx.orgId, id: { in: rows.map((r) => r.createdById).filter((x): x is number => x !== null) } }, select: { id: true, name: true } });
    const who = new Map(users.map((u) => [u.id, u.name]));
    return rows.map(({ graphPng, createdById, ...g }) => ({ ...g, hasImage: !!graphPng, author: createdById ? who.get(createdById) ?? null : null }));
  }

  /** Stablecoin (USDT / USDC) transfers between the case's wallets (case addresses + wallets in ALL its graph snapshots, de-duplicated), with hop numbers. Bounded: at most 4 wallets at once, 25 s per wallet, 120 s in total; what could not be read is listed in `warnings`. */
  async timeline(c: { id: number }) {
    const warnings: string[] = [];
    const [addrs, graphs] = await Promise.all([
      this.db.caseAddress.findMany({ where: { caseId: c.id }, orderBy: { id: 'asc' } }),
      this.db.caseGraph.findMany({ where: { caseId: c.id }, orderBy: { id: 'asc' }, select: { chain: true, graphJson: true } }),
    ]);
    const all = addrs.map((a) => ({ chain: a.chain as Chain, address: a.address }));
    for (const g of graphs) {
      for (const a of graphAddresses(g.graphJson)) {
        try {
          all.push({ chain: parseAddr(a, g.chain).chain, address: a }); // a snapshot carries its chain (tron | eth | bsc)
        } catch {
          all.push({ chain: parseAddr(a).chain, address: a });
        }
      }
    }
    const seen = new Set<string>();
    const wallets = all.filter((w) => !seen.has(w.chain + norm(w.address)) && seen.add(w.chain + norm(w.address)));
    if (wallets.length > MAX_TIMELINE_ADDRESSES) warnings.push(`Only the first ${MAX_TIMELINE_ADDRESSES} of ${wallets.length} wallets were checked for transfers`);
    const checked = wallets.slice(0, MAX_TIMELINE_ADDRESSES);

    const inCase = new Set(checked.map((w) => w.chain + norm(w.address)));
    const rows = new Map<string, { hash: string; from: string; to: string; amount: number; asset: string; timestamp: number }>();
    const r = await boundedMap(
      checked,
      TIMELINE_CONCURRENCY,
      TIMELINE_WALLET_MS,
      Date.now() + TIMELINE_TOTAL_MS,
      async (w) => (await getTransfers(w.chain, w.address, 500, false, 'case')).filter((t) => inCase.has(w.chain + norm(t.from)) && inCase.has(w.chain + norm(t.to))),
      (w) => w.address,
    );
    for (const list of r.done) for (const t of list) rows.set(`${t.asset}|${t.hash}|${t.from}|${t.to}|${t.amount}`, t);
    warnings.push(...r.warnings);
    const sources = pickSources(addrs.map((a) => ({ address: norm(a.address), role: a.role })));
    return { transfers: timelineHops([...rows.values()].map((t) => ({ ...t, from: norm(t.from), to: norm(t.to) })), sources), warnings };
  }
}

@Controller()
export class CasesController {
  constructor(
    private db: Db,
    private cases: CasesService,
    private risk: RiskService,
  ) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  /** 9C: the roles this address has in the organisation's cases (suspect, victim, ...). The address page shows them before any label. */
  @Perm('cases.view')
  @Get('address/:addr/cases')
  async casesOf(@CurrentCtx() ctx: Ctx, @Param('addr') addr: string, @Query('chain') chain?: string) {
    const p = parseAddr(addr, chain);
    const rows = await this.db.caseAddress.findMany({ where: { chain: p.chain, address: p.addr, case: { orgId: ctx.orgId } }, select: { role: true, caseId: true, case: { select: { title: true, status: true } } }, orderBy: { id: 'asc' }, take: 20 });
    return rows.map((r) => ({ caseId: r.caseId, title: r.case.title, status: r.case.status, role: r.role }));
  }

  // ----- cases -----
  @Perm('cases.view')
  @Get('cases')
  async list(@CurrentCtx() ctx: Ctx, @Query('status') status?: string) {
    const rows = await this.db.case.findMany({
      where: { orgId: ctx.orgId, ...(status ? { status: oneOf(status, 'status', STATUSES) } : {}) },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, status: true, createdAt: true, updatedAt: true, _count: { select: { addresses: true, notes: true, files: true } } },
    });
    return rows.map(({ _count, ...c }) => ({ ...c, addresses: _count.addresses, notes: _count.notes, files: _count.files }));
  }

  @Perm('cases.manage')
  @Post('cases')
  async create(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const c = await this.db.case.create({
      data: { orgId: ctx.orgId, title: str(b.title, 'title', { max: 200 }), description: str(b.description, 'description', { optional: true, max: 20000 }), createdById: ctx.userId },
      select: { id: true, title: true, description: true, status: true, createdAt: true, updatedAt: true },
    });
    await audit(this.db, ctx, 'case.create', `case:${c.id}`, { title: c.title });
    return c;
  }

  @Perm('cases.view')
  @Get('cases/:id')
  async get(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const c = await this.cases.own(ctx, raw);
    const [addresses, notes, files, graphs] = await Promise.all([
      this.db.caseAddress.findMany({ where: { caseId: c.id }, orderBy: { id: 'asc' } }),
      this.db.caseNote.findMany({ where: { caseId: c.id }, orderBy: { id: 'desc' } }),
      this.db.caseFile.findMany({ where: { caseId: c.id }, orderBy: { id: 'desc' } }),
      this.cases.graphList(ctx, c.id),
    ]);
    const users = await this.db.user.findMany({ where: { orgId: ctx.orgId, id: { in: notes.map((n) => n.authorId).filter((x): x is number => x !== null) } }, select: { id: true, name: true } });
    const who = new Map(users.map((u) => [u.id, u.name]));
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      graphs,
      addresses: addresses.map(addrView),
      notes: notes.map((n) => ({ id: n.id, body: n.body, authorId: n.authorId, author: n.authorId ? who.get(n.authorId) ?? null : null, createdAt: n.createdAt })),
      files: files.map((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, createdAt: f.createdAt })),
    };
  }

  @Perm('cases.manage')
  @Patch('cases/:id')
  async update(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const c = await this.cases.own(ctx, raw);
    const data: Prisma.CaseUpdateInput = {};
    if (b.title !== undefined) data.title = str(b.title, 'title', { max: 200 });
    if (b.description !== undefined) data.description = str(b.description, 'description', { optional: true, max: 20000 });
    if (b.status !== undefined) data.status = oneOf(b.status, 'status', STATUSES);
    const u = await this.db.case.update({ where: { id: c.id }, data, select: { id: true, title: true, description: true, status: true, createdAt: true, updatedAt: true } });
    await audit(this.db, ctx, 'case.update', `case:${c.id}`, data as object);
    return u;
  }

  @Perm('cases.delete')
  @Delete('cases/:id')
  async remove(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const c = await this.cases.own(ctx, raw);
    const files = await this.db.caseFile.findMany({ where: { caseId: c.id }, select: { storedName: true } });
    await this.db.case.delete({ where: { id: c.id } });
    files.forEach((f) => rm(join(UPLOAD_DIR, f.storedName)));
    await audit(this.db, ctx, 'case.delete', `case:${c.id}`, { title: c.title, files: files.length });
    return { ok: true };
  }

  // ----- addresses -----
  @Perm('cases.manage')
  @Post('cases/:id/addresses')
  async addAddress(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const c = await this.cases.own(ctx, raw);
    const { chain, addr } = parseAddr(b.address, b.chain);
    try {
      const a = await this.db.caseAddress.create({ data: { caseId: c.id, chain, address: addr, role: oneOf(b.role ?? 'other', 'role', ROLES), note: str(b.note, 'note', { optional: true, max: 2000 }) } });
      await audit(this.db, ctx, 'case.address.add', `case:${c.id}`, { address: addr, role: a.role });
      return addrView(a);
    } catch (e) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') throw new ConflictException('This address is already in the case');
      throw e;
    }
  }

  /** Many addresses at once (analysis wallets -> case). All-or-nothing validation; addresses already in the case are skipped and reported. */
  @Perm('cases.manage')
  @Post('cases/:id/addresses/bulk')
  async addAddresses(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const c = await this.cases.own(ctx, raw);
    const list: any[] = Array.isArray(b?.addresses) ? b.addresses : [];
    if (!list.length) throw new BadRequestException('addresses must be a non-empty array');
    if (list.length > MAX_BULK_ADDRESSES) throw new BadRequestException(`Too many addresses (${list.length}); max ${MAX_BULK_ADDRESSES} per request`);
    const seen = new Set<string>();
    const rows: { chain: Chain; address: string; role: string; note: string }[] = [];
    for (const [i, x] of list.entries()) {
      try {
        const { chain, addr } = parseAddr(x?.address, x?.chain ?? b.chain);
        if (seen.has(chain + addr)) continue; // duplicates inside the request count once
        seen.add(chain + addr);
        rows.push({ chain, address: addr, role: oneOf(x?.role ?? b.role ?? 'other', 'role', ROLES), note: str(x?.note, 'note', { optional: true, max: 2000 }) });
      } catch (e) {
        throw new BadRequestException(`addresses[${i}]: ${(e as Error).message}`);
      }
    }
    const have = await this.db.caseAddress.findMany({ where: { caseId: c.id, OR: rows.map((r) => ({ chain: r.chain, address: r.address })) }, select: { chain: true, address: true } });
    const known = new Set(have.map((h) => h.chain + h.address));
    const fresh = rows.filter((r) => !known.has(r.chain + r.address));
    const added = fresh.length ? (await this.db.caseAddress.createMany({ data: fresh.map((r) => ({ caseId: c.id, ...r })), skipDuplicates: true })).count : 0;
    await audit(this.db, ctx, 'case.address.bulk', `case:${c.id}`, { requested: list.length, added, skipped: known.size });
    return { added, skipped: known.size, duplicatesInRequest: list.length - rows.length, skippedAddresses: rows.filter((r) => known.has(r.chain + r.address)).map((r) => r.address).slice(0, 50) };
  }

  @Perm('cases.manage')
  @Patch('case-addresses/:id')
  async updateAddress(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const a = found(await this.db.caseAddress.findFirst({ where: { id: id(raw), case: { orgId: ctx.orgId } } }), 'Case address not found');
    const data: Prisma.CaseAddressUpdateInput = {};
    if (b.role !== undefined) data.role = oneOf(b.role, 'role', ROLES);
    if (b.note !== undefined) data.note = str(b.note, 'note', { optional: true, max: 2000 });
    const u = await this.db.caseAddress.update({ where: { id: a.id }, data });
    await audit(this.db, ctx, 'case.address.update', `case:${a.caseId}`, { address: a.address, ...data });
    return addrView(u);
  }

  @Perm('cases.manage')
  @Delete('case-addresses/:id')
  async removeAddress(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const a = found(await this.db.caseAddress.findFirst({ where: { id: id(raw), case: { orgId: ctx.orgId } } }), 'Case address not found');
    await this.db.caseAddress.delete({ where: { id: a.id } });
    await audit(this.db, ctx, 'case.address.remove', `case:${a.caseId}`, { address: a.address });
    return { ok: true };
  }

  // ----- notes -----
  @Perm('cases.manage')
  @Post('cases/:id/notes')
  async addNote(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const c = await this.cases.own(ctx, raw);
    const n = await this.db.caseNote.create({ data: { caseId: c.id, authorId: ctx.userId, body: str(b.body, 'body', { max: 20000 }) } });
    await audit(this.db, ctx, 'case.note.add', `case:${c.id}`, { note: n.id });
    const u = ctx.userId ? await this.db.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }) : null;
    return { id: n.id, body: n.body, authorId: n.authorId, author: u?.name ?? null, createdAt: n.createdAt };
  }

  @Perm('cases.manage')
  @Delete('case-notes/:id')
  async removeNote(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const n = found(await this.db.caseNote.findFirst({ where: { id: id(raw), case: { orgId: ctx.orgId } } }), 'Note not found');
    await this.db.caseNote.delete({ where: { id: n.id } });
    await audit(this.db, ctx, 'case.note.delete', `case:${n.caseId}`, { note: n.id });
    return { ok: true };
  }

  // ----- files -----
  @Perm('cases.manage')
  @Post('cases/:id/files')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: UPLOAD_DIR, filename: (_req, _file, cb) => cb(null, randomBytes(16).toString('hex')) }),
      limits: { fileSize: MAX_FILE, files: 1 },
      fileFilter: (_req, file, cb) => {
        const t = ext(cleanName(file.originalname));
        cb(FILE_TYPES[t] ? null : new BadRequestException(`File type ".${t}" is not allowed. Allowed: ${Object.keys(FILE_TYPES).join(', ')}`), !!FILE_TYPES[t]);
      },
    }),
  )
  async upload(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Attach a file in the "file" form field (max 20 MB)');
    try {
      const c = await this.cases.own(ctx, raw);
      const name = cleanName(file.originalname);
      const type = FILE_TYPES[ext(name)];
      if (type.magic && !startsWith(file.path, type.magic)) throw new BadRequestException(`The file content does not look like a .${ext(name)} file`);
      const f = await this.db.caseFile.create({ data: { caseId: c.id, name, storedName: file.filename, size: file.size, mime: type.mime, uploadedById: ctx.userId } });
      await audit(this.db, ctx, 'case.file.upload', `case:${c.id}`, { file: f.id, name, size: f.size });
      return { id: f.id, name: f.name, size: f.size, mime: f.mime, createdAt: f.createdAt };
    } catch (e) {
      rm(file.path); // never keep an upload that was rejected
      throw e;
    }
  }

  @Perm('cases.view')
  @Get('case-files/:id')
  async download(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Res() res: Response) {
    const f = found(await this.db.caseFile.findFirst({ where: { id: id(raw), case: { orgId: ctx.orgId } } }), 'File not found');
    const path = join(UPLOAD_DIR, f.storedName);
    if (!existsSync(path)) throw new NotFoundException('The file is missing from storage');
    await audit(this.db, ctx, 'case.file.download', `case:${f.caseId}`, { file: f.id, name: f.name });
    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', String(f.size));
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    createReadStream(path).pipe(res);
  }

  @Perm('cases.manage')
  @Delete('case-files/:id')
  async removeFile(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const f = found(await this.db.caseFile.findFirst({ where: { id: id(raw), case: { orgId: ctx.orgId } } }), 'File not found');
    await this.db.caseFile.delete({ where: { id: f.id } });
    rm(join(UPLOAD_DIR, f.storedName));
    await audit(this.db, ctx, 'case.file.delete', `case:${f.caseId}`, { file: f.id, name: f.name });
    return { ok: true };
  }

  // ----- graph snapshots (9B): many named snapshots per case; saving never overwrites -----
  @Perm('cases.view')
  @Get('cases/:id/graphs')
  async graphs(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    return this.cases.graphList(ctx, (await this.cases.own(ctx, raw)).id);
  }

  /** Body: { name, remarks?, elements, png?, depth?, filters? }. */
  @Perm('cases.manage')
  @Post('cases/:id/graphs')
  async addGraph(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const c = await this.cases.own(ctx, raw);
    return this.saveGraph(ctx, c.id, b, str(b.name, 'name', { max: 200 }));
  }

  /** Kept for older clients: saves a NEW snapshot with a generated name (it no longer replaces anything). */
  @Perm('cases.manage')
  @Put('cases/:id/graph')
  async putGraph(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const c = await this.cases.own(ctx, raw);
    const st = graphStats(b?.elements);
    return this.saveGraph(ctx, c.id, b, str(b?.name, 'name', { optional: true, max: 200 }) || `Graph ${st.root ? st.root.slice(0, 8) + '… ' : ''}${new Date().toISOString().slice(0, 10)}`);
  }

  private async saveGraph(ctx: Ctx, caseId: number, b: any, name: string) {
    if (!b.elements || typeof b.elements !== 'object') throw new BadRequestException('elements must be Cytoscape elements JSON');
    let png: string | null = null;
    if (b.png !== undefined && b.png !== null) {
      if (typeof b.png !== 'string' || b.png.length > MAX_PNG || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.png)) {
        throw new BadRequestException('png must be a base64 PNG data URL of at most 8 MB');
      }
      png = b.png;
    }
    const st = graphStats(b.elements);
    const f = b.filters && typeof b.filters === 'object' ? b.filters : {};
    const filters = Object.fromEntries(['fanout', 'from', 'to', 'min', 'asset'].filter((k) => ['string', 'number'].includes(typeof f[k])).map((k) => [k, f[k]]));
    const g = await this.db.caseGraph.create({
      data: { caseId, name, remarks: str(b.remarks, 'remarks', { optional: true, max: 5000 }), chain: st.chain, rootAddress: st.root, depth: b.depth === undefined || b.depth === null ? null : int(b.depth, 1, 1, 3), filters, graphJson: b.elements, graphPng: png, nodeCount: st.nodes, edgeCount: st.edges, createdById: ctx.userId },
      select: GRAPH_COLS,
    });
    await audit(this.db, ctx, 'case.graph.save', `case:${caseId}`, { graph: g.id, name, nodes: st.nodes });
    return g;
  }

  private async ownGraph(ctx: Ctx, raw: string) {
    return found(await this.db.caseGraph.findFirst({ where: { id: id(raw), case: { orgId: ctx.orgId } } }), 'Graph not found');
  }

  /** The newest snapshot of a case, in full (what "Open in graph" loads when no snapshot is named). */
  @Perm('cases.view')
  @Get('cases/:id/graphs/latest')
  async latestGraph(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const c = await this.cases.own(ctx, raw);
    return found(await this.db.caseGraph.findFirst({ where: { caseId: c.id }, orderBy: { createdAt: 'desc' } }), 'No graph saved on this case');
  }

  @Perm('cases.view')
  @Get('case-graphs/:id')
  async graph(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    return this.ownGraph(ctx, raw);
  }

  /** Rename and / or edit remarks. The graph itself is never changed. */
  @Perm('cases.manage')
  @Patch('case-graphs/:id')
  async updateGraph(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const g = await this.ownGraph(ctx, raw);
    const data: Prisma.CaseGraphUpdateInput = {};
    if (b.name !== undefined) data.name = str(b.name, 'name', { max: 200 });
    if (b.remarks !== undefined) data.remarks = str(b.remarks, 'remarks', { optional: true, max: 5000 });
    const u = await this.db.caseGraph.update({ where: { id: g.id }, data, select: GRAPH_COLS });
    await audit(this.db, ctx, 'case.graph.update', `case:${g.caseId}`, { graph: g.id, ...data } as object);
    return u;
  }

  @Perm('cases.manage')
  @Delete('case-graphs/:id')
  async removeGraph(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const g = await this.ownGraph(ctx, raw);
    await this.db.caseGraph.delete({ where: { id: g.id } });
    await audit(this.db, ctx, 'case.graph.delete', `case:${g.caseId}`, { graph: g.id, name: g.name });
    return { ok: true };
  }

  // ----- timeline, report, csv -----
  @Perm('cases.view')
  @Get('cases/:id/timeline')
  async timeline(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    return this.cases.timeline(await this.cases.own(ctx, raw)); // { transfers, warnings }
  }

  @Perm('export.data')
  @Get('cases/:id/report')
  async report(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const c = await this.cases.own(ctx, raw);
    const [addresses, { transfers, warnings }, me, graphs, images] = await Promise.all([
      this.db.caseAddress.findMany({ where: { caseId: c.id }, orderBy: { id: 'asc' } }),
      this.cases.timeline(c),
      ctx.userId ? this.db.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } }) : null,
      this.cases.graphList(ctx, c.id),
      this.db.caseGraph.findMany({ where: { caseId: c.id, graphPng: { not: null } }, orderBy: { createdAt: 'desc' }, take: MAX_REPORT_IMAGES, select: { id: true, graphPng: true } }),
    ]);
    const png = new Map(images.map((i) => [i.id, i.graphPng]));
    const withRisk = [];
    for (const a of addresses.slice(0, MAX_TIMELINE_ADDRESSES)) {
      try {
        const r = await this.risk.assess(a.chain as Chain, a.address, ctx.orgId, { deep: false });
        withRisk.push({ ...addrView(a), risk: { score: r.score, level: r.level, reasons: r.reasons } });
      } catch (e) {
        withRisk.push({ ...addrView(a), risk: { score: null, level: null, reasons: [`Risk could not be computed: ${(e as Error).message}`] } });
      }
    }
    await audit(this.db, ctx, 'case.report', `case:${c.id}`);
    return {
      case: { id: c.id, title: c.title, description: c.description, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt },
      addresses: withRisk,
      graphs: graphs.map((g) => ({ ...g, image: png.get(g.id) ?? null })),
      timeline: transfers,
      totals: { transfers: transfers.length, volume: transfers.reduce((s, t) => s + t.amount, 0) },
      warnings,
      generatedAt: new Date().toISOString(),
      generatedBy: me ? `${me.name} <${me.email}>` : 'API',
    };
  }

  @Perm('export.data')
  @Get('cases/:id/transfers.csv')
  async csv(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Res() res: Response) {
    const c = await this.cases.own(ctx, raw);
    const { transfers } = await this.cases.timeline(c);
    await audit(this.db, ctx, 'case.export', `case:${c.id}`, { transfers: transfers.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="case-${c.id}-transfers.csv"`);
    res.send(toCsv([['time_utc', 'hop', 'from', 'to', 'asset', 'amount', 'tx_hash'], ...transfers.map((t) => [new Date(t.timestamp).toISOString(), t.hop, t.from, t.to, t.asset.toUpperCase(), t.amount, t.hash])]));
  }
}
