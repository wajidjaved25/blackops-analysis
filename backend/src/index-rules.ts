// Pure helpers for the transfer index (no I/O) — covered by selfcheck.ts.

export interface Row {
  asset: string;
  hash: string;
  from: string;
  to: string;
  amount: number;
  timestamp: number;
  block?: number;
}
export type IndexStatus = 'pending' | 'backfilling' | 'complete' | 'capped' | 'error';
export interface Coverage {
  status: string;
  rowCount: number;
  lastSyncAt: Date | null;
  assets: string; // csv of assets whose history is fully stored
}
export type ReadPlan = 'api' | 'db' | 'sync-then-db';

/** seq = ordinal of identical (asset, hash, from, to, amount) rows inside one tx. Pass one `seen` map across pages of the same fetch. */
export function withSeq<T extends Row>(rows: T[], seen = new Map<string, number>()): (T & { seq: number })[] {
  return rows.map((r) => {
    const k = `${r.asset}|${r.hash}|${r.from}|${r.to}|${r.amount}`;
    const seq = seen.get(k) ?? 0;
    seen.set(k, seq + 1);
    return { ...r, seq };
  });
}

/**
 * Where a read comes from. Covered (complete, or capped when the caller wants no more than we hold) and fresh -> Postgres;
 * covered but stale or `fresh` requested -> fetch only newer rows first; anything else -> live API.
 * Coverage only counts for assets it actually stores (`wanted`), so a wallet indexed before USDC support still serves USDT reads.
 * ponytail: a capped wallet's `rowCount` is across assets; with several assets the newest-`max` window is approximate.
 */
export function planRead(cov: Coverage | null, max: number, fresh: boolean, now: number, freshMs: number, wanted: string[] = ['usdt']): ReadPlan {
  if (!cov) return 'api';
  const have = cov.assets.split(',');
  const usable = wanted.every((a) => have.includes(a)) && (cov.status === 'complete' || (cov.status === 'capped' && max <= cov.rowCount));
  if (!usable) return 'api';
  const age = cov.lastSyncAt ? now - cov.lastSyncAt.getTime() : Infinity;
  return fresh || age > freshMs ? 'sync-then-db' : 'db';
}

/**
 * Newest-first batch from a block-ranged API (Etherscan caps rows per call). When the batch is full its oldest block may be
 * cut mid-way, so those rows are dropped and the next call restarts at that block (duplicates are harmless).
 */
export function splitBoundary<T extends { block?: number }>(rows: T[], full: boolean): { keep: T[]; nextEnd: number | null } {
  if (!full || rows.length === 0) return { keep: rows, nextEnd: null };
  const edge = rows[rows.length - 1].block!;
  const keep = rows.filter((r) => r.block! > edge);
  // one block bigger than the whole batch: keep it all and step below it
  return keep.length ? { keep, nextEnd: edge } : { keep: rows, nextEnd: edge - 1 };
}

/** Back-off for failed backfills: 1, 2, 4, 8, 16 min, then give up (the admin page offers a manual re-queue). */
export const MAX_BACKFILL_RETRIES = 5;
export const retryDelayMs = (attempt: number) => 60_000 * 2 ** Math.max(0, attempt - 1);

/** A tailer window never reaches into the unconfirmed tail, otherwise rows confirmed later would be skipped. */
export const tailEnd = (cursorMs: number, nowMs: number, windowMs: number, confirmLagMs: number) => Math.min(cursorMs + windowMs - 1, nowMs - confirmLagMs);
