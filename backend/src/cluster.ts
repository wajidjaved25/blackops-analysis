import { norm, Transfer } from './chains';

export interface DepositEvidence {
  hotWallet: string;
  outToHot: number;
  totalOut: number;
  depositors: number;
  sweeps?: number; // transfers from the deposit address to the hot wallet (absent on suggestions made before 8C)
  received?: number; // everything the deposit address received
  sweepTx?: string; // hash of the largest sweep, the evidence a reviewer can open
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
  let received = 0;
  let sweeps = 0;
  let sweepTx = '';
  let biggest = 0;
  const senders = new Set<string>();
  for (const t of transfers) {
    const from = norm(t.from);
    const to = norm(t.to);
    if (from === me && to !== me) {
      totalOut += t.amount;
      if (to === h) {
        outToHot += t.amount;
        sweeps++;
        if (t.amount > biggest) [biggest, sweepTx] = [t.amount, t.hash];
      }
    } else if (to === me && from !== me) {
      received += t.amount;
      if (from !== h) senders.add(from);
    }
  }
  if (!totalOut || outToHot / totalOut < MIN_SHARE || senders.size < MIN_DEPOSITORS) return null;
  return { hotWallet: hot, outToHot, totalOut, depositors: senders.size, sweeps, received, sweepTx };
}

/** 0..0.9: grows with the number of distinct depositors, scaled by the share forwarded to the hot wallet. */
export const clusterConfidence = (e: DepositEvidence) => Math.round(Math.min(0.9, 0.5 + 0.05 * Math.min(e.depositors, 8)) * (e.outToHot / e.totalOut) * 100) / 100;

/**
 * 8.16 auto-accept threshold (only ever applied when the hot wallet carries an official exchange label): the sweep is
 * repeated (>= 2 sweeps to the hot wallet) or a single sweep forwards >= 95% of everything the address received.
 * depositEvidence already requires >= 90% of the outflow to reach the hot wallet and >= 3 distinct depositors.
 * Suggestions without sweep data (made before 8C) never qualify; weaker cases stay in the review queue.
 */
export const AUTO_MIN_SWEEPS = 2;
export const AUTO_SINGLE_SWEEP_SHARE = 0.95;
export function autoAcceptDeposit(e: DepositEvidence): boolean {
  if (!e.sweeps || !e.sweepTx || !e.received) return false;
  return e.sweeps >= AUTO_MIN_SWEEPS || e.outToHot / e.received >= AUTO_SINGLE_SWEEP_SHARE;
}

/** "Binance (proof-of-reserves wallet)" -> "Binance". */
export const exchangeName = (labelName: string) => labelName.replace(/\s*\(.*\)\s*$/, '').replace(/\s+(hot\/cold wallet|deposit address)$/i, '').trim() || labelName;
