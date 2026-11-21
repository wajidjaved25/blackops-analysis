import { BadRequestException, BadGatewayException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Asset, AssetDef, AssetFilter, assetByContract, assetsOf, Chain, freezeAbi, issuerName, parseUnits, selectAssets } from './assets';
import { splitBoundary } from './index-rules';
import { cacheGet, cacheSet } from './kv';

export type { Asset, AssetFilter, Chain };
export interface Transfer {
  hash: string;
  from: string;
  to: string;
  amount: number; // token units (decimals applied). USDT and USDC are both ≈ 1 USD
  asset: Asset;
  timestamp: number; // ms
  block?: number; // EVM chains only (TronGrid's per-account list has none)
}
export interface TransferRef {
  hash: string;
  amount: number;
  timestamp: number;
  asset: Asset;
}
export interface Flow {
  address: string;
  in: number; // all assets together (USD-equivalent)
  out: number;
  inCount: number;
  outCount: number;
  inTransfers?: TransferRef[]; // only with flows(..., true): newest first, max MAX_EDGE_TRANSFERS
  outTransfers?: TransferRef[];
  asset?: Asset; // set on `parts` entries
  parts?: Flow[]; // only with flows(..., perAsset = true): the same counterparty split by asset
}
export const MAX_EDGE_TRANSFERS = 50;

const TRONGRID = 'https://api.trongrid.io';
const ETHERSCAN_CHAIN_ID: Record<'eth' | 'bsc', number> = { eth: 1, bsc: 56 };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** 0x addresses exist on every EVM chain: this returns the default (Ethereum). The caller picks BSC explicitly (see parseAddr). */
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

export const isEvm = (c: Chain) => c !== 'tron';

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
  minBlock?: number; // EVM equivalent
  maxTs?: number; // only rows at or before this ms timestamp (Tron)
  maxBlock?: number; // EVM equivalent
  fresh?: boolean;
  pageSize?: number;
  assets?: AssetFilter | AssetDef[]; // default: every asset registered for the chain
}

async function* tronPages(addr: string, o: PageOpts, d: AssetDef): AsyncGenerator<Transfer[]> {
  let url: string | undefined =
    `${TRONGRID}/v1/accounts/${addr}/transactions/trc20?only_confirmed=true&limit=200&contract_address=${d.contract}` + (o.minTs ? `&min_timestamp=${o.minTs}` : '') + (o.maxTs ? `&max_timestamp=${o.maxTs}` : '');
  while (url) {
    const j = await fetchJson(url, { headers: tronHeaders() }, tronGap(), o.fresh);
    // TronGrid mixes Approval events into this list (often uint256-max values) — they move no funds.
    yield (j.data ?? []).filter((t: any) => t.type === 'Transfer').map((t: any) => ({ hash: t.transaction_id, from: t.from, to: t.to, amount: parseUnits(t.value, d.decimals), asset: d.asset, timestamp: t.block_timestamp }));
    url = j.meta?.links?.next;
  }
}

async function tronBalances(addr: string): Promise<Record<Asset, number>> {
  const j = await fetchJson(`${TRONGRID}/v1/accounts/${addr}`, { headers: tronHeaders() }, tronGap());
  const held: Record<string, string>[] = j.data?.[0]?.trc20 ?? [];
  const out = {} as Record<Asset, number>;
  for (const d of assetsOf('tron')) {
    const e = held.find((o) => d.contract in o);
    out[d.asset] = e ? parseUnits(e[d.contract], d.decimals) : 0;
  }
  return out;
}

async function tronFrozen(addr: string, d: AssetDef): Promise<boolean> {
  const body = JSON.stringify({
    owner_address: addr,
    contract_address: d.contract,
    function_selector: d.issuer === 'circle' ? 'isBlacklisted(address)' : 'isBlackListed(address)',
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

// ---------- EVM: Ethereum + BNB Smart Chain (Etherscan v2, one key for both) ----------
export const hasEtherscanKey = () => !!process.env.ETHERSCAN_API_KEY;

async function etherscan(chain: 'eth' | 'bsc', params: string, fresh = false): Promise<any> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new BadRequestException('ETHERSCAN_API_KEY is not set in backend/.env — needed for Ethereum and BNB Chain addresses');
  const j = await fetchJson(`https://api.etherscan.io/v2/api?chainid=${ETHERSCAN_CHAIN_ID[chain]}&${params}&apikey=${key}`, {}, 360, fresh); // free plan allows 3 calls/s; 220 ms (4.5/s) made the freeze-list syncs fail with "Max calls per sec"
  if (j.error) throw new BadGatewayException(`Etherscan: ${j.error.message ?? JSON.stringify(j.error)}`);
  if (j.status === '0' && !/no (transactions|records) found/i.test(j.message ?? '')) {
    throw new BadGatewayException(`Etherscan: ${typeof j.result === 'string' ? j.result : j.message}`);
  }
  return j.result;
}

async function* evmPages(chain: 'eth' | 'bsc', addr: string, o: PageOpts, d: AssetDef): AsyncGenerator<Transfer[]> {
  // Etherscan caps rows per call, so walk backwards block range by block range (newest first).
  const offset = o.pageSize ?? 10000;
  let end: number | null = o.maxBlock ?? null;
  do {
    const rows = await etherscan(
      chain,
      `module=account&action=tokentx&contractaddress=${d.contract}&address=${addr}&page=1&offset=${offset}&sort=desc` +
        (o.minBlock ? `&startblock=${o.minBlock}` : '') +
        (end !== null ? `&endblock=${end}` : ''),
      o.fresh,
    );
    const batch: Transfer[] = (Array.isArray(rows) ? rows : []).map((t: any) => ({
      hash: t.hash,
      from: t.from,
      to: t.to,
      amount: parseUnits(t.value, d.decimals),
      asset: d.asset,
      timestamp: Number(t.timeStamp) * 1000,
      block: Number(t.blockNumber),
    }));
    const { keep, nextEnd } = splitBoundary(batch, batch.length >= offset);
    yield keep;
    end = nextEnd;
  } while (end !== null);
}

async function evmBalances(chain: 'eth' | 'bsc', addr: string): Promise<Record<Asset, number>> {
  const out = {} as Record<Asset, number>;
  for (const d of assetsOf(chain)) out[d.asset] = parseUnits(await etherscan(chain, `module=account&action=tokenbalance&contractaddress=${d.contract}&address=${addr}&tag=latest`), d.decimals);
  return out;
}

async function evmFrozen(chain: 'eth' | 'bsc', addr: string, d: AssetDef): Promise<boolean> {
  const data = freezeAbi(d.issuer!).isFrozen + addr.slice(2).padStart(64, '0');
  const r = await etherscan(chain, `module=proxy&action=eth_call&to=${d.contract}&data=${data}&tag=latest`);
  return typeof r === 'string' && r.length > 2 ? BigInt(r) === 1n : false;
}

// ---------- Single transaction ----------
export interface TxDetail {
  chain: Chain;
  hash: string;
  block: number;
  timestamp: number;
  success: boolean;
  transfers: { from: string; to: string; amount: number; asset: Asset }[]; // tracked stablecoin transfers only
  nativeSymbol: 'TRX' | 'ETH' | 'BNB';
  native: NativeMove[]; // value-carrying internal calls (TRX / ETH / BNB), failed ones excluded — what swap detection reads
}
export interface NativeMove {
  from: string;
  to: string;
  amount: number;
}
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function tronTx(hash: string): Promise<TxDetail> {
  const j = await fetchJson(
    `${TRONGRID}/wallet/gettransactioninfobyid`,
    { method: 'POST', headers: { ...tronHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ value: hash }) },
    tronGap(),
  );
  if (!j?.id) throw new NotFoundException('Transaction not found on Tron');
  return parseTronTx(j, hash);
}

/** gettransactioninfobyid response -> TxDetail (pure, so selfcheck can run it on a crafted response). */
export function parseTronTx(j: any, hash: string): TxDetail {
  const byHex = new Map(assetsOf('tron').map((d) => [tronToHex20(d.contract), d]));
  return {
    chain: 'tron',
    hash,
    block: j.blockNumber,
    timestamp: j.blockTimeStamp,
    success: j.receipt?.result === 'SUCCESS',
    nativeSymbol: 'TRX',
    // A TRX payout (e.g. a swap's output) is an internal call with a callValue in SUN; rejected calls moved nothing.
    native: (j.internal_transactions ?? [])
      .filter((i: any) => !i.rejected && Number(i.callValueInfo?.[0]?.callValue) > 0)
      .map((i: any) => ({ from: hexToTron(i.caller_address), to: hexToTron(i.transferTo_address), amount: parseUnits(BigInt(i.callValueInfo[0].callValue), 6) })),
    transfers: (j.log ?? [])
      .filter((l: any) => byHex.has(l.address?.slice(-40)) && l.topics?.[0] === TRANSFER_TOPIC)
      .map((l: any) => {
        const d = byHex.get(l.address.slice(-40))!;
        return { from: hexToTron(l.topics[1]), to: hexToTron(l.topics[2]), amount: parseUnits(BigInt('0x' + l.data), d.decimals), asset: d.asset };
      }),
  };
}

async function evmInternal(chain: 'eth' | 'bsc', hash: string): Promise<NativeMove[]> {
  const rows = await etherscan(chain, `module=account&action=txlistinternal&txhash=${hash}`);
  return (Array.isArray(rows) ? rows : [])
    .filter((x: any) => x.isError === '0' && BigInt(x.value || 0) > 0n)
    .map((x: any) => ({ from: x.from.toLowerCase(), to: x.to.toLowerCase(), amount: parseUnits(x.value, 18) }));
}

async function evmTx(chain: 'eth' | 'bsc', hash: string): Promise<TxDetail> {
  const r = await etherscan(chain, `module=proxy&action=eth_getTransactionReceipt&txhash=${hash}`);
  if (!r) throw new NotFoundException(`Transaction not found on ${chain === 'bsc' ? 'BNB Chain' : 'Ethereum'}`);
  const b = await etherscan(chain, `module=proxy&action=eth_getBlockByNumber&tag=${r.blockNumber}&boolean=false`);
  return {
    chain,
    hash,
    block: Number(r.blockNumber),
    timestamp: Number(b?.timestamp ?? 0) * 1000,
    success: r.status === '0x1',
    nativeSymbol: chain === 'bsc' ? 'BNB' : 'ETH',
    native: await evmInternal(chain, hash),
    transfers: (r.logs ?? []).flatMap((l: any) => {
      const d = assetByContract(chain, l.address ?? '');
      if (!d || l.topics?.[0] !== '0x' + TRANSFER_TOPIC || l.topics.length !== 3) return [];
      return [{ from: '0x' + l.topics[1].slice(-40), to: '0x' + l.topics[2].slice(-40), amount: parseUnits(BigInt(l.data), d.decimals), asset: d.asset }];
    }),
  };
}

// ---------- Issuer freeze events (Tether AddedBlackList/RemovedBlackList, Circle Blacklisted/UnBlacklisted) ----------
export interface FreezeEvent {
  address: string;
  added: boolean;
  ts: number; // ms (Tron) or block number (EVM) — used only as a sync cursor
  idx?: number;
}
const TRON_EVENT_NAMES = {
  tether: { added: 'AddedBlackList', removed: 'RemovedBlackList' },
  circle: { added: 'Blacklisted', removed: 'UnBlacklisted' },
};

/** All Tron freeze + unfreeze events of one issuer's contract at or after `minTs`, merged oldest first. */
export async function tronFreezeEvents(issuer: 'tether' | 'circle', minTs: number, maxPages = 100): Promise<FreezeEvent[]> {
  const d = assetsOf('tron').find((x) => x.issuer === issuer)!;
  const events: FreezeEvent[] = [];
  for (const [kind, name] of Object.entries(TRON_EVENT_NAMES[issuer])) {
    let url: string | undefined =
      `${TRONGRID}/v1/contracts/${d.contract}/events?event_name=${name}&only_confirmed=true&order_by=block_timestamp,asc&limit=200&min_block_timestamp=${minTs}`;
    for (let p = 0; url && p < maxPages; p++) {
      const j = await fetchJson(url, { headers: tronHeaders() }, tronGap(), true);
      for (const e of j.data ?? []) {
        const raw = e.result?._user ?? e.result?._account ?? e.result?.['0'];
        if (raw) events.push({ address: hexToTron(raw), added: kind === 'added', ts: e.block_timestamp });
      }
      url = j.meta?.links?.next;
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

/** One Etherscan getLogs row -> event. Tether emits the address as non-indexed data, Circle as indexed topic 1; both handled. */
export function parseFreezeLog(l: { topics?: string[]; data?: string; blockNumber: string; logIndex?: string }, issuer: 'tether' | 'circle'): FreezeEvent | null {
  const abi = freezeAbi(issuer);
  const t0 = (l.topics?.[0] ?? '').replace(/^0x/, '').toLowerCase();
  if (t0 !== abi.added && t0 !== abi.removed) return null;
  const raw = l.topics?.[1] ?? l.data;
  if (!raw || raw.length < 42) return null;
  return { address: '0x' + raw.slice(-40).toLowerCase(), added: t0 === abi.added, ts: Number(l.blockNumber), idx: Number(l.logIndex ?? 0) };
}

/** Ethereum freeze events of one issuer from `fromBlock` (one Etherscan page per kind, merged oldest first). */
export async function ethFreezeEvents(issuer: 'tether' | 'circle', fromBlock: number): Promise<{ events: FreezeEvent[]; full: boolean }> {
  const d = assetsOf('eth').find((x) => x.issuer === issuer)!;
  const abi = freezeAbi(issuer);
  const page = async (topic: string) => {
    const rows = await etherscan('eth', `module=logs&action=getLogs&address=${d.contract}&topic0=0x${topic}&fromBlock=${fromBlock}&toBlock=latest&page=1&offset=1000`, true);
    return (Array.isArray(rows) ? rows : []).flatMap((l: any) => parseFreezeLog(l, issuer) ?? []);
  };
  const a = await page(abi.added);
  const r = await page(abi.removed);
  const events = [...a, ...r].sort((x, y) => x.ts - y.ts || (x.idx ?? 0) - (y.idx ?? 0));
  return { events, full: a.length === 1000 || r.length === 1000 };
}

// ---------- Public API ----------
/** A confirmed transaction never changes, so tx detail (incl. what swap detection needs) is cached for a day on top of the 15-min HTTP cache. */
export async function getTx(c: Chain, hash: string): Promise<TxDetail> {
  const h = c === 'tron' ? hash : hash.toLowerCase();
  const key = `tx:v2:${c}:${h}`;
  const hit = await cacheGet(key);
  if (hit !== undefined) return hit;
  const t = await (c === 'tron' ? tronTx(h) : evmTx(c, h));
  await cacheSet(key, t, 86400);
  return t;
}

/** Block number at (or just before/after) a Unix time on an EVM chain — turns a time window into a block window. */
async function evmBlockAt(chain: 'eth' | 'bsc', tsMs: number, closest: 'before' | 'after'): Promise<number> {
  const r = await etherscan(chain, `module=block&action=getblocknobytime&timestamp=${Math.floor(tsMs / 1000)}&closest=${closest}`);
  return Number(r);
}

/**
 * Transfers of one wallet inside [fromMs, toMs] (not just the newest N), straight from the explorer API: Tron via
 * min/max_timestamp, EVM via getblocknobytime + startblock/endblock. Bounded: stops after `maxRows` and says so.
 */
export async function windowTransfers(c: Chain, addr: string, fromMs: number, toMs: number, assets: AssetFilter = 'all', maxRows = 600): Promise<{ rows: Transfer[]; truncated: boolean }> {
  const o: PageOpts = c === 'tron' ? { minTs: fromMs, maxTs: toMs, assets } : { minBlock: await evmBlockAt(c, fromMs, 'after'), maxBlock: await evmBlockAt(c, toMs, 'before'), assets };
  const rows: Transfer[] = [];
  let truncated = false;
  for await (const page of apiPages(c, addr, o)) {
    rows.push(...page);
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
  }
  return { rows: rows.filter((t) => t.timestamp >= fromMs && t.timestamp <= toMs), truncated };
}

const defsFor = (c: Chain, a?: PageOpts['assets']): AssetDef[] => (Array.isArray(a) ? a : selectAssets(c, a));

/** Newest-first pages straight from the explorer API, one asset after the other. Never touches Postgres. */
export async function* apiPages(c: Chain, a: string, o: PageOpts = {}): AsyncGenerator<Transfer[]> {
  for (const d of defsFor(c, o.assets)) yield* c === 'tron' ? tronPages(a, o, d) : evmPages(c, a, o, d);
}

/** Live API read of the newest `max` transfers across the chosen assets (each asset is fetched concurrently, then merged). */
export async function apiTransfers(c: Chain, a: string, max: number, fresh = false, assets: AssetFilter = 'all'): Promise<Transfer[]> {
  const per = await Promise.all(
    defsFor(c, assets).map(async (d) => {
      const out: Transfer[] = [];
      for await (const page of apiPages(c, a, { fresh, pageSize: Math.min(max, 10000), assets: [d] })) {
        out.push(...page);
        if (out.length >= max) break;
      }
      return out.slice(0, max);
    }),
  );
  return per.length === 1 ? per[0] : per.flat().sort((x, y) => y.timestamp - x.timestamp).slice(0, max);
}

/** Why a read happened. `graph` = a neighbour node: rows are written through but no backfill is queued. */
export type Reason = 'lookup' | 'watch' | 'case' | 'manual' | 'graph';
type ReadThrough = (c: Chain, a: string, max: number, fresh: boolean, reason: Reason, assets: AssetFilter) => Promise<Transfer[]>;
let readThrough: ReadThrough | null = null;
/** TransferIndex registers itself here at boot; before that (and in selfcheck) reads go straight to the API. */
export const setReadThrough = (fn: ReadThrough | null) => void (readThrough = fn);

/** THE choke point for address history: Postgres index when the wallet is covered, live API otherwise (see transfer-index.ts). */
export const getTransfers = (c: Chain, a: string, max = 200, fresh = false, reason: Reason = 'lookup', assets: AssetFilter = 'all') =>
  readThrough ? readThrough(c, a, max, fresh, reason, assets) : apiTransfers(c, a, max, fresh, assets);
export const getBalances = (c: Chain, a: string) => (c === 'tron' ? tronBalances(a) : evmBalances(c, a));

/** Per asset: true/false = the issuer's blacklist says so; null = this token has no issuer freeze (BSC pegged tokens). */
export type FrozenMap = Record<Asset, boolean | null>;
export async function frozenStatus(c: Chain, a: string): Promise<FrozenMap> {
  const out = {} as FrozenMap;
  await Promise.all(
    assetsOf(c).map(async (d) => {
      out[d.asset] = !d.issuer ? null : c === 'tron' ? await tronFrozen(a, d) : await evmFrozen(c as 'eth', a, d);
    }),
  );
  return out;
}
/** Issuer names that currently have the wallet frozen, e.g. ['Tether', 'Circle']. */
export const frozenBy = (c: Chain, m: FrozenMap): string[] => [...new Set(assetsOf(c).filter((d) => m[d.asset] && d.issuer).map((d) => issuerName[d.issuer!]))];

/** Aggregate transfers by counterparty, sorted by total volume desc. `perAsset` also splits each counterparty into `parts` per asset (graph edges). */
export function flows(addr: string, transfers: Transfer[], withTransfers = false, perAsset = false): Flow[] {
  const agg = (list: Transfer[]) => {
    const me = norm(addr);
    const m = new Map<string, Flow>();
    for (const t of list) {
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
        (f[key] ??= []).push({ hash: t.hash, amount: t.amount, timestamp: t.timestamp, asset: t.asset });
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
    return m;
  };
  const all = agg(transfers);
  if (perAsset) {
    for (const asset of new Set(transfers.map((t) => t.asset))) {
      for (const f of agg(transfers.filter((t) => t.asset === asset)).values()) (all.get(f.address)!.parts ??= []).push({ ...f, asset });
    }
  }
  return [...all.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
}
