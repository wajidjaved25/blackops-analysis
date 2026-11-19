import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';

/**
 * Chain-data cache and rate-limit counters. Uses Redis (3.0-compatible commands only: GET, SET EX, INCR, PEXPIRE);
 * if Redis is unreachable it falls back to per-process memory and logs one warning.
 */
const log = new Logger('Redis');
let client: Redis | null = null;
let warned = false;

function redis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false, // fail fast while down so callers use the memory fallback
      retryStrategy: (n) => Math.min(n * 1000, 15_000),
    });
    client.on('error', (e) => {
      if (warned) return;
      warned = true;
      log.warn(`Redis unavailable (${e.message || (e as any).code || 'cannot connect'}) — using in-memory cache and rate limits until it returns`);
    });
    client.on('ready', () => {
      if (warned) log.log('Redis reconnected');
      warned = false;
    });
  }
  return client;
}

const mem = new Map<string, { exp: number; val: string }>();
const memSet = (k: string, val: string, ttlMs: number) => {
  if (mem.size > 5000) mem.delete(mem.keys().next().value!); // ponytail: FIFO eviction; only used while Redis is down
  mem.set(k, { exp: Date.now() + ttlMs, val });
};
const memGet = (k: string) => {
  const e = mem.get(k);
  if (e && e.exp > Date.now()) return e.val;
  mem.delete(k);
};

/** Keys may embed API keys (Etherscan URLs), so they are hashed before they reach Redis. */
const ck = (k: string) => 'ut:cache:' + createHash('sha256').update(k).digest('hex');

export async function cacheGet(key: string): Promise<any | undefined> {
  let raw: string | null | undefined;
  try {
    raw = await redis().get(ck(key));
  } catch {
    raw = memGet(ck(key));
  }
  return raw ? JSON.parse(raw) : undefined;
}

export async function cacheSet(key: string, data: unknown, ttlSec: number) {
  const raw = JSON.stringify(data);
  try {
    await redis().set(ck(key), raw, 'EX', ttlSec);
  } catch {
    memSet(ck(key), raw, ttlSec * 1000);
  }
}

/** True when `key` has already reached `max` hits in its window (read-only, does not count a hit). */
export async function rateReached(key: string, max: number): Promise<boolean> {
  const k = 'ut:rl:' + key;
  let raw: string | null | undefined;
  try {
    raw = await redis().get(k);
  } catch {
    raw = memGet(k);
  }
  return Number(raw ?? 0) >= max;
}

export async function rateClear(key: string) {
  const k = 'ut:rl:' + key;
  try {
    await redis().del(k);
  } catch {
    mem.delete(k);
  }
}

/** Fixed-window limiter: true when `key` has exceeded `max` hits in `windowMs`. */
export async function rateLimited(key: string, max: number, windowMs: number): Promise<boolean> {
  const k = 'ut:rl:' + key;
  try {
    const n = await redis().incr(k);
    if (n === 1) await redis().pexpire(k, windowMs);
    return n > max;
  } catch {
    const e = mem.get(k);
    if (!e || e.exp <= Date.now()) {
      memSet(k, '1', windowMs);
      return 1 > max;
    }
    e.val = String(Number(e.val) + 1);
    return Number(e.val) > max;
  }
}
