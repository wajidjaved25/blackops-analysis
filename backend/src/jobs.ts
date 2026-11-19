import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Job } from '@prisma/client';
import { Db } from './db';

export type JobHandler = (job: Job, progress: (done: number) => Promise<void>) => Promise<unknown>;

/**
 * Postgres-backed job queue + recurring tasks (replaces Redis/BullMQ).
 * Jobs are claimed with FOR UPDATE SKIP LOCKED, so several API instances can share the queue safely.
 * Set DISABLE_WORKERS=true to run an API-only instance.
 */
@Injectable()
export class Jobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private log = new Logger('Jobs');
  private handlers = new Map<string, JobHandler>();
  private timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(private db: Db) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  enqueue(orgId: number, type: string, payload: object, total = 0) {
    return this.db.job.create({ data: { orgId, type, payload: payload as any, total } });
  }

  /** Run `fn` every `ms`, never overlapping itself. First run after `firstDelayMs`. */
  every(name: string, ms: number, fn: () => Promise<unknown>, firstDelayMs = 5000) {
    if (process.env.DISABLE_WORKERS === 'true') return;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (e) {
        this.log.warn(`${name} failed: ${(e as Error).message}`);
      } finally {
        running = false;
      }
    };
    this.timers.push(setTimeout(tick, firstDelayMs), setInterval(tick, ms));
  }

  async onApplicationBootstrap() {
    if (process.env.DISABLE_WORKERS === 'true') return;
    // Jobs left "running" by a crash go back to the queue.
    await this.db.job.updateMany({ where: { status: 'running' }, data: { status: 'queued' } });
    this.timers.push(setInterval(() => this.drain(), 2000));
  }

  onApplicationShutdown() {
    this.timers.forEach(clearTimeout);
  }

  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const [job] = await this.db.$queryRaw<Job[]>`
          UPDATE "Job" SET status = 'running', "updatedAt" = now()
          WHERE id = (SELECT id FROM "Job" WHERE status = 'queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING *`;
        if (!job) return;
        await this.run(job);
      }
    } catch (e) {
      this.log.error(`queue error: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async run(job: Job) {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      const result = await handler(job, (done) => this.db.job.update({ where: { id: job.id }, data: { progress: done } }).then(() => undefined));
      await this.db.job.update({ where: { id: job.id }, data: { status: 'done', result: result as any, progress: job.total || undefined } });
    } catch (e) {
      this.log.warn(`job ${job.id} (${job.type}) failed: ${(e as Error).message}`);
      await this.db.job.update({ where: { id: job.id }, data: { status: 'failed', error: (e as Error).message.slice(0, 1000) } });
    }
  }
}
