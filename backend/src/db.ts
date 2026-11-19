import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class Db extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect();
  }
}

/** Request context set by the auth guard. userId is null for API-key requests. */
export interface Ctx {
  orgId: number;
  userId: number | null;
  permissions: string[]; // empty for API-key requests
  ip?: string;
}

export function audit(db: Db, ctx: Ctx, action: string, target: string, detail?: object) {
  return db.auditLog.create({ data: { orgId: ctx.orgId, userId: ctx.userId, action, target, detail: detail as any, ip: ctx.ip } });
}
