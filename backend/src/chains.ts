import { BadRequestException, BadGatewayException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { cacheGet, cacheSet } from './kv';

export type Chain = 'tron' | 'eth';
export interface Transfer {
  hash: string;
  from: string;
  to: string;
  amount: number; // USDT, 6 decimals applied
  timestamp: number; // ms
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

const TTL_SEC = 300; // cache lives in Redis (kv.ts), memory fallback if Redis is down
const tails = new Map<string, Promise<void>>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Cached fetch, serialized per host with a gap to respect free-tier rate limits. `fresh` skips the cache read. */
async function fetchJson(url: string, init: RequestInit = {}, gapMs = 250, fresh = false): Promise<any> {
  const key = url + (init.body ?? '');
  if (!fresh) {
    const hit = await cacheGet(key);
    if (hit !== undefined) return hit;
  }
  const host = new URL(url).host;
  const wait = tails.get(host) ?? Promise.resolve();
  tails.set(host, wait.then(() => sleep(gapMs)));
  await wait;
  let res = await fetch(url, init);
  // Free tiers rate-limit bursts: back off 1s, 2s, 4s, 8s before giving up.
  for (let i = 0; (res.status === 429 || res.status === 503) && i < 4; i++) {
    await sleep(1000 * 2 ** i);
    res = await fetch(url, init);
  }
  if (!res.ok) throw new BadGatewayException(`${host} returned HTTP ${res.status}${res.status === 429 ? ' (rate limited — add an API key in backend/.env)' : ''}`);
  const data = await res.json();
  await cacheSet(key, data, TTL_SEC);
  return data;
}

// ---------- Tron (TRC20) ----------
function tronHeaders(): Record<string, string> {
  const key = process.env.TRONGRID_API_KEY;
  return key ? { 'TRON-PRO-API-KEY': key } : {};
}
const tronGap = () => (process.env.TRONGRID_API_KEY ? 80 : 350);

async function tronTransfers(addr: string, max: number, fresh = false): Promise<Transfer[]> {
  const out: Transfer[] = [];
  let url: string | undefined =
    `${TRONGRID}/v1/accounts/${addr}/transactions/trc20?only_confirmed=true&limit=200&contract_address=${TRON_USDT}`;
  while (url && out.length < max) {
    const j = await fetchJson(url, { headers: tronHeaders() }, tronGap(), fresh);
    for (const t of j.data ?? []) {
      out.push({ hash: t.transaction_id, from: t.from, to: t.to, amount: Number(t.value) / 1e6, timestamp: t.block_timestamp });
    }
    url = j.meta?.links?.next;
  }
  return out.slice(0, max);
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

async function ethTransfers(addr: string, max: number, fresh = false): Promise<Transfer[]> {
  // ponytail: one page only (Etherscan caps page*offset at 10k). Paginate by block range for whale wallets.
  const rows = await etherscan(
    `module=account&action=tokentx&contractaddress=${ETH_USDT}&address=${addr}&page=1&offset=${Math.min(max, 10000)}&sort=desc`,
    fresh,
  );
  return (Array.isArray(rows) ? rows : []).map((t: any) => ({
    hash: t.hash,
    from: t.from,
    to: t.to,
    amount: Number(t.value) / 1e6,
    timestamp: Number(t.timeStamp) * 1000,
  }));
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
export const getTransfers = (c: Chain, a: string, max = 200, fresh = false) =>
  c === 'tron' ? tronTransfers(a, max, fresh) : ethTransfers(a, max, fresh);
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
