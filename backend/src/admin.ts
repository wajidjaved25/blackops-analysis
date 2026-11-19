import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { CurrentCtx, email, hashPassword, password, Perm } from './auth';
import { audit, Ctx, Db } from './db';
import { ALL_PERMS, missing } from './permissions';
import { sha256 } from './totp';
import { found, id, int, str } from './util';

const isOwner = (r: { system: boolean; name: string }) => r.system && r.name === 'Owner';

/** Validates a permission list: known keys only, and nothing the caller does not hold. */
function grantable(ctx: Ctx, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string')) throw new BadRequestException('permissions must be a list of permission keys');
  const perms = [...new Set(raw as string[])];
  const unknown = perms.filter((p) => !ALL_PERMS.includes(p));
  if (unknown.length) throw new BadRequestException(`Unknown permissions: ${unknown.join(', ')}`);
  const lacking = missing(ctx.permissions, perms);
  if (lacking.length) throw new ForbiddenException(`You cannot grant permissions you do not hold: ${lacking.join(', ')}`);
  return perms;
}

@Controller('roles')
export class RolesController {
  constructor(private db: Db) {}

  @Perm('users.manage', 'roles.manage')
  @Get()
  async list(@CurrentCtx() ctx: Ctx) {
    const rows = await this.db.role.findMany({ where: { orgId: ctx.orgId }, include: { _count: { select: { users: true } } }, orderBy: { id: 'asc' } });
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, system: r.system, permissions: r.permissions, users: r._count.users }));
  }

  @Perm('roles.manage')
  @Post()
  async create(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const name = str(b.name, 'name', { max: 60 });
    const permissions = grantable(ctx, b.permissions);
    if (await this.db.role.findUnique({ where: { orgId_name: { orgId: ctx.orgId, name } } })) throw new ConflictException('A role with this name already exists');
    const r = await this.db.role.create({ data: { orgId: ctx.orgId, name, description: str(b.description, 'description', { optional: true, max: 300 }), permissions } });
    await audit(this.db, ctx, 'role.create', `role:${r.id}`, { name, permissions });
    return { id: r.id, name: r.name, description: r.description, system: false, permissions: r.permissions, users: 0 };
  }

  @Perm('roles.manage')
  @Patch(':id')
  async update(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const r = found(await this.db.role.findFirst({ where: { id: id(raw), orgId: ctx.orgId } }), 'Role not found');
    if (r.system) throw new BadRequestException('Built-in roles cannot be changed');
    const data: Prisma.RoleUpdateInput = {};
    if (b.name !== undefined) data.name = str(b.name, 'name', { max: 60 });
    if (b.description !== undefined) data.description = str(b.description, 'description', { optional: true, max: 300 });
    if (b.permissions !== undefined) {
      if (!Array.isArray(b.permissions)) throw new BadRequestException('permissions must be a list of permission keys');
      // Only newly added permissions must be held by the editor; existing ones may stay.
      const added = (b.permissions as string[]).filter((p) => !r.permissions.includes(p));
      grantable(ctx, added);
      data.permissions = grantable({ ...ctx, permissions: ALL_PERMS }, b.permissions);
    }
    try {
      const u = await this.db.role.update({ where: { id: r.id }, data });
      await audit(this.db, ctx, 'role.update', `role:${r.id}`, { name: u.name, permissions: u.permissions });
      return { id: u.id, name: u.name, description: u.description, system: false, permissions: u.permissions };
    } catch (e) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') throw new ConflictException('A role with this name already exists');
      throw e;
    }
  }

  @Perm('roles.manage')
  @Delete(':id')
  async remove(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const r = found(await this.db.role.findFirst({ where: { id: id(raw), orgId: ctx.orgId }, include: { _count: { select: { users: true } } } }), 'Role not found');
    if (r.system) throw new BadRequestException('Built-in roles cannot be deleted');
    if (r._count.users) throw new BadRequestException(`${r._count.users} user(s) still have this role. Reassign them first.`);
    await this.db.role.delete({ where: { id: r.id } });
    await audit(this.db, ctx, 'role.delete', `role:${r.id}`, { name: r.name });
    return { ok: true };
  }
}

@Controller('users')
export class UsersController {
  constructor(private db: Db) {}

  private async target(ctx: Ctx, raw: string) {
    return found(await this.db.user.findFirst({ where: { id: id(raw), orgId: ctx.orgId }, include: { role: true } }), 'User not found');
  }

  /** You may only change users whose role holds nothing you lack (an Admin cannot touch an Owner). */
  private guardTarget(ctx: Ctx, t: { role: { permissions: string[] } }) {
    if (missing(ctx.permissions, t.role.permissions).length) throw new ForbiddenException('This user has more permissions than you, so you cannot change them');
  }

  private async assertNotLastOwner(t: { id: number; orgId: number; status: string; role: { system: boolean; name: string } }) {
    if (!isOwner(t.role) || t.status !== 'active') return;
    const others = await this.db.user.count({ where: { orgId: t.orgId, id: { not: t.id }, status: 'active', role: { system: true, name: 'Owner' } } });
    if (!others) throw new BadRequestException('There must always be at least one active Owner');
  }

  @Perm('users.manage')
  @Get()
  async list(@CurrentCtx() ctx: Ctx) {
    const rows = await this.db.user.findMany({ where: { orgId: ctx.orgId }, include: { role: { select: { id: true, name: true } } }, orderBy: { id: 'asc' } });
    return rows.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, totpEnabled: u.totpEnabled, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt }));
  }

  @Perm('users.manage')
  @Post()
  async create(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const e = email(b.email);
    const pw = password(b.password, e);
    const role = found(await this.db.role.findFirst({ where: { id: id(b.roleId), orgId: ctx.orgId } }), 'Role not found');
    grantable(ctx, role.permissions);
    if (await this.db.user.findUnique({ where: { email: e } })) throw new ConflictException('A user with this email already exists');
    const u = await this.db.user.create({ data: { orgId: ctx.orgId, email: e, name: str(b.name, 'name', { max: 100 }), passwordHash: hashPassword(pw), roleId: role.id, mustChangePassword: true } });
    await audit(this.db, ctx, 'user.create', `user:${u.id}`, { email: e, role: role.name });
    return { id: u.id };
  }

  @Perm('users.manage')
  @Patch(':id')
  async update(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const t = await this.target(ctx, raw);
    const data: Prisma.UserUpdateInput = {};
    const detail: Record<string, unknown> = {};
    if (b.name !== undefined) data.name = str(b.name, 'name', { max: 100 });
    const changesAccess = b.roleId !== undefined || b.status !== undefined;
    if (changesAccess) {
      if (t.id === ctx.userId) throw new BadRequestException('You cannot change your own role or status');
      this.guardTarget(ctx, t);
    }
    if (b.roleId !== undefined) {
      const role = found(await this.db.role.findFirst({ where: { id: id(b.roleId), orgId: ctx.orgId } }), 'Role not found');
      grantable(ctx, role.permissions);
      if (role.id !== t.roleId) await this.assertNotLastOwner(t);
      data.role = { connect: { id: role.id } };
      detail.role = role.name;
    }
    if (b.status !== undefined) {
      if (b.status !== 'active' && b.status !== 'disabled') throw new BadRequestException('status must be one of: active, disabled');
      if (b.status === 'disabled') await this.assertNotLastOwner(t);
      data.status = b.status;
      detail.status = b.status;
    }
    await this.db.user.update({ where: { id: t.id }, data });
    if (b.status === 'disabled') await this.db.session.deleteMany({ where: { userId: t.id } });
    await audit(this.db, ctx, 'user.update', `user:${t.id}`, { email: t.email, ...detail, ...(data.name ? { name: data.name } : {}) });
    return { ok: true };
  }

  @Perm('users.manage')
  @Post(':id/reset-2fa')
  async reset2fa(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const t = await this.target(ctx, raw);
    this.guardTarget(ctx, t);
    await this.db.user.update({ where: { id: t.id }, data: { totpEnabled: false, totpSecret: null, recoveryCodes: [], totpLastStep: 0 } });
    await audit(this.db, ctx, 'user.reset_2fa', `user:${t.id}`, { email: t.email });
    return { ok: true };
  }

  @Perm('users.manage')
  @Post(':id/revoke-sessions')
  async revokeSessions(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const t = await this.target(ctx, raw);
    this.guardTarget(ctx, t);
    const r = await this.db.session.deleteMany({ where: { userId: t.id } });
    await audit(this.db, ctx, 'user.revoke_sessions', `user:${t.id}`, { email: t.email, sessions: r.count });
    return { ok: true, revoked: r.count };
  }

  @Perm('users.manage')
  @Delete(':id')
  async remove(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const t = await this.target(ctx, raw);
    if (t.id === ctx.userId) throw new BadRequestException('You cannot delete yourself');
    this.guardTarget(ctx, t);
    await this.assertNotLastOwner(t);
    await this.db.user.delete({ where: { id: t.id } });
    await audit(this.db, ctx, 'user.delete', `user:${t.id}`, { email: t.email });
    return { ok: true };
  }
}

@Controller('org')
export class OrgController {
  constructor(private db: Db) {}

  private view = (o: { id: number; name: string; require2fa: boolean; sessionDays: number }) => ({ id: o.id, name: o.name, require2fa: o.require2fa, sessionDays: o.sessionDays });

  @Perm('org.manage')
  @Get()
  async get(@CurrentCtx() ctx: Ctx) {
    return this.view(await this.db.org.findUniqueOrThrow({ where: { id: ctx.orgId } }));
  }

  @Perm('org.manage')
  @Patch()
  async update(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const data: Prisma.OrgUpdateInput = {};
    if (b.name !== undefined) data.name = str(b.name, 'name', { max: 100 });
    if (b.require2fa !== undefined) {
      if (typeof b.require2fa !== 'boolean') throw new BadRequestException('require2fa must be true or false');
      data.require2fa = b.require2fa;
    }
    if (b.sessionDays !== undefined) {
      const d = Number(b.sessionDays);
      if (!Number.isInteger(d) || d < 1 || d > 90) throw new BadRequestException('sessionDays must be a whole number from 1 to 90');
      data.sessionDays = d;
    }
    const o = await this.db.org.update({ where: { id: ctx.orgId }, data });
    await audit(this.db, ctx, 'org.update', `org:${o.id}`, data as object);
    return this.view(o);
  }
}

@Controller('api-keys')
export class ApiKeysController {
  constructor(private db: Db) {}

  @Perm('apikeys.manage')
  @Get()
  async list(@CurrentCtx() ctx: Ctx) {
    const rows = await this.db.apiKey.findMany({ where: { orgId: ctx.orgId }, orderBy: { id: 'desc' } });
    const users = await this.db.user.findMany({ where: { orgId: ctx.orgId }, select: { id: true, email: true } });
    const who = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, rateLimitPerMin: k.rateLimitPerMin, usageCount: k.usageCount, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, createdAt: k.createdAt, createdBy: k.createdById ? who.get(k.createdById) ?? null : null }));
  }

  /** The full key is returned once; only its hash is stored. */
  @Perm('apikeys.manage')
  @Post()
  async create(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const key = 'ut_' + randomBytes(24).toString('base64url');
    const k = await this.db.apiKey.create({
      data: { orgId: ctx.orgId, name: str(b.name, 'name', { max: 100 }), prefix: key.slice(0, 8), keyHash: sha256(key), createdById: ctx.userId, rateLimitPerMin: int(b.rateLimitPerMin, 60, 1, 1000) },
    });
    await audit(this.db, ctx, 'apikey.create', `apikey:${k.id}`, { name: k.name });
    return { id: k.id, key };
  }

  @Perm('apikeys.manage')
  @Delete(':id')
  async revoke(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const r = await this.db.apiKey.updateMany({ where: { id: id(raw), orgId: ctx.orgId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw new BadRequestException('Key not found or already revoked');
    await audit(this.db, ctx, 'apikey.revoke', `apikey:${raw}`);
    return { ok: true };
  }
}

@Controller('audit')
export class AuditController {
  constructor(private db: Db) {}

  @Perm('audit.view')
  @Get()
  async list(@CurrentCtx() ctx: Ctx, @Query('action') action?: string, @Query('userId') userId?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('page') page?: string) {
    const date = (v: string | undefined, name: string) => {
      if (!v) return undefined;
      const d = new Date(/^\d+$/.test(v) ? Number(v) : v);
      if (isNaN(d.getTime())) throw new BadRequestException(`Invalid ${name} date`);
      return d;
    };
    const p = int(page, 0, 0, 100000);
    const gte = date(from, 'from');
    const lte = date(to, 'to');
    const where: Prisma.AuditLogWhereInput = {
      orgId: ctx.orgId,
      ...(action ? { action: { startsWith: action.slice(0, 60) } } : {}), // "user" matches user.create, user.update, ...
      ...(userId ? { userId: id(userId) } : {}),
      ...(gte || lte ? { createdAt: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([this.db.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: p * 50, take: 50 }), this.db.auditLog.count({ where })]);
    const users = await this.db.user.findMany({ where: { orgId: ctx.orgId, id: { in: [...new Set(rows.map((r) => r.userId).filter((x): x is number => x !== null))] } }, select: { id: true, email: true } });
    const who = new Map(users.map((u) => [u.id, u.email]));
    return {
      rows: rows.map((r) => ({ id: r.id, action: r.action, target: r.target, detail: r.detail, createdAt: r.createdAt, ip: r.ip, user: r.userId ? who.get(r.userId) ?? `user:${r.userId}` : 'API key' })),
      total,
      page: p,
      pageSize: 50,
    };
  }
}
