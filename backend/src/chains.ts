import { BadRequestException, BadGatewayException } from '@nestjs/common';

export type Chain = 'tron' | 'eth';
export interface Transfer {
  hash: string;
  from: string;
  to: string;
  amount: number; // USDT, 6 decimals applied
  timestamp: number; // ms
}
export interface Flow {
  address: string;
  in: number;
  out: number;
  count: number;
}

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

// ponytail: in-memory cache, unbounded and lost on restart. Move to Redis if it grows or you run >1 instance.
const cache = new Map<string, { at: number; data: any }>();
const TTL = 5 * 60_000;
const tails = new Map<string, Promise<void>>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Cached fetch, serialized per host with a gap to respect free-tier rate limits. */
async function fetchJson(url: string, init: RequestInit = {}, gapMs = 250): Promise<any> {
  const key = url + (init.body ?? '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const host = new URL(url).host;
  const wait = tails.get(host) ?? Promise.resolve();
  tails.set(host, wait.then(() => sleep(gapMs)));
  await wait;
  const res = await fetch(url, init);
  if (!res.ok) throw new BadGatewayException(`${host} returned HTTP ${res.status}`);
  const data = await res.json();
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- Tron (TRC20) ----------
function tronHeaders(): Record<string, string> {
  const key = process.env.TRONGRID_API_KEY;
  return key ? { 'TRON-PRO-API-KEY': key } : {};
}
const tronGap = () => (process.env.TRONGRID_API_KEY ? 80 : 350);

async function tronTransfers(addr: string, max: number): Promise<Transfer[]> {
  const out: Transfer[] = [];
  let url: string | undefined =
    `${TRONGRID}/v1/accounts/${addr}/transactions/trc20?only_confirmed=true&limit=200&contract_address=${TRON_USDT}`;
  while (url && out.length < max) {
    const j = await fetchJson(url, { headers: tronHeaders() }, tronGap());
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
async function etherscan(params: string): Promise<any> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new BadRequestException('ETHERSCAN_API_KEY is not set in backend/.env — needed for ERC20 addresses');
  const j = await fetchJson(`${ETHERSCAN}&${params}&apikey=${key}`, {}, 220);
  if (j.error) throw new BadGatewayException(`Etherscan: ${j.error.message ?? JSON.stringify(j.error)}`);
  if (j.status === '0' && !/no transactions/i.test(j.message ?? '')) {
    throw new BadGatewayException(`Etherscan: ${typeof j.result === 'string' ? j.result : j.message}`);
  }
  return j.result;
}

async function ethTransfers(addr: string, max: number): Promise<Transfer[]> {
  // ponytail: one page only (Etherscan caps page*offset at 10k). Paginate by block range for whale wallets.
  const rows = await etherscan(
    `module=account&action=tokentx&contractaddress=${ETH_USDT}&address=${addr}&page=1&offset=${Math.min(max, 10000)}&sort=desc`,
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

// ---------- Public API ----------
export const getTransfers = (c: Chain, a: string, max = 200) => (c === 'tron' ? tronTransfers(a, max) : ethTransfers(a, max));
export const getBalance = (c: Chain, a: string) => (c === 'tron' ? tronBalance(a) : ethBalance(a));
export const isTetherFrozen = (c: Chain, a: string) => (c === 'tron' ? tronFrozen(a) : ethFrozen(a));

/** Aggregate transfers by counterparty, sorted by total volume desc. */
export function flows(addr: string, transfers: Transfer[]): Flow[] {
  const me = norm(addr);
  const m = new Map<string, Flow>();
  for (const t of transfers) {
    const incoming = norm(t.to) === me;
    const other = norm(incoming ? t.from : t.to);
    if (other === me) continue;
    const f = m.get(other) ?? { address: other, in: 0, out: 0, count: 0 };
    if (incoming) f.in += t.amount;
    else f.out += t.amount;
    f.count++;
    m.set(other, f);
  }
  return [...m.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
}
