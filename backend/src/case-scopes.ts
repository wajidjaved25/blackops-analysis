// Saved analysis scopes (Phase 10C): named, reusable scopes per case. A run copies the scope it uses, so edits here never change a past run.
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrentCtx, Perm } from './auth';
import { assertNameFree, assertSelectedInCase, filterScope, parseSavedScope, parseScope, parseScopeDescription, parseScopeName, Scope } from './case-scope';
import { CasesService } from './cases';
import { audit, Ctx, Db } from './db';
import { found, id } from './util';

const COLS = { id: true, caseId: true, name: true, description: true, scope: true, createdById: true, createdAt: true, updatedAt: true } as const;

@Controller()
export class CaseScopesController {
  constructor(private db: Db, private cases: CasesService) {}

  /** Saved scopes of a case with the live "N of M": one read of the case's rows, filtered in memory for every scope (statement rows are only read when a scope filters by direction). */
  @Perm('cases.view')
  @Get('cases/:id/scopes')
  async list(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const c = await this.cases.own(ctx, raw);
    const rows = await this.db.caseScope.findMany({ where: { caseId: c.id }, orderBy: { name: 'asc' }, select: COLS });
    if (!rows.length) return [];
    const parsed = rows.map((r) => { try { return parseScope(r.scope); } catch { return undefined; } }); // undefined: stored scope no longer valid
    const txs = await this.db.caseTransaction.findMany({ where: { caseId: c.id }, omit: parsed.some((s) => s?.direction) ? {} : { raw: true } });
    return rows.map((r, i) => ({ ...r, inScope: parsed[i] === undefined ? null : filterScope(txs, parsed[i]!).length, total: txs.length }));
  }

  /** Body: { name, description?, scope }. Selected ids and statement files must belong to this case. */
  @Perm('cases.manage')
  @Post('cases/:id/scopes')
  async create(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: Record<string, unknown>) {
    const c = await this.cases.own(ctx, raw);
    const name = parseScopeName(b?.name), description = parseScopeDescription(b?.description), scope = parseSavedScope(b?.scope);
    await this.assertRefs(c.id, scope);
    assertNameFree(name, (await this.db.caseScope.findMany({ where: { caseId: c.id }, select: { name: true } })).map((x) => x.name));
    try {
      const s = await this.db.caseScope.create({ data: { caseId: c.id, name, description, scope: scope as never, createdById: ctx.userId }, select: COLS });
      await audit(this.db, ctx, 'case.scope.create', `case:${c.id}`, { scope: s.id, name, mode: scope.mode });
      return s;
    } catch (e) {
      throw this.dup(e, name);
    }
  }

  private dup(e: unknown, name: string) {
    return (e as Prisma.PrismaClientKnownRequestError).code === 'P2002' ? new ConflictException(`A saved scope named "${name}" already exists in this case`) : e;
  }

  private async own(ctx: Ctx, raw: string) {
    return found(await this.db.caseScope.findFirst({ where: { id: id(raw), case: { orgId: ctx.orgId } } }), 'Saved scope not found');
  }

  /** Rename and / or edit the description. The scope itself is never changed (save a new one instead), and past runs are unaffected either way. */
  @Perm('cases.manage')
  @Patch('case-scopes/:sid')
  async update(@CurrentCtx() ctx: Ctx, @Param('sid') raw: string, @Body() b: Record<string, unknown>) {
    const s = await this.own(ctx, raw);
    const data: Prisma.CaseScopeUpdateInput = {};
    if (b?.name !== undefined) {
      data.name = parseScopeName(b.name);
      assertNameFree(data.name, (await this.db.caseScope.findMany({ where: { caseId: s.caseId, id: { not: s.id } }, select: { name: true } })).map((x) => x.name));
    }
    if (b?.description !== undefined) data.description = parseScopeDescription(b.description);
    try {
      const u = await this.db.caseScope.update({ where: { id: s.id }, data, select: COLS });
      await audit(this.db, ctx, 'case.scope.update', `case:${s.caseId}`, { scope: s.id, ...data } as object);
      return u;
    } catch (e) {
      throw this.dup(e, String(data.name));
    }
  }

  @Perm('cases.manage')
  @Delete('case-scopes/:sid')
  async remove(@CurrentCtx() ctx: Ctx, @Param('sid') raw: string) {
    const s = await this.own(ctx, raw);
    await this.db.caseScope.delete({ where: { id: s.id } });
    await audit(this.db, ctx, 'case.scope.delete', `case:${s.caseId}`, { scope: s.id, name: s.name });
    return { ok: true };
  }

  private async assertRefs(caseId: number, scope: Scope) {
    if (scope.mode === 'selected') {
      const have = await this.db.caseTransaction.findMany({ where: { caseId, id: { in: scope.transactionIds } }, select: { id: true } });
      assertSelectedInCase(scope.transactionIds!, new Set(have.map((t) => t.id)));
    }
    if (scope.fileIds) {
      const have = new Set((await this.db.caseFile.findMany({ where: { caseId, id: { in: scope.fileIds } }, select: { id: true } })).map((f) => f.id));
      const bad = scope.fileIds.filter((x) => !have.has(x));
      if (bad.length) throw new BadRequestException(`Statement file ${bad.join(', ')} does not belong to this case`);
    }
  }
}
