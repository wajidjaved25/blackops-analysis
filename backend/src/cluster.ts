import { norm, Transfer } from './chains';

export interface DepositEvidence {
  hotWallet: string;
  outToHot: number;
  totalOut: number;
  depositors: number;
}

export const MIN_SHARE = 0.9;
export const MIN_DEPOSITORS = 3;

/**
 * Deposit-address heuristic: an exchange gives each customer a unique deposit address; many different senders pay
 * into it and it sweeps (almost) everything to the exchange's hot wallet. So `addr` looks like a deposit address of
 * `hot` when at least MIN_SHARE of its outflow goes to `hot` and at least MIN_DEPOSITORS distinct wallets paid into it.
 * `transfers` must be the address's own transfer history. Returns null when it does not match.
 */
export function depositEvidence(addr: string, transfers: Transfer[], hot: string): DepositEvidence | null {
  const me = norm(addr);
  const h = norm(hot);
  let totalOut = 0;
  let outToHot = 0;
  const senders = new Set<string>();
  for (const t of transfers) {
    const from = norm(t.from);
    const to = norm(t.to);
    if (from === me && to !== me) {
      totalOut += t.amount;
      if (to === h) outToHot += t.amount;
    } else if (to === me && from !== me && from !== h) senders.add(from);
  }
  if (!totalOut || outToHot / totalOut < MIN_SHARE || senders.size < MIN_DEPOSITORS) return null;
  return { hotWallet: hot, outToHot, totalOut, depositors: senders.size };
}

/** 0..0.9: grows with the number of distinct depositors, scaled by the share forwarded to the hot wallet. */
export const clusterConfidence = (e: DepositEvidence) => Math.round(Math.min(0.9, 0.5 + 0.05 * Math.min(e.depositors, 8)) * (e.outToHot / e.totalOut) * 100) / 100;
