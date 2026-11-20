export type Chain = 'tron' | 'eth' | 'bsc';
export type Asset = 'usdt' | 'usdc';
export type AssetFilter = Asset | 'all';
export const ASSET_COLOR: Record<Asset, string> = { usdt: '#26a17b', usdc: '#2775ca' };
export const assetSym = (a?: string | null) => (a ?? 'usdt').toUpperCase();
export const TRON_USDC_NOTE = 'Circle ended USDC support on Tron in 2024: USDC shown for Tron is historical on-chain data.';

/** 0x addresses exist on every EVM chain: this guesses Ethereum, the user picks BNB Chain explicitly (see resolveChain). */
export function detectChain(a: string): Chain | null {
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return 'tron';
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'eth';
  return null;
}
export const isEvmAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
/** The chain for an address plus an optional explicit hint (`?chain=bsc`); a hint that cannot own the address is ignored. */
export function resolveChain(a: string, hint?: string | null): Chain | null {
  const c = detectChain(a);
  return c === 'eth' && hint === 'bsc' ? 'bsc' : c;
}
export function detectTx(h: string): Chain | null {
  if (/^[0-9a-fA-F]{64}$/.test(h)) return 'tron';
  if (/^0x[0-9a-fA-F]{64}$/.test(h)) return 'eth';
  return null;
}
/** `?chain=bsc` for BNB Chain addresses; Tron and Ethereum need no hint (they are detected / the default). */
export const chainQ = (c?: string | null) => (c === 'bsc' ? 'chain=bsc' : '');
export const addrHref = (a: string, c?: string | null, asset?: AssetFilter) => {
  const q = [chainQ(c), asset && asset !== 'all' ? `asset=${asset}` : ''].filter(Boolean).join('&');
  return `/address/${a}${q ? `?${q}` : ''}`;
};

/** Amounts: with an asset the symbol, otherwise USD (USDT and USDC are both about one dollar, so mixed volumes are added). */
// Some contracts emit uint256-sized garbage values (e.g. 2^256-1): show those in scientific notation instead of 70 digits.
const fmt = (n: number) => (Math.abs(n) >= 1e15 ? n.toExponential(2) : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));
export const money = (n: number | null | undefined, asset?: string | null) => fmt(n ?? 0) + ' ' + (asset ? assetSym(asset) : 'USD');
export const usdt = (n: number | null | undefined) => money(n, 'usdt');
export const num = (n: number | null | undefined) => fmt(n ?? 0);
export const compact = (n: number) => (Math.abs(n) >= 1e15 ? n.toExponential(1) : n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }));
export const short = (a: string) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const chainName = (c: Chain) => (c === 'tron' ? 'Tron · TRC20' : c === 'bsc' ? 'BNB Chain · BEP20' : 'Ethereum · ERC20');

/** Exact local timestamp (for tooltips). Accepts ms or ISO. */
export const exact = (t: number | string | null | undefined) => (t ? new Date(t).toLocaleString() : '—');
/** Human-readable relative time ("3 h ago"), falling back to a date for old values. */
export function ago(t: number | string | null | undefined): string {
  if (!t) return '—';
  const ms = typeof t === 'number' ? t : Date.parse(t);
  const d = Date.now() - ms;
  if (d < 0 || d > 30 * 864e5) return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const m = Math.floor(d / 6e4);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
export const when = exact;

const EVM_SCAN = { eth: 'https://etherscan.io', bsc: 'https://bscscan.com' };
export const explorerTx = (c: Chain, h: string) => (c === 'tron' ? `https://tronscan.org/#/transaction/${h}` : `${EVM_SCAN[c]}/tx/${h}`);
export const explorerAddr = (c: Chain, a: string) => (c === 'tron' ? `https://tronscan.org/#/address/${a}` : `${EVM_SCAN[c]}/address/${a}`);

export function download(name: string, content: string | Blob, mime = 'text/csv') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export type Level = 'severe' | 'high' | 'medium' | 'low';
export const CATEGORY_COLOR: Record<string, string> = {
  sanctioned: '#ef4444', frozen: '#ef4444', terrorism: '#ef4444', terror: '#ef4444', ransomware: '#ef4444', darknet: '#ef4444',
  scam: '#f43f5e', fraud: '#f43f5e', mixer: '#f97316', gambling: '#f59e0b', exchange: '#14b8a6', service: '#14b8a6', bridge: '#0ea5e9', dex: '#6366f1', other: '#8b5cf6',
};
export const UNLABELLED = '#8b94a7';
export const catColor = (c?: string | null) => (c ? CATEGORY_COLOR[c] ?? CATEGORY_COLOR.other : UNLABELLED);
