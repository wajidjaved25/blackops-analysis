// Phase 10A: stored exchange address lists (official proof-of-reserves files + one community dataset), loaded in bulk into
// ExchangeAddress and kept current by a daily cheap "is there a new version?" check. Plan rule 5: every source below was fetched
// and parsed in a real session; its URL is stored with the rows. Lists are untrusted input: every row is re-validated and sizes are capped.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PDFParse } from 'pdf-parse';
import unzipper from 'unzipper';
import { Chain, detectChain, norm } from './chains';
import { Db } from './db';
import { Jobs } from './jobs';
import { latestSnapshots, parsePorLine, resolveSnapshot, snapshotIso } from './binance-por';
import { parsePorList, validTron } from './exchange-labels';
import { ExRow, okxParser, parseCommunityLine, parseHackenText, parseMexcLine, RowKind } from './exchange-parsers';

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; exchange-list-sync)' };
const BATCH = 8_000;
const DAY = 86_400_000;
export const HTX_URL = 'https://raw.githubusercontent.com/huobiapi/Tool-Node.js-VerifyAddress/main/snapshot/huobi_por.csv';
export const BITFINEX_URL = 'https://raw.githubusercontent.com/bitfinexcom/pub/main/wallets.txt';
export const COMMUNITY_URL = 'https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/csv/accounts.csv';
export const KUCOIN_API = 'https://www.kucoin.com/_api/asset-front/current/por/monthly';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface SourceDef {
  id: string;
  exchange: string;
  kind: 'official' | 'community';
  listName: string;
  maxRows: number;
  maxBytes: number;
  /** The cheap check: returns the version token (changes when the list changes) and the file URL. */
  check(prevUrl: string | null): Promise<{ version: string; url: string }>;
  rows(url: string, tmp: string): AsyncIterable<ExRow>;
}

// ---------- small helpers ----------
const pad = (n: number) => String(n).padStart(2, '0');
async function head(url: string) {
  const r = await fetch(url, { method: 'HEAD', redirect: 'error', headers: UA, signal: AbortSignal.timeout(20_000) });
  return { ok: r.ok, status: r.status, etag: r.headers.get('etag') ?? r.headers.get('last-modified') ?? '', type: r.headers.get('content-type') ?? '' };
}
/** First url (in the given order, newest first) that answers 200. HEADs run 8 at a time. */
async function firstLive(urls: string[], wantType?: RegExp) {
  for (let i = 0; i < urls.length; i += 8) {
    const res = await Promise.all(urls.slice(i, i + 8).map((u) => head(u).catch(() => null)));
    const k = res.findIndex((h) => h?.ok && (!wantType || wantType.test(h.type)));
    if (k >= 0) return { url: urls[i + k], etag: res[k]!.etag };
  }
  return null;
}
const daysBack = (n: number, off = 0) => Array.from({ length: n }, (_, i) => new Date(Date.now() - i * DAY + off));
async function download(url: string, file: string, maxBytes: number) {
  const res = await fetch(url, { redirect: 'error', headers: UA, signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download returned HTTP ${res.status}`);
  let n = 0;
  const cap = new Transform({
    transform(chunk, _e, cb) {
      n += chunk.length;
      cb(n > maxBytes ? new Error(`file larger than the ${maxBytes} byte limit`) : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as any), cap, createWriteStream(file));
}
async function* lines(input: Readable) {
  for await (const l of createInterface({ input, crlfDelay: Infinity })) yield l;
}
async function zipEntry(file: string, re: RegExp) {
  const info = await unzipper.Open.file(file);
  const e = info.files.find((f) => f.type === 'File' && !f.path.startsWith('__MACOSX/') && !/(^|\/)\._/.test(f.path) && re.test(f.path));
  if (!e) throw new Error(`zip has no file matching ${re}`);
  return e;
}
async function* textUrlRows(url: string, kind: RowKind): AsyncIterable<ExRow> {
  const res = await fetch(url, { redirect: 'error', headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error('list is larger than expected');
  for (const r of parsePorList(text, 100_000)) yield { chain: r.chain, address: r.address, kind };
}
async function* pdfRows(url: string, tmp: string): AsyncIterable<ExRow> {
  const file = join(tmp, 'por.pdf');
  await download(url, file, 40_000_000);
  const p = new PDFParse({ data: await readFile(file) });
  try {
    for (const r of parseHackenText((await p.getText()).text)) yield r;
  } finally {
    await p.destroy();
  }
}

// ---------- sources ----------
const etagCheck = (url: string) => async () => {
  const h = await head(url);
  if (!h.ok) throw new Error(`HTTP ${h.status}`);
  return { version: h.etag || `len:${Date.now()}`, url };
};
const named = (hit: { url: string; etag: string }) => ({ version: `${hit.url.split('/').pop()}|${hit.etag}`, url: hit.url });
const stillThere = (prev: string | null) => (prev ? head(prev).then((h) => (h.ok ? { url: prev, etag: h.etag } : null)).catch(() => null) : Promise.resolve(null));

export const SOURCES: SourceDef[] = [
  {
    id: 'binance', exchange: 'Binance', kind: 'official', listName: 'proof-of-reserves list', maxRows: 20_000_000, maxBytes: 600_000_000,
    // The snapshot list is the cheap check; the zip URL comes from Binance's own download-url endpoint.
    check: async () => {
      const snap = (await latestSnapshots())[0];
      const { url } = await resolveSnapshot();
      return { version: snapshotIso(snap), url };
    },
    async *rows(url, tmp) {
      const file = join(tmp, 'por.zip');
      await download(url, file, 600_000_000);
      // Deposit first, HotCold last: an address in both ends up as a hot/cold wallet.
      for (const [re, kind] of [[/_Deposit\.csv$/i, 'deposit'], [/_HotCold\.csv$/i, 'hot']] as const)
        for await (const line of lines((await zipEntry(file, re)).stream())) {
          const p = parsePorLine(line);
          if (p) yield { chain: p.chain, address: p.address, kind };
        }
    },
  },
  {
    // No API pointer is reachable (www.okx.com is reset from this network). File names follow por_csv_YYYYMMDDHH_V<n>.zip on
    // static.okx.com, so the check probes the last 62 days (hour 00, V3..V1) with HEAD, newest first, then falls back to the stored URL.
    id: 'okx', exchange: 'OKX', kind: 'official', listName: 'proof-of-reserves list', maxRows: 2_000_000, maxBytes: 400_000_000,
    check: async (prev) => {
      const urls = daysBack(62).flatMap((d) => [3, 2, 1].map((v) => `https://static.okx.com/cdn/okx/por/chain/por_csv_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}00_V${v}.zip`));
      const hit = (await firstLive(urls)) ?? (await stillThere(prev));
      if (!hit) throw new Error('no OKX proof-of-reserves file found for the last 62 days (naming may have changed)');
      return named(hit);
    },
    async *rows(url, tmp) {
      const file = join(tmp, 'por.zip');
      await download(url, file, 400_000_000);
      const parse = okxParser();
      for await (const line of lines((await zipEntry(file, /\.csv$/i)).stream())) {
        const r = parse(line);
        if (r) yield r;
      }
    },
  },
  {
    id: 'htx', exchange: 'HTX', kind: 'official', listName: 'proof-of-reserves list', maxRows: 100_000, maxBytes: 5_000_000,
    check: etagCheck(HTX_URL),
    rows: (url) => textUrlRows(url, 'hot'),
  },
  {
    // Hacken audit PDF; the file name carries the audit date (Bybit_PoR_Audit_YYYY_Mon_DD.pdf). No reachable API, so the check probes dates since the stored one.
    id: 'bybit', exchange: 'Bybit', kind: 'official', listName: 'proof-of-reserves audit report', maxRows: 50_000, maxBytes: 40_000_000,
    check: async (prev) => {
      const m = prev && /Audit_(\d{4})_([A-Za-z]{3})_(\d{2})\.pdf$/.exec(prev);
      const since = m ? Date.UTC(+m[1], MON.indexOf(m[2]), +m[3]) : Date.now() - 100 * DAY;
      const urls = daysBack(Math.min(120, Math.ceil((Date.now() - since) / DAY) + 1)).map((d) => `https://www.bybit.com/common-static/cht-static/por/Bybit_PoR_Audit_${d.getUTCFullYear()}_${MON[d.getUTCMonth()]}_${pad(d.getUTCDate())}.pdf`);
      const hit = (await firstLive(urls, /pdf/i)) ?? (await stillThere(prev));
      if (!hit) throw new Error('no Bybit proof-of-reserves PDF found (file naming may have changed)');
      return named(hit);
    },
    rows: pdfRows,
  },
  {
    id: 'kucoin', exchange: 'KuCoin', kind: 'official', listName: 'proof-of-reserves audit report', maxRows: 50_000, maxBytes: 40_000_000,
    check: async () => {
      const r = await fetch(KUCOIN_API, { headers: UA, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`KuCoin pointer returned HTTP ${r.status}`);
      const url = ((await r.json()) as any)?.data?.auditReportUrl;
      if (typeof url !== 'string' || !/^https:\/\/assets\.staticimg\.com\/.+\.pdf$/i.test(url)) throw new Error('KuCoin pointer has no audit report URL');
      return { version: url, url };
    },
    rows: pdfRows,
  },
  {
    // Daily CSV; the date in the name is the UTC+8 date. MEXC's own pointer API is Akamai-blocked to non-browsers.
    id: 'mexc', exchange: 'MEXC', kind: 'official', listName: 'proof-of-reserves list', maxRows: 100_000, maxBytes: 20_000_000,
    check: async () => {
      const urls = daysBack(5, 8 * 3600_000).map((d) => `https://por.mocortech.com/MEXC_Merkle_Wallet_Address_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.csv`);
      const hit = await firstLive(urls);
      if (!hit) throw new Error('no MEXC proof-of-reserves CSV found for the last 5 days');
      return named(hit);
    },
    async *rows(url) {
      const res = await fetch(url, { redirect: 'error', headers: UA, signal: AbortSignal.timeout(60_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      for await (const line of lines(Readable.fromWeb(res.body as any))) {
        const r = parseMexcLine(line);
        if (r) yield r;
      }
    },
  },
  {
    // A static 2022 disclosure on the exchange's own GitHub: kept because it is official; the ETag check makes it free.
    id: 'bitfinex', exchange: 'Bitfinex', kind: 'official', listName: 'published wallet list (2022)', maxRows: 10_000, maxBytes: 1_000_000,
    check: etagCheck(BITFINEX_URL),
    rows: (url) => textUrlRows(url, 'hot'),
  },
  {
    id: 'community-ethlabels', exchange: 'Various', kind: 'community', listName: 'community list', maxRows: 200_000, maxBytes: 60_000_000,
    check: etagCheck(COMMUNITY_URL),
    async *rows(url) {
      const res = await fetch(url, { redirect: 'error', headers: UA, signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      for await (const line of lines(Readable.fromWeb(res.body as any))) {
        const r = parseCommunityLine(line);
        if (r) yield r;
      }
    },
  },
];

// ---------- bulk loader ----------
export interface LoadResult {
  rows: number;
  rejected: number;
  removed: number;
  peakRssMb: number;
}
type Clean = { chain: Chain; address: string; exchange: string; kind: RowKind };

/** Re-validates a row: address must fit its chain, Tron must pass the checksum, exchange name and kind must be sane. */
export function cleanRow(r: ExRow, defExchange: string): Clean | null {
  const chain = r.chain;
  if (chain !== 'tron' && chain !== 'eth' && chain !== 'bsc') return null;
  if (detectChain(r.address) !== (chain === 'tron' ? 'tron' : 'eth')) return null;
  if (chain === 'tron' && !validTron(r.address)) return null;
  const exchange = (r.exchange ?? defExchange).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
  if (!exchange || !['hot', 'deposit', 'controlled'].includes(r.kind)) return null;
  return { chain, address: norm(r.address), exchange, kind: r.kind };
}

/**
 * Replaces ALL rows of one source in a single transaction (streamed in batches of BATCH rows via unnest, never the whole list in memory):
 * rows of the new list are upserted with lastSeen = transaction time (firstSeen kept), then the source's rows not seen in this run are deleted.
 * An empty or failing list rolls everything back, so the previous rows stay. A community list never overwrites a row an official list owns.
 */
export async function loadSource(db: Db, def: Pick<SourceDef, 'id' | 'exchange' | 'maxRows'>, rows: AsyncIterable<ExRow>): Promise<LoadResult> {
  let total = 0;
  let rejected = 0;
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 500);
  try {
    const removed = await db.$transaction(
      async (tx) => {
        let buf = new Map<string, Clean>();
        const flush = async () => {
          if (!buf.size) return;
          const v = [...buf.values()];
          buf = new Map();
          await tx.$executeRaw`
            INSERT INTO "ExchangeAddress" (chain, address, exchange, kind, "sourceId", "firstSeen", "lastSeen")
            SELECT c, a, e, k, ${def.id}::text, LOCALTIMESTAMP(3), LOCALTIMESTAMP(3)
            FROM unnest(${v.map((x) => x.chain)}::text[], ${v.map((x) => x.address)}::text[], ${v.map((x) => x.exchange)}::text[], ${v.map((x) => x.kind)}::text[]) AS t(c, a, e, k)
            ON CONFLICT (chain, address, exchange) DO UPDATE SET kind = EXCLUDED.kind, "sourceId" = EXCLUDED."sourceId", "lastSeen" = LOCALTIMESTAMP(3)
            WHERE "ExchangeAddress"."sourceId" = EXCLUDED."sourceId" OR EXCLUDED."sourceId" NOT LIKE 'community-%'`;
        };
        for await (const raw of rows) {
          const r = cleanRow(raw, def.exchange);
          if (!r) {
            rejected++;
            continue;
          }
          if (++total > def.maxRows) throw new Error(`list has more than ${def.maxRows} rows: refusing to load it`);
          buf.set(`${r.chain}|${r.address}|${r.exchange}`, r);
          if (buf.size >= BATCH) await flush();
        }
        await flush();
        if (!total) throw new Error('list had no valid addresses: keeping the stored rows');
        return tx.$executeRaw`DELETE FROM "ExchangeAddress" WHERE "sourceId" = ${def.id} AND "lastSeen" < LOCALTIMESTAMP(3)`;
      },
      { timeout: 4 * 3600_000, maxWait: 60_000 },
    );
    peak = Math.max(peak, process.memoryUsage().rss);
    return { rows: total, rejected, removed, peakRssMb: Math.round(peak / 1e6) };
  } finally {
    clearInterval(timer);
  }
}

export async function countRows(db: Db, sourceId: string) {
  const r = await db.$queryRaw<{ chain: string; kind: string; n: bigint }[]>`SELECT chain, kind, count(*) AS n FROM "ExchangeAddress" WHERE "sourceId" = ${sourceId} GROUP BY chain, kind`;
  const out: Record<string, number> = {};
  for (const x of r) {
    out[x.chain] = (out[x.chain] ?? 0) + Number(x.n);
    out[x.kind] = (out[x.kind] ?? 0) + Number(x.n);
  }
  return out;
}

@Injectable()
export class ExchangeLists implements OnModuleInit {
  private log = new Logger('ExchangeLists');
  private running: Promise<unknown> | null = null;
  constructor(
    private db: Db,
    private jobs: Jobs,
  ) {}

  onModuleInit() {
    // Daily: one tiny request per source; a download + load happens only when the source has a new version.
    this.jobs.every('exchange-lists', DAY, () => this.syncAll(false), 90_000);
  }

  /** One row per configured source (sources never checked show status "never"). */
  async status() {
    const have = new Map((await this.db.exchangeSource.findMany()).map((s) => [s.id, s]));
    return SOURCES.map((d) => have.get(d.id) ?? { id: d.id, exchange: d.exchange, url: '', kind: d.kind, listName: d.listName, lastChecked: null, lastChanged: null, version: null, rowCounts: null, status: 'never', error: null, seconds: null, peakRssMb: null });
  }

  /** Single-flight. `force` skips the "same version" shortcut; `only` limits to one source id. One failing source never stops the others. */
  syncAll(force: boolean, only?: string) {
    this.running ??= (async () => {
      for (const d of SOURCES.filter((x) => !only || x.id === only)) await this.syncOne(d, force);
      return this.status();
    })().finally(() => (this.running = null));
    return this.running as Promise<Awaited<ReturnType<ExchangeLists['status']>>>;
  }

  private async syncOne(d: SourceDef, force: boolean) {
    const prev = await this.db.exchangeSource.findUnique({ where: { id: d.id } });
    const base = { exchange: d.exchange, kind: d.kind, listName: d.listName };
    const now = new Date();
    try {
      const { version, url } = await d.check(prev?.url || null);
      if (!force && prev?.status === 'ok' && prev.version === version) {
        await this.db.exchangeSource.update({ where: { id: d.id }, data: { lastChecked: now } });
        return;
      }
      await this.db.exchangeSource.upsert({ where: { id: d.id }, create: { id: d.id, url, ...base, lastChecked: now, status: 'running' }, update: { url, ...base, lastChecked: now, status: 'running', error: null } });
      const t0 = Date.now();
      const tmp = await mkdtemp(join(tmpdir(), 'exlist-'));
      try {
        const r = await loadSource(this.db, d, d.rows(url, tmp));
        await this.db.$executeRawUnsafe('ANALYZE "ExchangeAddress"');
        const counts = { ...(await countRows(this.db, d.id)), rejected: r.rejected, removed: r.removed };
        await this.db.exchangeSource.update({ where: { id: d.id }, data: { status: 'ok', error: null, version, lastChanged: new Date(), rowCounts: counts, seconds: (Date.now() - t0) / 1000, peakRssMb: r.peakRssMb } });
        this.log.log(`${d.id}: ${JSON.stringify(counts)} in ${((Date.now() - t0) / 1000).toFixed(0)}s, peak RSS ${r.peakRssMb} MB`);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      this.log.warn(`${d.id} sync failed: ${msg}`);
      await this.db.exchangeSource.upsert({ where: { id: d.id }, create: { id: d.id, url: prev?.url ?? '', ...base, lastChecked: now, status: 'error', error: msg }, update: { lastChecked: now, status: 'error', error: msg } });
    }
  }
}
