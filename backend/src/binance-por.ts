// Phase 8C: Binance proof-of-reserves "find and mark". The published lists (~290 MB zip, ~11 M deposit rows) are streamed
// through a temp file and NEVER stored: only addresses we were asked about, and that match, get a label.
import { Injectable } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import unzipper, { File as ZipFile } from 'unzipper';
import { Chain, fetchJson, norm } from './chains';
import { Db } from './db';
import { cacheGet, cacheSet } from './kv';

const BASE = 'https://www.binance.com/bapi/apex/v1/public/apex/market';
const MISS_TTL_SEC = 35 * 86_400; // a miss is only valid for its own snapshot (the key includes the date)
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const POR_HOT_PREFIX = 'Binance hot/cold wallet (proof-of-reserves';
export const POR_DEPOSIT_PREFIX = 'Binance deposit address (proof-of-reserves';
export const POR_MAX_INPUT = 5000;

export interface PorAddr {
  chain: Chain;
  address: string;
}
export type PorKind = 'hotcold' | 'deposit';
export interface PorResult {
  snapshot: string; // YYYY-MM-DD, the audit date Binance publishes
  url: string;
  checked: number;
  matched: number;
  skippedCached: number;
  seconds: number;
  matches: (PorAddr & { kind: PorKind })[];
  timings: { downloadSeconds: number; scanSeconds: number };
}
type Snap = { y: number; m: number; d: number };

/** "12/11/26 00:00:00 UTC | BTC Block Height 975493" -> {y,m,d} (dd/mm/yy); null when it does not parse. */
export function parseSnapshot(s: string): Snap | null {
  const k = /^\s*(\d{2})\/(\d{2})\/(\d{2})\b/.exec(s);
  if (!k) return null;
  const [d, m, y] = [Number(k[1]), Number(k[2]), 2000 + Number(k[3])];
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { y, m, d } : null;
}
/** "PR" + dd + MON + yy, e.g. PR12NOV26. */
export const auditId = (s: Snap) => `PR${String(s.d).padStart(2, '0')}${MON[s.m - 1]}${String(s.y % 100).padStart(2, '0')}`;
export const snapshotIso = (s: Snap) => `${s.y}-${String(s.m).padStart(2, '0')}-${String(s.d).padStart(2, '0')}`;
export const snapshotLabel = (s: Snap) => `${String(s.d).padStart(2, '0')} ${MONTH_NAMES[s.m - 1]} ${s.y}`;

const NETWORKS: Record<string, Chain> = { TRX: 'tron', ETH: 'eth', BSC: 'bsc' };
/** One CSV line `coin,network,address,balance,Height,custodian` -> address on a supported network (null for other networks / header). Tron stays case-sensitive, EVM is lowercased. */
export function parsePorLine(line: string): PorAddr | null {
  const a = line.indexOf(',');
  const b = a < 0 ? -1 : line.indexOf(',', a + 1);
  if (b < 0) return null;
  const chain = NETWORKS[line.slice(a + 1, b)];
  if (!chain) return null;
  let e = line.indexOf(',', b + 1);
  if (e < 0) e = line.length;
  const address = line.slice(b + 1, e).trim();
  return address ? { chain, address: chain === 'tron' ? address : address.toLowerCase() } : null;
}
export const porKey = (x: PorAddr) => `${x.chain}|${x.address}`;
const keyOf = (x: PorAddr) => porKey({ chain: x.chain, address: norm(x.address) });

export const porLabelName = (kind: PorKind, snap: Snap) => `${kind === 'hotcold' ? POR_HOT_PREFIX : POR_DEPOSIT_PREFIX} ${snapshotLabel(snap)})`;
const isPorName = (n: string) => n.startsWith(POR_HOT_PREFIX) || n.startsWith(POR_DEPOSIT_PREFIX);

async function resolveSnapshot(): Promise<{ snap: Snap; url: string }> {
  const j = await fetchJson(`${BASE}/query/auditProofSnapshotCondition`, {}, 500);
  const snaps = (Array.isArray(j?.data) ? j.data : []).map((s: unknown) => (typeof s === 'string' ? parseSnapshot(s) : null)).filter(Boolean) as Snap[];
  if (!snaps.length) throw new Error('Binance snapshot list is empty or has a new format');
  for (const snap of snaps.slice(0, 3)) {
    const r = await fetchJson(`${BASE}/por/getDownloadUrl?auditId=${auditId(snap)}`, {}, 500).catch(() => null);
    const url = typeof r?.data === 'string' ? r.data : '';
    if (/^https:\/\/[a-z0-9.-]*bnbstatic\.com\/.+\.zip$/i.test(url)) return { snap, url };
  }
  throw new Error('Binance did not return a download URL for the latest 3 snapshots');
}

/** Scans one CSV entry; matched addresses leave `want` and land in `out`. Stops reading as soon as `want` is empty. */
async function scan(entry: ZipFile, want: Set<string>, kind: PorKind, out: Map<string, PorKind>) {
  const stream = entry.stream();
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      const p = parsePorLine(line);
      if (!p) continue;
      const k = porKey(p);
      if (want.delete(k)) {
        out.set(k, kind);
        if (!want.size) break;
      }
    }
  } finally {
    stream.destroy();
  }
}

/** Downloads the zip to a temp file (streamed, never in memory), scans HotCold then Deposit, always deletes the file. */
async function scanZip(url: string, want: Set<string>): Promise<{ found: Map<string, PorKind>; downloadSeconds: number; scanSeconds: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'por-'));
  const file = join(dir, 'por.zip');
  const found = new Map<string, PorKind>();
  try {
    let t = Date.now();
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Binance zip returned HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file));
    const downloadSeconds = (Date.now() - t) / 1000;
    t = Date.now();
    const info = await unzipper.Open.file(file);
    const real = info.files.filter((f) => f.type === 'File' && !f.path.startsWith('__MACOSX/') && !/(^|\/)\._/.test(f.path));
    const hot = real.find((f) => /_HotCold\.csv$/i.test(f.path));
    const dep = real.find((f) => /_Deposit\.csv$/i.test(f.path));
    if (!hot || !dep) throw new Error('Binance zip does not contain the expected HotCold and Deposit CSV files');
    await scan(hot, want, 'hotcold', found);
    if (want.size) await scan(dep, want, 'deposit', found);
    return { found, downloadSeconds, scanSeconds: (Date.now() - t) / 1000 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Waiter {
  addrs: PorAddr[];
  res: (r: PorResult) => void;
  rej: (e: unknown) => void;
}
type Run = Omit<PorResult, 'checked' | 'matched' | 'skippedCached'> & { cachedKeys: string[] };

/**
 * Find-and-mark. Single-flight: callers that arrive while a download is running are batched into ONE next run, so a burst
 * of callers costs at most two downloads. No-match results are cached per (snapshot, address) for 35 days. A miss only means
 * "not in Binance's published balance-holding lists", never "not a Binance customer".
 */
@Injectable()
export class BinancePor {
  constructor(private db: Db) {}
  private waiters: Waiter[] = [];
  private running: Promise<void> | null = null;

  /** Addresses must already be validated (controller: parseAddrList). Inputs are normalised here (0x lowercased). */
  check(addresses: PorAddr[]): Promise<PorResult> {
    return new Promise((res, rej) => {
      this.waiters.push({ addrs: addresses, res, rej });
      this.running ??= this.drain().finally(() => (this.running = null));
    });
  }

  private async drain() {
    while (this.waiters.length) {
      const batch = this.waiters.splice(0);
      try {
        const union = [...new Map(batch.flatMap((w) => w.addrs).map((a) => [keyOf(a), { chain: a.chain, address: norm(a.address) }])).values()];
        const r = await this.run(union);
        for (const w of batch) {
          const mine = new Set(w.addrs.map(keyOf));
          const matches = r.matches.filter((m) => mine.has(porKey(m)));
          w.res({ ...r, checked: mine.size, matched: matches.length, matches, skippedCached: r.cachedKeys.filter((k) => mine.has(k)).length });
        }
      } catch (e) {
        batch.forEach((w) => w.rej(e));
      }
    }
  }

  private async run(addrs: PorAddr[]): Promise<Run> {
    const t0 = Date.now();
    const { snap, url } = await resolveSnapshot();
    const iso = snapshotIso(snap);
    const missKey = (k: string) => `por-miss:${iso}:${k}`;
    // already marked from this snapshot, or already known to miss -> no download needed for them
    const marked = new Set(
      (await this.db.label.findMany({ where: { source: 'official', orgId: 0, sourceUrl: url, address: { in: addrs.map((a) => a.address) } }, select: { chain: true, address: true } })).map((l) => `${l.chain}|${l.address}`),
    );
    const cachedKeys: string[] = [...marked];
    const want = new Set<string>();
    for (let i = 0; i < addrs.length; i += 50) {
      await Promise.all(
        addrs.slice(i, i + 50).map(async (a) => {
          const k = porKey(a);
          if (marked.has(k)) return;
          if ((await cacheGet(missKey(k))) !== undefined) cachedKeys.push(k);
          else want.add(k);
        }),
      );
    }
    const asked = [...want];
    let found = new Map<string, PorKind>();
    let timings = { downloadSeconds: 0, scanSeconds: 0 };
    if (want.size) {
      const r = await scanZip(url, want);
      found = r.found;
      timings = { downloadSeconds: r.downloadSeconds, scanSeconds: r.scanSeconds };
    }
    const matches: (PorAddr & { kind: PorKind })[] = [];
    for (const k of asked) {
      const kind = found.get(k);
      const i = k.indexOf('|');
      const chain = k.slice(0, i) as Chain;
      const address = k.slice(i + 1);
      if (!kind) {
        await cacheSet(missKey(k), 1, MISS_TTL_SEC);
        continue;
      }
      matches.push({ chain, address, kind });
      const name = porLabelName(kind, snap);
      const where = { chain_address_source_orgId: { chain, address, source: 'official', orgId: 0 } };
      const old = await this.db.label.findUnique({ where });
      if (old && !isPorName(old.name)) continue; // never overwrite a seeded vendor label; only refresh our own earlier PoR labels
      await this.db.label.upsert({
        where,
        create: { chain, address, name, category: 'exchange', source: 'official', sourceUrl: url, confidence: 1, orgId: 0 },
        update: { name, category: 'exchange', sourceUrl: url, confidence: 1 },
      });
    }
    return { snapshot: iso, url, seconds: (Date.now() - t0) / 1000, matches, timings, cachedKeys };
  }
}
