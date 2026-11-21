// Phase 9C: stored lists of exchange-OWNED wallets (hot/cold/reserve), kept current by a daily cheap update check.
// Only lists that were fetched and parsed in a real session are configured (plan.md rule 5). The ~10 M Binance deposit list is NOT stored (find-and-mark only).
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Chain } from './chains';
import { Db } from './db';
import { fetchHotCold, latestSnapshots, POR_HOT_PREFIX, resolveSnapshot, snapshotIso, snapshotLabel } from './binance-por';
import { parsePorList } from './exchange-labels';
import { Jobs } from './jobs';

export const HTX_URL = 'https://raw.githubusercontent.com/huobiapi/Tool-Node.js-VerifyAddress/main/snapshot/huobi_por.csv';
export const HTX_PREFIX = 'HTX hot/cold wallet (proof-of-reserves list';
export interface ListState {
  exchange: string;
  snapshot: string | null; // newest snapshot / version we have seen
  url: string | null;
  checkedAt: number | null;
  syncedAt: number | null;
  status: 'ok' | 'error' | 'never';
  error?: string;
  counts?: Partial<Record<Chain, number>>;
  removed?: number;
  rejected?: number; // list rows skipped because the address does not fit the network
  seconds?: number;
}
export interface ListRow {
  chain: Chain;
  address: string;
}

/**
 * Replace one exchange's stored hot/cold labels with `rows` (DB logic only, no network).
 * Never overwrites a global official label of another origin (a seeded vendor label keeps its name);
 * removes only labels carrying this list's own name prefix (category exchange) that dropped out of the newest list.
 */
export async function applyHotList(db: Db, rows: ListRow[], o: { prefix: string; name: string; url: string }) {
  const keep = new Set(rows.map((r) => `${r.chain}|${r.address}`));
  const existing = await db.label.findMany({ where: { source: 'official', orgId: 0, category: 'exchange', name: { startsWith: o.prefix } }, select: { id: true, chain: true, address: true } });
  const stale = existing.filter((l) => !keep.has(`${l.chain}|${l.address}`)).map((l) => l.id);
  const removed = stale.length ? (await db.label.deleteMany({ where: { id: { in: stale } } })).count : 0;
  const foreign = new Set(
    (await db.label.findMany({ where: { source: 'official', orgId: 0, NOT: { name: { startsWith: o.prefix } }, address: { in: rows.map((r) => r.address) } }, select: { chain: true, address: true } })).map((l) => `${l.chain}|${l.address}`),
  );
  const todo = rows.filter((r) => !foreign.has(`${r.chain}|${r.address}`));
  for (let i = 0; i < todo.length; i += 500)
    await db.$transaction(
      todo.slice(i, i + 500).map((r) => {
        const where = { chain_address_source_orgId: { chain: r.chain, address: r.address, source: 'official', orgId: 0 } };
        return db.label.upsert({
          where,
          create: { chain: r.chain, address: r.address, name: o.name, category: 'exchange', source: 'official', sourceUrl: o.url, confidence: 1, orgId: 0 },
          update: { name: o.name, category: 'exchange', sourceUrl: o.url, confidence: 1 },
        });
      }),
    );
  return { written: todo.length, removed, skippedForeign: rows.length - todo.length };
}

const count = (rows: ListRow[]) => rows.reduce((m, r) => ({ ...m, [r.chain]: (m[r.chain] ?? 0) + 1 }), {} as Partial<Record<Chain, number>>);

@Injectable()
export class ExchangeLists implements OnModuleInit {
  private log = new Logger('ExchangeLists');
  private running: Promise<ListState[]> | null = null;
  constructor(
    private db: Db,
    private jobs: Jobs,
  ) {}

  onModuleInit() {
    // Daily the check runs (one tiny request per exchange); a download happens only when a newer snapshot exists, so in practice once per new snapshot.
    this.jobs.every('exchange-lists', 24 * 60 * 60_000, () => this.syncAll(false), 90_000);
  }

  private async state(ex: string): Promise<ListState> {
    const v = (await this.db.setting.findUnique({ where: { key: `exlist.${ex}` } }))?.value;
    return v ? JSON.parse(v) : { exchange: ex, snapshot: null, url: null, checkedAt: null, syncedAt: null, status: 'never' };
  }
  private save(s: ListState) {
    return this.db.setting.upsert({ where: { key: `exlist.${s.exchange}` }, create: { key: `exlist.${s.exchange}`, value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } });
  }
  status(): Promise<ListState[]> {
    return Promise.all(['Binance', 'HTX'].map((e) => this.state(e)));
  }

  /** Runs every exchange; `force` skips the "already have this snapshot" shortcut. One failing never stops the other. Single-flight. */
  syncAll(force: boolean): Promise<ListState[]> {
    this.running ??= (async () => {
      const out: ListState[] = [];
      const jobs: [string, () => Promise<ListState>][] = [['Binance', () => this.binance(force)], ['HTX', () => this.htx(force)]];
      for (const [ex, fn] of jobs) {
        const prev = await this.state(ex);
        try {
          out.push(await fn());
        } catch (e) {
          this.log.warn(`${ex} list sync failed: ${(e as Error).message}`);
          const s: ListState = { ...prev, checkedAt: Date.now(), status: 'error', error: (e as Error).message.slice(0, 300) };
          await this.save(s);
          out.push(s);
        }
      }
      return out;
    })().finally(() => (this.running = null));
    return this.running;
  }

  /** Binance: the snapshot-list request is the whole check; the ~290 MB zip is downloaded only for a snapshot we have not stored. */
  private async binance(force: boolean): Promise<ListState> {
    const prev = await this.state('Binance');
    const newest = snapshotIso((await latestSnapshots())[0]);
    if (!force && prev.status === 'ok' && prev.snapshot === newest) {
      const s = { ...prev, checkedAt: Date.now() };
      await this.save(s);
      return s;
    }
    const t0 = Date.now();
    const { snap, url } = await resolveSnapshot();
    const { rows, rejected } = await fetchHotCold(url);
    if (rejected.length) this.log.warn(`Binance HotCold: ${rejected.length} row(s) skipped (address format does not match the network), e.g. ${rejected[0]}`);
    if (!rows.length) throw new Error('Binance HotCold file had no rows on Tron, Ethereum or BNB Chain: keeping the stored list');
    const r = await applyHotList(this.db, rows, { prefix: POR_HOT_PREFIX, name: `${POR_HOT_PREFIX} ${snapshotLabel(snap)})`, url });
    const s: ListState = { exchange: 'Binance', snapshot: snapshotIso(snap), url, checkedAt: Date.now(), syncedAt: Date.now(), status: 'ok', counts: count(rows), removed: r.removed, rejected: rejected.length, seconds: (Date.now() - t0) / 1000 };
    await this.save(s);
    this.log.log(`Binance hot/cold sync: ${JSON.stringify(s.counts)}, removed ${r.removed}, ${s.seconds}s`);
    return s;
  }

  /** HTX: the CSV the exchange publishes on GitHub; the HTTP ETag is the cheap "has it changed" check. */
  private async htx(force: boolean): Promise<ListState> {
    const prev = await this.state('HTX');
    const head = await fetch(HTX_URL, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!head.ok) throw new Error(`HTX list returned HTTP ${head.status}`);
    const etag = head.headers.get('etag') ?? '';
    if (!force && prev.status === 'ok' && etag && prev.snapshot === etag) {
      const s = { ...prev, checkedAt: Date.now() };
      await this.save(s);
      return s;
    }
    const t0 = Date.now();
    const res = await fetch(HTX_URL, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTX list returned HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 2_000_000) throw new Error('HTX list is larger than expected');
    const rows = parsePorList(text);
    if (!rows.length) throw new Error('HTX list had no valid addresses: keeping the stored list');
    const r = await applyHotList(this.db, rows, { prefix: HTX_PREFIX, name: `${HTX_PREFIX})`, url: HTX_URL });
    const s: ListState = { exchange: 'HTX', snapshot: res.headers.get('etag') ?? etag, url: HTX_URL, checkedAt: Date.now(), syncedAt: Date.now(), status: 'ok', counts: count(rows), removed: r.removed, seconds: (Date.now() - t0) / 1000 };
    await this.save(s);
    return s;
  }
}
