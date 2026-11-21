// Binance proof-of-reserves helpers (snapshot discovery + CSV line parser). Phase 10A: the lists themselves are now stored
// in ExchangeAddress by exchange-lists.ts; the old stream-and-find "check" was replaced by a table lookup.
import { Chain, fetchJson } from './chains';

const BASE = 'https://www.binance.com/bapi/apex/v1/public/apex/market';
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const POR_MAX_INPUT = 5000;

export interface PorAddr {
  chain: Chain;
  address: string;
}
export type PorKind = 'hotcold' | 'deposit';
export type Snap = { y: number; m: number; d: number };

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

/** Cheap check: the snapshot list only (one small request), newest first. */
export async function latestSnapshots(): Promise<Snap[]> {
  const j = await fetchJson(`${BASE}/query/auditProofSnapshotCondition`, {}, 500);
  const snaps = (Array.isArray(j?.data) ? j.data : []).map((s: unknown) => (typeof s === 'string' ? parseSnapshot(s) : null)).filter(Boolean) as Snap[];
  if (!snaps.length) throw new Error('Binance snapshot list is empty or has a new format');
  return snaps;
}
export async function resolveSnapshot(): Promise<{ snap: Snap; url: string }> {
  for (const snap of (await latestSnapshots()).slice(0, 3)) {
    const r = await fetchJson(`${BASE}/por/getDownloadUrl?auditId=${auditId(snap)}`, {}, 500).catch(() => null);
    const url = typeof r?.data === 'string' ? r.data : '';
    if (/^https:\/\/[a-z0-9.-]*bnbstatic\.com\/.+\.zip$/i.test(url)) return { snap, url };
  }
  throw new Error('Binance did not return a download URL for the latest 3 snapshots');
}

