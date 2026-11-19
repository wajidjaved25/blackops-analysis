export type Chain = 'tron' | 'eth';

export function detectChain(a: string): Chain | null {
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return 'tron';
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'eth';
  return null;
}

export function detectTx(h: string): Chain | null {
  if (/^[0-9a-fA-F]{64}$/.test(h)) return 'tron';
  if (/^0x[0-9a-fA-F]{64}$/.test(h)) return 'eth';
  return null;
}

export const usdt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' USDT';
export const compact = (n: number) => n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : '—');
export const chainName = (c: Chain) => (c === 'tron' ? 'Tron · TRC20' : 'Ethereum · ERC20');

export const explorerTx = (c: Chain, h: string) => (c === 'tron' ? `https://tronscan.org/#/transaction/${h}` : `https://etherscan.io/tx/${h}`);
export const explorerAddr = (c: Chain, a: string) => (c === 'tron' ? `https://tronscan.org/#/address/${a}` : `https://etherscan.io/address/${a}`);

/** Fetch JSON from our API; throws with the backend's error message on failure. */
export async function api<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path);
  } catch {
    throw new Error('Cannot reach the server');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j as { message?: string | string[] }).message;
    throw new Error(Array.isArray(m) ? m.join(', ') : m ?? `Request failed (HTTP ${r.status})`);
  }
  return j as T;
}
