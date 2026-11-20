// Exchange statement parsing + on-chain matching (Phase 8A). Pure functions, no I/O: covered by selfcheck.ts.
import type { Asset, Chain } from './assets';
import { detectChain, isTxHash, norm } from './chains';

export const MAX_ROWS = 5000;
export const AMOUNT_TOL = 1e-6; // Binance prints at most 6-8 decimals; USDT/USDC have 6
export const DEFAULT_TIME_TOL_MIN = 120;

export type Cell = string | number | null;
export type Mapping = Partial<Record<'time' | 'coin' | 'network' | 'amount' | 'fee' | 'address' | 'hash' | 'status', number>>;
export const MAPPING_KEYS = ['time', 'coin', 'network', 'amount', 'fee', 'address', 'hash', 'status'] as const;
export type Format = 'binance_withdrawal' | 'binance_deposit' | 'generic';

const cellText = (c: Cell | undefined) => (c === null || c === undefined ? '' : String(c).trim());

/** "UTC+5", "UTC-3:30", "+05:30", "UTC" -> minutes east of UTC; null if it is not an offset. */
export function tzMinutes(s: string): number | null {
  const m = s.trim().match(/^(?:UTC|GMT)?\s*(?:([+-])\s*(\d{1,2})(?::?(\d{2}))?)?$/i);
  if (!m || (!m[1] && !/utc|gmt/i.test(s))) return null;
  if (!m[1]) return 0;
  const min = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return min > 14 * 60 ? null : (m[1] === '-' ? -min : min);
}

/** Offset named in a header such as "Time (UTC+5)" or "Date(UTC)"; null when the header names none. */
export const headerTz = (h: string): number | null => {
  const m = h.match(/\(\s*((?:UTC|GMT)[^)]*)\)/i);
  return m ? tzMinutes(m[1]) : null;
};

/** "2026-01-05 13:45:10" (also "/" dates, "T" separator, no seconds) read in the statement's own timezone -> real instant. */
export function parseTime(text: string, tzMin: number): Date | null {
  const m = text.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? 0, m[5] ?? 0, m[6] ?? 0].map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, s) - tzMin * 60000;
  const dt = new Date(t);
  // Date.UTC rolls 2026-02-31 over to March: reject that rather than silently shift the day
  return Number.isNaN(t) || new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d || h > 23 || mi > 59 || s > 59 ? null : dt;
}

/** Statement "Network" column -> chain. null = not one of the chains we trace. */
export function networkChain(n: string): Chain | null {
  const v = n.trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (['TRX', 'TRC20', 'TRON'].includes(v)) return 'tron';
  if (['ETH', 'ERC20', 'ETHEREUM'].includes(v)) return 'eth';
  if (['BSC', 'BEP20', 'BNB', 'BNBSMARTCHAIN', 'BNBCHAIN'].includes(v)) return 'bsc';
  return null;
}

export const OFFCHAIN = /^off-?chain transfer\b/i;

const COLS: Record<keyof Mapping, RegExp> = {
  time: /^(time|date)\b/i,
  coin: /^(coin|asset|currency|token)$/i,
  network: /^(network|chain)$/i,
  amount: /^amount$/i,
  fee: /^(fee|transaction fee)$/i,
  address: /^(address|destination address|to|to address|deposit address)$/i,
  hash: /^(txid|tx id|txhash|tx hash|transaction id|transaction hash|hash)$/i,
  status: /^status$/i,
};

/** Header row -> format + column mapping, keyed on the headers (never the file name). */
export function detectFormat(headers: Cell[]): { format: Format; mapping: Mapping; tz: number | null } {
  const mapping: Mapping = {};
  headers.forEach((h, i) => {
    const t = cellText(h);
    for (const k of MAPPING_KEYS) if (mapping[k] === undefined && COLS[k].test(t)) mapping[k] = i;
  });
  const tz = mapping.time !== undefined ? headerTz(cellText(headers[mapping.time])) : null;
  const binance = (['time', 'coin', 'network', 'amount', 'address', 'hash'] as const).every((k) => mapping[k] !== undefined);
  return { format: binance ? (mapping.fee !== undefined ? 'binance_withdrawal' : 'binance_deposit') : 'generic', mapping, tz };
}

export interface NormRow {
  row: number; // spreadsheet row number
  chain: Chain | null;
  hash: string | null;
  ref: string | null; // "Off-chain transfer 123"
  offChain: boolean;
  address: string | null;
  amount: number | null;
  fee: number | null;
  coin: string | null;
  asset: Asset | null;
  network: string | null;
  claimedAt: Date | null;
  problems: string[]; // a row with problems is shown in the preview and not imported
  raw: Record<string, Cell>;
}

const num = (c: Cell | undefined): number | null => {
  const t = cellText(c).replace(/,/g, '');
  return t === '' ? null : /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
};

/** Grid (row 0 = headers; blank rows kept so row numbers match the sheet) -> normalised rows with per-row problems. */
export function normalizeRows(grid: Cell[][], mapping: Mapping, o: { tz: number; defaultChain?: Chain | null }): NormRow[] {
  const headers = (grid[0] ?? []).map((h, i) => cellText(h) || `column ${i + 1}`);
  const get = (r: Cell[], k: keyof Mapping) => (mapping[k] === undefined ? undefined : r[mapping[k]!]);
  const out: NormRow[] = [];
  const seen = new Map<string, number>();
  grid.forEach((r, idx) => {
    if (idx === 0 || !r.some((c) => cellText(c) !== '')) return;
    const problems: string[] = [];
    const raw: Record<string, Cell> = {};
    headers.forEach((h, i) => (raw[h] = r[i] ?? null));

    const hashText = cellText(get(r, 'hash'));
    const offChain = OFFCHAIN.test(hashText);
    const netText = cellText(get(r, 'network'));
    let chain: Chain | null = null;
    if (!offChain) {
      if (netText) chain = networkChain(netText);
      else chain = o.defaultChain ?? (/^[0-9a-f]{64}$/i.test(hashText) ? 'tron' : /^0x[0-9a-f]{64}$/i.test(hashText) ? 'eth' : null);
      if (!chain) problems.push(netText ? `Network "${netText.slice(0, 30)}" is not Tron, Ethereum or BNB Chain` : 'No network and no default chain chosen');
    }

    let hash: string | null = null;
    if (!offChain && chain) {
      const h = chain === 'tron' ? hashText.replace(/^0x/i, '').toLowerCase() : hashText.toLowerCase();
      if (isTxHash(chain, h)) hash = h;
      else problems.push(hashText ? `Not a valid ${chain} transaction hash` : 'Transaction hash is empty');
    }

    const addrText = cellText(get(r, 'address'));
    let address: string | null = addrText || null;
    if (!offChain && chain && address) {
      const d = detectChain(address);
      if (!d || (chain === 'tron') !== (d === 'tron')) problems.push(`Address is not a valid ${chain} address`);
      else address = norm(address);
    } else if (!offChain && !address && chain) problems.push('Address is empty');

    const amount = num(get(r, 'amount'));
    if (Number.isNaN(amount)) problems.push('Amount is not a number');
    const fee = num(get(r, 'fee'));
    if (Number.isNaN(fee)) problems.push('Fee is not a number');

    const coin = cellText(get(r, 'coin')).toUpperCase() || null;
    const asset: Asset | null = coin === 'USDT' ? 'usdt' : coin === 'USDC' ? 'usdc' : null;
    if (coin && !asset) problems.push(`Coin ${coin.slice(0, 12)} is not USDT or USDC`);

    const timeText = cellText(get(r, 'time'));
    const claimedAt = timeText ? parseTime(timeText, o.tz) : null;
    if (timeText && !claimedAt) problems.push(`Time "${timeText.slice(0, 30)}" is not YYYY-MM-DD HH:MM:SS`);

    const status = cellText(get(r, 'status'));
    if (status && !/^(completed|complete|success|successful|done|credited)$/i.test(status)) problems.push(`Statement status is "${status.slice(0, 30)}", not completed`);

    if (hash && chain) {
      const k = chain + hash;
      if (seen.has(k)) problems.push(`Same transaction hash as row ${seen.get(k)}; each hash is stored once per case`);
      else seen.set(k, idx + 1);
    }
    out.push({
      row: idx + 1, chain, hash, ref: offChain ? hashText : null, offChain, address,
      amount: Number.isNaN(amount) ? null : (amount as number | null),
      fee: Number.isNaN(fee) ? null : (fee as number | null),
      coin, asset, network: netText || null, claimedAt, problems, raw,
    });
  });
  return out;
}

// ---------- matching a claim against the chain ----------
export interface Claim {
  address?: string | null;
  amount?: number | null; // Binance "Amount" is the NET amount received on-chain; Fee is separate
  fee?: number | null;
  asset?: Asset | null;
  claimedAt?: Date | null;
}
export interface TxLike {
  success: boolean;
  timestamp: number;
  transfers: { from: string; to: string; amount: number; asset: Asset }[];
}
export interface Outcome {
  status: 'verified' | 'mismatch';
  reasons: string[];
  onFrom: string | null;
  onTo: string | null;
  onAmount: number | null;
  onAsset: Asset | null;
  onAt: Date | null;
}

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const nothing = (reason: string, onAt: Date | null): Outcome => ({ status: 'mismatch', reasons: [reason], onFrom: null, onTo: null, onAmount: null, onAsset: null, onAt });

/** Checks only the fields the claim has. A tx with several transfers matches the one paid to the claimed address. */
export function matchTx(claim: Claim, tx: TxLike, timeTolMin = DEFAULT_TIME_TOL_MIN): Outcome {
  const onAt = tx.timestamp ? new Date(tx.timestamp) : null;
  if (!tx.success) return nothing('Transaction failed on-chain; no funds moved', onAt);
  if (!tx.transfers.length) return nothing('No USDT/USDC transfer in this transaction', onAt);
  let pool = tx.transfers;
  if (claim.address) {
    const to = norm(claim.address);
    pool = pool.filter((t) => norm(t.to) === to);
    if (!pool.length) {
      const others = [...new Set(tx.transfers.map((t) => short(t.to)))];
      return nothing(`No transfer to the claimed address ${short(claim.address)} in this transaction (it pays ${others.slice(0, 3).join(', ')}${others.length > 3 ? ', …' : ''})`, onAt);
    }
  }
  const reasons: string[] = [];
  if (claim.asset) {
    const same = pool.filter((t) => t.asset === claim.asset);
    if (same.length) pool = same;
    else reasons.push(`Coin differs: statement ${claim.asset.toUpperCase()}, on-chain ${pool[0].asset.toUpperCase()}`);
  }
  const want = claim.amount;
  const pick = want == null ? pool[0] : [...pool].sort((a, b) => Math.abs(a.amount - want) - Math.abs(b.amount - want))[0];
  if (want != null && Math.abs(pick.amount - want) > AMOUNT_TOL) {
    const gross = claim.fee != null && Math.abs(pick.amount - (want + claim.fee)) <= AMOUNT_TOL;
    reasons.push(
      gross
        ? `Amount differs: on-chain ${pick.amount} equals statement Amount ${want} plus Fee ${claim.fee}, but the statement Amount should already be net of the fee`
        : `Amount differs: statement ${want} (net, fee ${claim.fee ?? 0} separate), on-chain ${pick.amount}`,
    );
  }
  if (claim.claimedAt && tx.timestamp) {
    const diff = Math.abs(tx.timestamp - claim.claimedAt.getTime());
    if (diff > timeTolMin * 60000) {
      reasons.push(`Time differs by ${(diff / 3600000).toFixed(1)} h (statement ${utc(claim.claimedAt.getTime())}, on-chain ${utc(tx.timestamp)}; tolerance ±${timeTolMin / 60} h)`);
    }
  }
  return { status: reasons.length ? 'mismatch' : 'verified', reasons, onFrom: pick.from, onTo: pick.to, onAmount: pick.amount, onAsset: pick.asset, onAt };
}
