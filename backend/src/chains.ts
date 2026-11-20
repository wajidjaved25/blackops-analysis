import { BadRequestException, BadGatewayException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { splitBoundary } from './index-rules';
import { cacheGet, cacheSet } from './kv';

export type Chain = 'tron' | 'eth';
export interface Transfer {
  hash: string;
  from: string;
  to: string;
  amount: number; // USDT, 6 decimals applied
  timestamp: number; // ms
  block?: number; // Ethereum only (TronGrid's per-account list has none)
}
export interface TransferRef {
  hash: string;
  amount: number;
  timestamp: number;
}
export interface Flow {
  address: string;
  in: number;
  out: number;
  inCount: number;
  outCount: number;
  inTransfers?: TransferRef[]; // only with flows(..., true): newest first, max MAX_EDGE_TRANSFERS
  outTransfers?: TransferRef[];
}
export const MAX_EDGE_TRANSFERS = 50;

const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const ETH_USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const TRONGRID = 'https://api.trongrid.io';
const ETHERSCAN = 'https://api.etherscan.io/v2/api?chainid=1';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function detectChain(addr: string): Chain | null {
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return 'tron';
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return 'eth';
  return null;
}

/** Eth addresses are case-insensitive; Tron base58 is not. */
export function norm(addr: string): string {
  return addr.startsWith('0x') ? addr.toLowerCase() : addr;
}

/** Base58 Tron address -> 20-byte hex (no 0x41 prefix, no checksum). */
export function tronToHex20(addr: string): string {
  let n = 0n;
  for (const c of addr) n = n * 58n + BigInt(B58.indexOf(c));
  return n.toString(16).padStart(50, '0').slice(2, 42);
}

/** 20-byte hex (with or without 0x) -> base58check Tron address. */
export function hexToTron(hex20: string): string {
  const payload = Buffer.from('41' + hex20.replace(/^0x/, '').slice(-40), 'hex');
  const sha = (b: Buffer) => createHash('sha256').update(b).digest();
  let n = BigInt('0x' + Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

export function isTxHash(chain: Chain, hash: string): boolean {
  return chain === 'tron' ? /^[0-9a-fA-F]{64}$/.test(hash) : /^0x[0-9a-fA-F]{64}$/.test(hash);
}

const TTL_SEC = 900; // cache lives in Redis (kv.ts), memory fallback if Redis is down
const inflight = new Map<string, Promise<any>>(); // identical concurrent requests share one upstream call
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MAX_CONCURRENT = 2; // per upstream host: unauthenticated TronGrid answers 429 to bursts, so a small pool + shared back-off is faster than a flood
class HostState {
  active = 0;
  nextStart = 0;
  pauseUntil = 0;
  waiters: (() => void)[] = [];
  async acquire(gapMs: number) {
    while (this.active >= MAX_CONCURRENT) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    const at = Math.max(Date.now(), this.nextStart, this.pauseUntil);
    this.nextStart = at + gapMs;
    await sleep(at - Date.now());
  }
  release() {
    this.active--;
    this.waiters.shift()?.();
  }
}
const hosts = new Map<string, HostState>();

/** Real upstream HTTP calls since boot (cache hits and Postgres reads are not counted) — lets the admin page prove what hit the API. */
export const upstream = { calls: 0, byHost: {} as Record<string, number>, recent: [] as { t: number; url: string }[] };
function countUpstream(host: string, url: string) {
  upstream.calls++;
  upstream.byHost[host] = (upstream.byHost[host] ?? 0) + 1;
  upstream.recent.push({ t: Date.now(), url: url.replace(/apikey=[^&]*/, 'apikey=…') });
  if (upstream.recent.length > 300) upstream.recent.shift();
}
const hostState = (h: string) => hosts.get(h) ?? hosts.set(h, new HostState()).get(h)!;

/** Cached fetch, serialized per host with a gap to respect free-tier rate limits. `fresh` skips the cache read. */
export function fetchJson(url: string, init: RequestInit = {}, gapMs = 250, fresh = false): Promise<any> {
  const key = url + (init.body ?? '');
  const p = inflight.get(key);
  if (p && !fresh) return p;
  const run = fetchJsonUncached(key, url, init, gapMs, fresh).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function fetchJsonUncached(key: string, url: string, init: RequestInit, gapMs: number, fresh: boolean): Promise<any> {
  if (!fresh) {
    const hit = await cacheGet(key);
    if (hit !== undefined) return hit;
  }
  const host = new URL(url).host;
  const h = hostState(host);
  await h.acquire(gapMs);
  let res: Response;
  try {
    countUpstream(host, url);
    res = await fetch(url, init).catch(async () => {
      await sleep(500); // one retry for a dropped connection: a long backfill must survive a blip
      countUpstream(host, url);
      return fetch(url, init);
    });
    // Free tiers rate-limit bursts: pause the whole host (not just this call) 1s, 2s, 4s, 8s before giving up.
    for (let i = 0; (res.status === 429 || res.status === 503) && i < 4; i++) {
      h.pauseUntil = Math.max(h.pauseUntil, Date.now() + 1000 * 2 ** i);
      await sleep(Math.max(0, h.pauseUntil - Date.now()));
      countUpstream(host, url);
      res = await fetch(url, init);
    }
  } finally {
    h.release();
  }
  if (!res.ok) throw new BadGatewayException(`${host} returned HTTP ${res.status}${res.status === 429 ? ' (rate limited — add an API key in backend/.env)' : ''}`);
  const data = await res.json();
  await cacheSet(key, data, TTL_SEC);
  return data;
}

// ---------- Tron (TRC20) ----------
export function tronHeaders(): Record<string, string> {
  const key = process.env.TRONGRID_API_KEY;
  return key ? { 'TRON-PRO-API-KEY': key } : {};
}
export const tronGap = () => (process.env.TRONGRID_API_KEY ? 80 : 350);

export interface PageOpts {
  minTs?: number; // only rows at or after this ms timestamp (inclusive, so a tx is never split)
  minBlock?: number; // Ethereum equivalent
  fresh?: boolean;
  pageSize?: number;
}

async function* tronPages(addr: string, o: PageOpts): AsyncGenerator<Transfer[]> {
  let url: string | undefined =
    `${TRONGRID}/v1/accounts/${addr}/transactions/trc20?only_confirmed=true&limit=200&contract_address=${TRON_USDT}` + (o.minTs ? `&min_timestamp=${o.minTs}` : '');
  while (url) {
    const j = await fetchJson(url, { headers: tronHeaders() }, tronGap(), o.fresh);
    yield (j.data ?? []).map((t: any) => ({ hash: t.transaction_id, from: t.from, to: t.to, amount: Number(t.value) / 1e6, timestamp: t.block_timestamp }));
    url = j.meta?.links?.next;
  }
}

async function tronBalance(addr: string): Promise<number> {
  const j = await fetchJson(`${TRONGRID}/v1/accounts/${addr}`, { headers: tronHeaders() }, tronGap());
  const entry = (j.data?.[0]?.trc20 ?? []).find((o: Record<string, string>) => TRON_USDT in o);
  return entry ? Number(entry[TRON_USDT]) / 1e6 : 0;
}

async function tronFrozen(addr: string): Promise<boolean> {
  const body = JSON.stringify({
    owner_address: addr,
    contract_address: TRON_USDT,
    function_selector: 'isBlackListed(address)',
    parameter: tronToHex20(addr).padStart(64, '0'),
    visible: true,
  });
  const j = await fetchJson(
    `${TRONGRID}/wallet/triggerconstantcontract`,
    { method: 'POST', headers: { ...tronHeaders(), 'content-type': 'application/json' }, body },
    tronGap(),
  );
  const r = j.constant_result?.[0];
  return r ? BigInt('0x' + r) === 1n : false;
}

// ---------- Ethereum (ERC20) ----------
export const hasEtherscanKey = () => !!process.env.ETHERSCAN_API_KEY;

async function etherscan(params: string, fresh = false): Promise<any> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new BadRequestException('ETHERSCAN_API_KEY is not set in backend/.env — needed for ERC20 addresses');
  const j = await fetchJson(`${ETHERSCAN}&${params}&apikey=${key}`, {}, 220, fresh);
  if (j.error) throw new BadGatewayException(`Etherscan: ${j.error.message ?? JSON.stringify(j.error)}`);
  if (j.status === '0' && !/no transactions/i.test(j.message ?? '')) {
    throw new BadGatewayException(`Etherscan: ${typeof j.result === 'string' ? j.result : j.message}`);
  }
  return j.result;
}

async function* ethPages(addr: string, o: PageOpts): AsyncGenerator<Transfer[]> {
  // Etherscan caps rows per call, so walk backwards block range by block range (newest first).
  const offset = o.pageSize ?? 10000;
  let end: number | null = null;
  do {
    const rows = await etherscan(
      `module=account&action=tokentx&contractaddress=${ETH_USDT}&address=${addr}&page=1&offset=${offset}&sort=desc` +
        (o.minBlock ? `&startblock=${o.minBlock}` : '') +
        (end !== null ? `&endblock=${end}` : ''),
      o.fresh,
    );
    const batch: Transfer[] = (Array.isArray(rows) ? rows : []).map((t: any) => ({
      hash: t.hash,
      from: t.from,
      to: t.to,
      amount: Number(t.value) / 1e6,
      timestamp: Number(t.timeStamp) * 1000,
      block: Number(t.blockNumber),
    }));
    const { keep, nextEnd } = splitBoundary(batch, batch.length >= offset);
    yield keep;
    end = nextEnd;
  } while (end !== null);
}

async function ethBalance(addr: string): Promise<number> {
  const r = await etherscan(`module=account&action=tokenbalance&contractaddress=${ETH_USDT}&address=${addr}&tag=latest`);
  return Number(r) / 1e6;
}

async function ethFrozen(addr: string): Promise<boolean> {
  // 0xe47d6060 = isBlackListed(address) on the USDT contract
  const data = '0xe47d6060' + addr.slice(2).padStart(64, '0');
  const r = await etherscan(`module=proxy&action=eth_call&to=${ETH_USDT}&data=${data}&tag=latest`);
  return typeof r === 'string' && r.length > 2 ? BigInt(r) === 1n : false;
}

// ---------- Single transaction ----------
export interface TxDetail {
  chain: Chain;
  hash: string;
  block: number;
  timestamp: number;
  success: boolean;
  transfers: { from: string; to: string; amount: number }[]; // USDT transfers only
}
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function tronTx(hash: string): Promise<TxDetail> {
  const j = await fetchJson(
    `${TRONGRID}/wallet/gettransactioninfobyid`,
    { method: 'POST', headers: { ...tronHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ value: hash }) },
    tronGap(),
  );
  if (!j?.id) throw new NotFoundException('Transaction not found on Tron');
  const usdtHex = tronToHex20(TRON_USDT);
  return {
    chain: 'tron',
    hash,
    block: j.blockNumber,
    timestamp: j.blockTimeStamp,
    success: j.receipt?.result === 'SUCCESS',
    transfers: (j.log ?? [])
      .filter((l: any) => l.address?.slice(-40) === usdtHex && l.topics?.[0] === TRANSFER_TOPIC)
      .map((l: any) => ({ from: hexToTron(l.topics[1]), to: hexToTron(l.topics[2]), amount: Number(BigInt('0x' + l.data)) / 1e6 })),
  };
}

async function ethTx(hash: string): Promise<TxDetail> {
  const r = await etherscan(`module=proxy&action=eth_getTransactionReceipt&txhash=${hash}`);
  if (!r) throw new NotFoundException('Transaction not found on Ethereum');
  const b = await etherscan(`module=proxy&action=eth_getBlockByNumber&tag=${r.blockNumber}&boolean=false`);
  return {
    chain: 'eth',
    hash,
    block: Number(r.blockNumber),
    timestamp: Number(b?.timestamp ?? 0) * 1000,
    success: r.status === '0x1',
    transfers: (r.logs ?? [])
      .filter((l: any) => l.address?.toLowerCase() === ETH_USDT && l.topics?.[0] === '0x' + TRANSFER_TOPIC)
      .map((l: any) => ({ from: '0x' + l.topics[1].slice(-40), to: '0x' + l.topics[2].slice(-40), amount: Number(BigInt(l.data)) / 1e6 })),
  };
}

// ---------- Tether freeze events ----------
export const FREEZE_TOPICS = {
  added: '42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc', // AddedBlackList(address)
  removed: 'd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c', // RemovedBlackList(address)
};
export interface FreezeEvent {
  address: string;
  added: boolean;
  ts: number; // ms (Tron) or block number (Eth) — used only as a sync cursor
}

/** All Tron freeze + unfreeze events at or after `minTs`, merged oldest first. */
export async function tronFreezeEvents(minTs: number, maxPages = 100): Promise<FreezeEvent[]> {
  const events: FreezeEvent[] = [];
  for (const name of ['AddedBlackList', 'RemovedBlackList']) {
    let url: string | undefined =
      `${TRONGRID}/v1/contracts/${TRON_USDT}/events?event_name=${name}&only_confirmed=true&order_by=block_timestamp,asc&limit=200&min_block_timestamp=${minTs}`;
    for (let p = 0; url && p < maxPages; p++) {
      const j = await fetchJson(url, { headers: tronHeaders() }, tronGap(), true);
      for (const e of j.data ?? []) {
        const raw = e.result?._user ?? e.result?.['0'];
        if (raw) events.push({ address: hexToTron(raw), added: name === 'AddedBlackList', ts: e.block_timestamp });
      }
      url = j.meta?.links?.next;
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

/** Ethereum freeze events from `fromBlock` (one Etherscan page per kind, merged oldest first). */
export async function ethFreezeEvents(fromBlock: number): Promise<{ events: FreezeEvent[]; full: boolean }> {
  const page = async (topic: string, added: boolean) => {
    const rows = await etherscan(`module=logs&action=getLogs&address=${ETH_USDT}&topic0=0x${topic}&fromBlock=${fromBlock}&toBlock=latest&page=1&offset=1000`, true);
    return (Array.isArray(rows) ? rows : []).map((l: any) => ({
      // Ethereum USDT emits the address as non-indexed data; handle indexed too for safety.
      address: '0x' + (l.topics?.[1] ?? l.data).slice(-40).toLowerCase(),
      added,
      ts: Number(l.blockNumber),
      idx: Number(l.logIndex),
    }));
  };
  const a = await page(FREEZE_TOPICS.added, true);
  const r = await page(FREEZE_TOPICS.removed, false);
  const events = [...a, ...r].sort((x, y) => x.ts - y.ts || x.idx - y.idx);
  return { events, full: a.length === 1000 || r.length === 1000 };
}

// ---------- Public API ----------
export const getTx = (c: Chain, hash: string) => (c === 'tron' ? tronTx(hash) : ethTx(hash.toLowerCase()));
/** Newest-first pages straight from the explorer API. Never touches Postgres. */
export const apiPages = (c: Chain, a: string, o: PageOpts = {}) => (c === 'tron' ? tronPages(a, o) : ethPages(a, o));

/** Live API read of the newest `max` transfers. */
export async function apiTransfers(c: Chain, a: string, max: number, fresh = false): Promise<Transfer[]> {
  const out: Transfer[] = [];
  for await (const page of apiPages(c, a, { fresh, pageSize: Math.min(max, 10000) })) {
    out.push(...page);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/** Why a read happened. `graph` = a neighbour node: rows are written through but no backfill is queued. */
export type Reason = 'lookup' | 'watch' | 'case' | 'manual' | 'graph';
type ReadThrough = (c: Chain, a: string, max: number, fresh: boolean, reason: Reason) => Promise<Transfer[]>;
let readThrough: ReadThrough | null = null;
/** TransferIndex registers itself here at boot; before that (and in selfcheck) reads go straight to the API. */
export const setReadThrough = (fn: ReadThrough | null) => void (readThrough = fn);

/** THE choke point for address history: Postgres index when the wallet is covered, live API otherwise (see transfer-index.ts). */
export const getTransfers = (c: Chain, a: string, max = 200, fresh = false, reason: Reason = 'lookup') =>
  readThrough ? readThrough(c, a, max, fresh, reason) : apiTransfers(c, a, max, fresh);
export const getBalance = (c: Chain, a: string) => (c === 'tron' ? tronBalance(a) : ethBalance(a));
export const isTetherFrozen = (c: Chain, a: string) => (c === 'tron' ? tronFrozen(a) : ethFrozen(a));

/** Aggregate transfers by counterparty, sorted by total volume desc. */
export function flows(addr: string, transfers: Transfer[], withTransfers = false): Flow[] {
  const me = norm(addr);
  const m = new Map<string, Flow>();
  for (const t of transfers) {
    const incoming = norm(t.to) === me;
    const other = norm(incoming ? t.from : t.to);
    if (other === me) continue;
    const f = m.get(other) ?? { address: other, in: 0, out: 0, inCount: 0, outCount: 0 };
    if (incoming) {
      f.in += t.amount;
      f.inCount++;
    } else {
      f.out += t.amount;
      f.outCount++;
    }
    if (withTransfers) {
      const key = incoming ? 'inTransfers' : 'outTransfers';
      (f[key] ??= []).push({ hash: t.hash, amount: t.amount, timestamp: t.timestamp });
    }
    m.set(other, f);
  }
  if (withTransfers) {
    const newest = (a: TransferRef, b: TransferRef) => b.timestamp - a.timestamp;
    for (const f of m.values()) {
      f.inTransfers = f.inTransfers?.sort(newest).slice(0, MAX_EDGE_TRANSFERS);
      f.outTransfers = f.outTransfers?.sort(newest).slice(0, MAX_EDGE_TRANSFERS);
    }
  }
  return [...m.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
}
