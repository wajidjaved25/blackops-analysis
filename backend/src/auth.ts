import {
  Body,
  CanActivate,
  Controller,
  createParamDecorator,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  Param,
  Patch,
  Post,
  Req,
  Res,
  SetMetadata,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { audit, Ctx, Db } from './db';
import { id, oneOf, str } from './util';

// ---------- decorators ----------
export const Public = () => SetMetadata('public', true);
export const ApiKeyAuth = () => SetMetadata('apiKey', true);
export const Roles = (...roles: Ctx['role'][]) => SetMetadata('roles', roles);
/** Lets viewers call this non-GET route (e.g. logout, change own password). */
export const ViewerAllowed = () => SetMetadata('viewerAllowed', true);
export const CurrentCtx = createParamDecorator((_: unknown, ctx: ExecutionContext): Ctx => ctx.switchToHttp().getRequest().ctx);

const ROLES = ['admin', 'analyst', 'viewer'] as const;
const SESSION_DAYS = 14;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function password(raw: unknown): string {
  const pw = typeof raw === 'string' ? raw : '';
  if (pw.length < 10) throw new BadRequestException('Password must be at least 10 characters');
  if (pw.length > 200) throw new BadRequestException('Password is too long');
  return pw;
}
function email(raw: unknown): string {
  const e = str(raw, 'email', { max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new BadRequestException('Invalid email address');
  return e;
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

// ponytail: in-memory limiters reset on restart and are per-instance. Move to Postgres/Redis when running >1 instance.
const hits = new Map<string, { start: number; n: number }>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > windowMs) {
    hits.set(key, { start: now, n: 1 });
    return false;
  }
  return ++h.n > max;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private db: Db,
  ) {}

  private meta<T>(key: string, ctx: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.meta<boolean>('public', context)) return true;
    const req = context.switchToHttp().getRequest<Request & { ctx?: Ctx }>();

    if (this.meta<boolean>('apiKey', context)) {
      const key = req.header('x-api-key');
      if (!key) throw new UnauthorizedException('Missing X-API-Key header');
      const k = await this.db.apiKey.findUnique({ where: { keyHash: sha256(key) } });
      if (!k || k.revokedAt) throw new UnauthorizedException('Invalid or revoked API key');
      if (limited(`key:${k.id}`, k.rateLimitPerMin, 60_000)) throw new HttpException('Rate limit exceeded for this API key', 429);
      await this.db.apiKey.update({ where: { id: k.id }, data: { usageCount: { increment: 1 }, lastUsedAt: new Date() } });
      req.ctx = { orgId: k.orgId, userId: null, role: 'api' };
      return true;
    }

    const token = cookie(req, 'sid');
    if (!token) throw new UnauthorizedException('Please sign in');
    const s = await this.db.session.findUnique({ where: { id: sha256(token) }, include: { user: true } });
    if (!s || s.expiresAt < new Date()) throw new UnauthorizedException('Session expired, please sign in again');
    const role = s.user.role as Ctx['role'];
    req.ctx = { orgId: s.user.orgId, userId: s.user.id, role };

    const roles = this.meta<Ctx['role'][]>('roles', context);
    if (roles && !roles.includes(role)) throw new ForbiddenException('You do not have permission for this action');
    if (role === 'viewer' && req.method !== 'GET' && !this.meta<boolean>('viewerAllowed', context)) {
      throw new ForbiddenException('Viewers have read-only access');
    }
    return true;
  }
}

@Controller('auth')
export class AuthController {
  constructor(private db: Db) {}

  private async startSession(res: Response, userId: number) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await this.db.session.create({ data: { id: sha256(token), userId, expiresAt } });
    await this.db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  }

  @Public()
  @Get('status')
  async status() {
    return { setupNeeded: (await this.db.user.count()) === 0 };
  }

  /** First-run only: creates the organisation and its first admin. */
  @Public()
  @Post('setup')
  async setup(@Body() b: any, @Res({ passthrough: true }) res: Response) {
    if ((await this.db.user.count()) > 0) throw new ForbiddenException('Setup is already complete');
    // Validate everything before writing anything.
    const orgName = str(b.orgName, 'Organisation name', { max: 100 });
    const data = { email: email(b.email), name: str(b.name, 'name', { max: 100 }), passwordHash: hashPassword(password(b.password)), role: 'admin' };
    const user = await this.db.$transaction(async (tx) => {
      const org = await tx.org.create({ data: { name: orgName } });
      return tx.user.create({ data: { ...data, orgId: org.id } });
    });
    await this.startSession(res, user.id);
    return { ok: true };
  }

  @Public()
  @Post('login')
  async login(@Body() b: any, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const e = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (limited(`login:${req.ip}`, 20, 15 * 60_000) || limited(`login:${e}`, 10, 15 * 60_000)) {
      throw new HttpException('Too many sign-in attempts. Try again in 15 minutes.', 429);
    }
    const user = await this.db.user.findUnique({ where: { email: e } });
    if (!user || !verifyPassword(String(b.password ?? ''), user.passwordHash)) throw new UnauthorizedException('Wrong email or password');
    await this.startSession(res, user.id);
    return { ok: true };
  }

  @ViewerAllowed()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = cookie(req, 'sid');
    if (token) await this.db.session.deleteMany({ where: { id: sha256(token) } });
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentCtx() ctx: Ctx) {
    const u = await this.db.user.findUnique({ where: { id: ctx.userId! }, include: { org: true } });
    return { id: u!.id, email: u!.email, name: u!.name, role: u!.role, org: { id: u!.org.id, name: u!.org.name } };
  }

  @ViewerAllowed()
  @Post('password')
  async changePassword(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const u = await this.db.user.findUnique({ where: { id: ctx.userId! } });
    if (!u || !verifyPassword(String(b.current ?? ''), u.passwordHash)) throw new UnauthorizedException('Current password is wrong');
    await this.db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(password(b.next)) } });
    return { ok: true };
  }
}

@Roles('admin')
@Controller('users')
export class UsersController {
  constructor(private db: Db) {}

  @Get()
  list(@CurrentCtx() ctx: Ctx) {
    return this.db.user.findMany({ where: { orgId: ctx.orgId }, select: { id: true, email: true, name: true, role: true, createdAt: true }, orderBy: { id: 'asc' } });
  }

  @Post()
  async create(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const e = email(b.email);
    if (await this.db.user.findUnique({ where: { email: e } })) throw new ConflictException('A user with this email already exists');
    const u = await this.db.user.create({
      data: { orgId: ctx.orgId, email: e, name: str(b.name, 'name', { max: 100 }), passwordHash: hashPassword(password(b.password)), role: oneOf(b.role, 'role', ROLES) },
    });
    await audit(this.db, ctx, 'user.create', `user:${u.id}`, { email: e, role: u.role });
    return { id: u.id };
  }

  @Patch(':id')
  async update(@CurrentCtx() ctx: Ctx, @Param('id') raw: string, @Body() b: any) {
    const uid = id(raw);
    if (uid === ctx.userId) throw new BadRequestException('You cannot change your own role');
    const role = oneOf(b.role, 'role', ROLES);
    const r = await this.db.user.updateMany({ where: { id: uid, orgId: ctx.orgId }, data: { role } });
    if (!r.count) throw new BadRequestException('User not found');
    await this.db.session.deleteMany({ where: { userId: uid } }); // role change forces re-login
    await audit(this.db, ctx, 'user.role', `user:${uid}`, { role });
    return { ok: true };
  }

  @Delete(':id')
  async remove(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const uid = id(raw);
    if (uid === ctx.userId) throw new BadRequestException('You cannot delete yourself');
    const r = await this.db.user.deleteMany({ where: { id: uid, orgId: ctx.orgId } });
    if (!r.count) throw new BadRequestException('User not found');
    await audit(this.db, ctx, 'user.delete', `user:${uid}`);
    return { ok: true };
  }
}

@Roles('admin')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private db: Db) {}

  @Get()
  list(@CurrentCtx() ctx: Ctx) {
    return this.db.apiKey.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true, prefix: true, rateLimitPerMin: true, usageCount: true, lastUsedAt: true, revokedAt: true, createdAt: true }, orderBy: { id: 'desc' } });
  }

  /** The full key is returned once; only its hash is stored. */
  @Post()
  async create(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const key = 'ut_' + randomBytes(24).toString('base64url');
    const k = await this.db.apiKey.create({
      data: { orgId: ctx.orgId, name: str(b.name, 'name', { max: 100 }), prefix: key.slice(0, 8), keyHash: sha256(key), rateLimitPerMin: Math.min(1000, Math.max(1, Number(b.rateLimitPerMin) || 60)) },
    });
    await audit(this.db, ctx, 'apikey.create', `apikey:${k.id}`, { name: k.name });
    return { id: k.id, key };
  }

  @Delete(':id')
  async revoke(@CurrentCtx() ctx: Ctx, @Param('id') raw: string) {
    const r = await this.db.apiKey.updateMany({ where: { id: id(raw), orgId: ctx.orgId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw new BadRequestException('Key not found or already revoked');
    await audit(this.db, ctx, 'apikey.revoke', `apikey:${raw}`);
    return { ok: true };
  }
}

@Roles('admin')
@Controller('audit')
export class AuditController {
  constructor(private db: Db) {}

  @Get()
  async list(@CurrentCtx() ctx: Ctx) {
    const rows = await this.db.auditLog.findMany({ where: { orgId: ctx.orgId }, orderBy: { id: 'desc' }, take: 300 });
    const users = await this.db.user.findMany({ where: { orgId: ctx.orgId }, select: { id: true, email: true } });
    const email = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => ({ ...r, user: r.userId ? email.get(r.userId) ?? `user:${r.userId}` : 'API key' }));
  }
}
