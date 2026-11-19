import {
  BadRequestException,
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
  OnModuleInit,
  Param,
  Post,
  Req,
  Res,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { audit, Ctx, Db } from './db';
import { rateClear, rateLimited, rateReached } from './kv';
import { ensureSystemRoles, hasAny, PERMISSIONS } from './permissions';
import { newRecoveryCodes, newSecret, openSecret, otpauthUrl, recoveryHash, sealSecret, sha256, verifyTotp } from './totp';
import { str } from './util';

// ---------- decorators ----------
export const Public = () => SetMetadata('public', true);
export const ApiKeyAuth = () => SetMetadata('apiKey', true);
/** Route needs at least one of these permissions. Routes with no decorator at all are refused (fail closed). */
export const Perm = (...perms: string[]) => SetMetadata('perm', perms);
/** Any signed-in user, even one who still has to change their password or enrol 2FA. */
export const Authed = () => SetMetadata('authed', true);
export const CurrentCtx = createParamDecorator((_: unknown, ctx: ExecutionContext): Ctx => ctx.switchToHttp().getRequest().ctx);

// ---------- passwords ----------
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
const DUMMY_HASH = hashPassword('not-a-real-password'); // verified when the email is unknown, so timing does not reveal accounts

/** Policy: 12–200 chars, not the email address. */
export function password(raw: unknown, email: string): string {
  const pw = typeof raw === 'string' ? raw : '';
  if (pw.length < 12) throw new BadRequestException('Password must be at least 12 characters');
  if (pw.length > 200) throw new BadRequestException('Password is too long');
  if (pw.toLowerCase() === email.toLowerCase()) throw new BadRequestException('Password must not be your email address');
  return pw;
}
export function email(raw: unknown): string {
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

const err = (status: number, message: string, code: string) =>
  new HttpException({ statusCode: status, message, error: status === 401 ? 'Unauthorized' : 'Forbidden', code }, status);

// ---------- guard ----------
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
      if (await rateLimited(`key:${k.id}`, k.rateLimitPerMin, 60_000)) throw new HttpException('Rate limit exceeded for this API key', 429);
      await this.db.apiKey.update({ where: { id: k.id }, data: { usageCount: { increment: 1 }, lastUsedAt: new Date() } });
      req.ctx = { orgId: k.orgId, userId: null, permissions: [], ip: req.ip };
      return true;
    }

    const token = cookie(req, 'sid');
    if (!token) throw new UnauthorizedException('Please sign in');
    const s = await this.db.session.findUnique({ where: { id: sha256(token) }, include: { user: { include: { role: true, org: true } } } });
    if (!s || s.expiresAt < new Date()) throw new UnauthorizedException('Session expired, please sign in again');
    const u = s.user;
    if (u.status !== 'active') throw err(401, 'Your account is disabled. Contact an administrator.', 'USER_DISABLED');
    if (Date.now() - s.lastSeenAt.getTime() > 60_000) {
      this.db.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date(), ip: req.ip } }).catch(() => undefined);
    }
    req.ctx = { orgId: u.orgId, userId: u.id, permissions: u.role.permissions, ip: req.ip };

    if (this.meta<boolean>('authed', context)) return true;
    if (u.mustChangePassword) throw err(403, 'You must change your password before continuing', 'PASSWORD_CHANGE_REQUIRED');
    if (u.org.require2fa && !u.totpEnabled) throw err(403, 'Your organisation requires two-factor authentication. Enrol before continuing.', 'TOTP_ENROLL_REQUIRED');
    const need = this.meta<string[]>('perm', context);
    if (!need) throw new ForbiddenException('This route has no permission configured');
    if (!hasAny(u.role.permissions, need)) throw new ForbiddenException('You do not have permission for this action');
    return true;
  }
}

/** System roles are code-defined: sync their permissions for every org at boot, so new permissions reach existing orgs. */
@Injectable()
export class RoleSeeder implements OnModuleInit {
  constructor(private db: Db) {}
  async onModuleInit() {
    for (const o of await this.db.org.findMany({ select: { id: true } })) await ensureSystemRoles(this.db, o.id);
  }
}

// ---------- auth routes ----------
@Controller()
export class AuthController {
  constructor(private db: Db) {}

  private async startSession(req: Request, res: Response, userId: number, days: number) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    await this.db.session.create({ data: { id: sha256(token), userId, expiresAt, ip: req.ip, userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) } });
    await this.db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${secure}`);
  }

  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }

  @Authed()
  @Get('permissions')
  permissions() {
    return PERMISSIONS;
  }

  @Public()
  @Get('auth/status')
  async status() {
    return { setupNeeded: (await this.db.user.count()) === 0 };
  }

  /** First-run only: creates the organisation, its system roles and the first Owner. */
  @Public()
  @Post('auth/setup')
  async setup(@Body() b: any, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Validate everything before writing anything.
    const orgName = str(b.orgName, 'Organisation name', { max: 100 });
    const e = email(b.email);
    const data = { email: e, name: str(b.name, 'name', { max: 100 }), passwordHash: hashPassword(password(b.password, e)) };
    const user = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7001)`; // two simultaneous setups must not both pass the check
      if ((await tx.user.count()) > 0) throw new ForbiddenException('Setup is already complete');
      const org = await tx.org.create({ data: { name: orgName } });
      const roles = await ensureSystemRoles(tx, org.id);
      return tx.user.create({ data: { ...data, orgId: org.id, roleId: roles.Owner } });
    });
    await this.startSession(req, res, user.id, 14);
    await audit(this.db, { orgId: user.orgId, userId: user.id, permissions: [], ip: req.ip }, 'auth.setup', `user:${user.id}`);
    return { ok: true };
  }

  @Public()
  @Post('auth/login')
  async login(@Body() b: any, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const e = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    // Only failed attempts count: 20 per IP and 10 per account in 15 minutes. A successful login clears the account counter.
    if ((await rateReached(`login:${req.ip}`, 20)) || (await rateReached(`login:${e}`, 10))) {
      throw new HttpException('Too many failed sign-in attempts. Try again in 15 minutes.', 429);
    }
    const failed = () => Promise.all([rateLimited(`login:${req.ip}`, 20, 15 * 60_000), rateLimited(`login:${e}`, 10, 15 * 60_000)]);
    const user = await this.db.user.findUnique({ where: { email: e }, include: { org: true } });
    const ok = verifyPassword(String(b.password ?? ''), user?.passwordHash ?? DUMMY_HASH) && !!user;
    const ctx = (u: { orgId: number; id: number }): Ctx => ({ orgId: u.orgId, userId: u.id, permissions: [], ip: req.ip });
    if (!user || !ok) {
      await failed();
      if (user) await audit(this.db, ctx(user), 'auth.login_failed', `user:${user.id}`);
      throw new UnauthorizedException('Wrong email or password');
    }
    if (user.status !== 'active') {
      await audit(this.db, ctx(user), 'auth.login_blocked', `user:${user.id}`, { reason: 'disabled' });
      throw err(403, 'Your account is disabled. Contact an administrator.', 'USER_DISABLED');
    }

    let step: number | null = null;
    if (user.totpEnabled) {
      const code = typeof b.totp === 'string' ? b.totp.replace(/\s/g, '') : '';
      if (!code) throw err(401, 'Enter the 6-digit code from your authenticator app', 'TOTP_REQUIRED');
      step = verifyTotp(openSecret(user.totpSecret!), code, Date.now(), user.totpLastStep);
      if (step === null) {
        // A recovery code works once in place of the app code.
        const h = recoveryHash(code);
        if (!user.recoveryCodes.includes(h)) {
          await failed();
          await audit(this.db, ctx(user), 'auth.2fa_failed', `user:${user.id}`);
          throw err(401, 'That code is wrong or expired. Try again, or use a recovery code.', 'TOTP_REQUIRED');
        }
        await this.db.user.update({ where: { id: user.id }, data: { recoveryCodes: user.recoveryCodes.filter((c) => c !== h) } });
        await audit(this.db, ctx(user), 'auth.recovery_code_used', `user:${user.id}`, { remaining: user.recoveryCodes.length - 1 });
      }
    }
    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), ...(step ? { totpLastStep: step } : {}) } });
    await this.startSession(req, res, user.id, user.org.sessionDays);
    await rateClear(`login:${e}`);
    await audit(this.db, ctx(user), 'auth.login', `user:${user.id}`);
    return { ok: true };
  }

  @Authed()
  @Post('auth/logout')
  async logout(@CurrentCtx() ctx: Ctx, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = cookie(req, 'sid');
    if (token) await this.db.session.deleteMany({ where: { id: sha256(token) } });
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    await audit(this.db, ctx, 'auth.logout', `user:${ctx.userId}`);
    return { ok: true };
  }

  @Authed()
  @Get('auth/me')
  async me(@CurrentCtx() ctx: Ctx) {
    const u = await this.db.user.findUniqueOrThrow({ where: { id: ctx.userId! }, include: { org: true, role: true } });
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: { id: u.role.id, name: u.role.name },
      permissions: u.role.permissions,
      totpEnabled: u.totpEnabled,
      mustEnrollTotp: u.org.require2fa && !u.totpEnabled,
      mustChangePassword: u.mustChangePassword,
      org: { id: u.org.id, name: u.org.name, require2fa: u.org.require2fa },
    };
  }

  @Authed()
  @Post('auth/password')
  async changePassword(@CurrentCtx() ctx: Ctx, @Req() req: Request, @Body() b: any) {
    const u = await this.db.user.findUniqueOrThrow({ where: { id: ctx.userId! } });
    if (await rateLimited(`pw:${u.id}`, 10, 15 * 60_000)) throw new HttpException('Too many attempts. Try again later.', 429);
    if (!verifyPassword(String(b.current ?? ''), u.passwordHash)) throw new UnauthorizedException('Current password is wrong');
    const next = password(b.next, u.email);
    if (next === b.current) throw new BadRequestException('The new password must be different from the current one');
    await this.db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(next), mustChangePassword: false } });
    const token = cookie(req, 'sid');
    await this.db.session.deleteMany({ where: { userId: u.id, id: { not: token ? sha256(token) : '' } } }); // other devices must sign in again
    await audit(this.db, ctx, 'auth.password', `user:${u.id}`);
    return { ok: true };
  }

  // ----- 2FA -----
  @Authed()
  @Post('auth/2fa/setup')
  async setup2fa(@CurrentCtx() ctx: Ctx) {
    const u = await this.db.user.findUniqueOrThrow({ where: { id: ctx.userId! } });
    if (u.totpEnabled) throw new BadRequestException('Two-factor authentication is already enabled');
    const secret = newSecret();
    await this.db.user.update({ where: { id: u.id }, data: { totpSecret: sealSecret(secret) } });
    return { secret, otpauthUrl: otpauthUrl(u.email, secret) };
  }

  @Authed()
  @Post('auth/2fa/enable')
  async enable2fa(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const u = await this.db.user.findUniqueOrThrow({ where: { id: ctx.userId! } });
    if (u.totpEnabled) throw new BadRequestException('Two-factor authentication is already enabled');
    if (!u.totpSecret) throw new BadRequestException('Start setup first (POST /auth/2fa/setup)');
    if (await rateLimited(`2fa:${u.id}`, 10, 15 * 60_000)) throw new HttpException('Too many attempts. Try again later.', 429);
    const step = verifyTotp(openSecret(u.totpSecret), String(b.code ?? '').replace(/\s/g, ''));
    if (step === null) throw new BadRequestException('That code is wrong or expired. Check your authenticator app and try again.');
    const { codes, hashes } = newRecoveryCodes();
    await this.db.user.update({ where: { id: u.id }, data: { totpEnabled: true, totpLastStep: step, recoveryCodes: hashes } });
    await audit(this.db, ctx, 'auth.2fa_enabled', `user:${u.id}`);
    return { recoveryCodes: codes };
  }

  @Authed()
  @Post('auth/2fa/disable')
  async disable2fa(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const u = await this.db.user.findUniqueOrThrow({ where: { id: ctx.userId! }, include: { org: true } });
    if (u.org.require2fa) throw new BadRequestException('Your organisation requires two-factor authentication, so it cannot be turned off');
    if (!verifyPassword(String(b.password ?? ''), u.passwordHash)) throw new UnauthorizedException('Password is wrong');
    await this.db.user.update({ where: { id: u.id }, data: { totpEnabled: false, totpSecret: null, recoveryCodes: [], totpLastStep: 0 } });
    await audit(this.db, ctx, 'auth.2fa_disabled', `user:${u.id}`);
    return { ok: true };
  }

  // ----- own sessions -----
  @Authed()
  @Get('auth/sessions')
  async sessions(@CurrentCtx() ctx: Ctx, @Req() req: Request) {
    const cur = sha256(cookie(req, 'sid') ?? '');
    const rows = await this.db.session.findMany({ where: { userId: ctx.userId!, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } });
    return rows.map((s) => ({ id: s.id, current: s.id === cur, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent }));
  }

  @Authed()
  @Delete('auth/sessions/:id')
  async revokeSession(@CurrentCtx() ctx: Ctx, @Param('id') sid: string) {
    const r = await this.db.session.deleteMany({ where: { id: sid, userId: ctx.userId! } });
    if (!r.count) throw new BadRequestException('Session not found');
    await audit(this.db, ctx, 'auth.session_revoked', `user:${ctx.userId}`);
    return { ok: true };
  }
}
