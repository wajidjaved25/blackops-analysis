// Phase 9C: "possibly same owner" wallet grouping. Pure functions over transfer histories: covered by selfcheck.ts.
// Every group is a HEURISTIC with the transfers that triggered it. Nothing here is ever asserted as fact or stored as a label.
import { norm, Transfer } from './chains';

export type GroupKind = 'common_funder' | 'shared_deposit' | 'round_trip';
export interface GroupEvidence {
  hash: string;
  chain: string;
  from: string;
  to: string;
  amount: number;
  at: number;
  note: string;
}
export interface WalletGroup {
  kind: GroupKind;
  wallets: string[]; // addresses (normalised) that may share an owner
  via: string | null; // the funder or deposit address that links them
  statement: string; // plain-language evidence line, always hedged
  evidence: GroupEvidence[];
}
export interface GroupOpts {
  funderWindowMs: number; // wallets first funded by the same wallet within this window of each other
  roundTripMs: number; // A -> B and B -> A within this time
  maxGroups: number;
  maxEvidence: number;
}
export const GROUP_DEFAULTS: GroupOpts = { funderWindowMs: 24 * 3600_000, roundTripMs: 72 * 3600_000, maxGroups: 50, maxEvidence: 12 };
export const GROUP_NOTE = 'Heuristics only: these are signals of possible common ownership, not proof. Confirm with the account holder records before relying on them.';

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const ev = (t: Transfer, chain: string, note: string): GroupEvidence => ({ hash: t.hash, chain, from: norm(t.from), to: norm(t.to), amount: t.amount, at: t.timestamp, note });

export interface GroupInput {
  chain: string;
  histories: Map<string, Transfer[]>; // address (normalised) -> its transfers
  isDeposit: (addr: string) => boolean; // labelled exchange_deposit
  isService: (addr: string) => boolean; // exchange / service / bridge / dex / exchange_deposit / service-scale: never a "common funder"
}

/** A wallet's earliest incoming transfer (the funding transaction), if its history holds one. */
function firstIn(addr: string, trs: Transfer[]): Transfer | null {
  let f: Transfer | null = null;
  for (const t of trs) if (norm(t.to) === addr && norm(t.from) !== addr && (!f || t.timestamp < f.timestamp)) f = t;
  return f;
}

export function groupWallets(inp: GroupInput, o: Partial<GroupOpts> = {}): WalletGroup[] {
  const opt = { ...GROUP_DEFAULTS, ...o };
  const out: WalletGroup[] = [];
  const addrs = [...inp.histories.keys()];

  // 1. common funder: the same wallet was the first payer of several wallets, within a short window
  const byFunder = new Map<string, { w: string; t: Transfer }[]>();
  for (const a of addrs) {
    const f = firstIn(a, inp.histories.get(a)!);
    if (!f || inp.isService(norm(f.from))) continue;
    byFunder.set(norm(f.from), [...(byFunder.get(norm(f.from)) ?? []), { w: a, t: f }]);
  }
  for (const [funder, list] of byFunder) {
    const sorted = [...list].sort((x, y) => x.t.timestamp - y.t.timestamp);
    let run: typeof sorted = [];
    const flush = () => {
      if (run.length >= 2)
        out.push({
          kind: 'common_funder', wallets: run.map((x) => x.w), via: funder,
          statement: `${run.length} wallets were first funded by the same wallet ${short(funder)} within ${Math.round(opt.funderWindowMs / 3600_000)} h of each other. Possibly the same owner (a funder that pays several new wallets is often their operator, but it can also be a service or a person paying several people).`,
          evidence: run.slice(0, opt.maxEvidence).map((x) => ev(x.t, inp.chain, `first incoming transfer of ${short(x.w)}`)),
        });
      run = [];
    };
    for (const x of sorted) {
      if (run.length && x.t.timestamp - run[run.length - 1].t.timestamp > opt.funderWindowMs) flush();
      run.push(x);
    }
    flush();
  }

  // 2. shared deposit address: several wallets pay the same exchange customer account
  const byDeposit = new Map<string, Map<string, Transfer>>();
  for (const a of addrs)
    for (const t of inp.histories.get(a)!) {
      const to = norm(t.to);
      if (norm(t.from) !== a || to === a || !inp.isDeposit(to)) continue;
      const m = byDeposit.get(to) ?? new Map<string, Transfer>();
      if (!m.has(a)) m.set(a, t);
      byDeposit.set(to, m);
    }
  for (const [dep, m] of byDeposit)
    if (m.size >= 2)
      out.push({
        kind: 'shared_deposit', wallets: [...m.keys()], via: dep,
        statement: `${m.size} wallets paid the same exchange customer deposit address ${short(dep)}. A deposit address belongs to one exchange account, so these wallets fed one account: possibly the same owner (or one account holder being paid by several people).`,
        evidence: [...m].slice(0, opt.maxEvidence).map(([w, t]) => ev(t, inp.chain, `${short(w)} paid the deposit address`)),
      });

  // 3. round trip: A -> B and then B -> A within the window
  const seen = new Set<string>();
  for (const a of addrs)
    for (const t of inp.histories.get(a)!) {
      const b = norm(t.to);
      if (norm(t.from) !== a || b === a || inp.isService(b) || inp.isService(a)) continue;
      const pair = [a, b].sort().join('|');
      if (seen.has(pair)) continue;
      const back = (inp.histories.get(b) ?? inp.histories.get(a)!).find((r) => norm(r.from) === b && norm(r.to) === a && r.timestamp >= t.timestamp && r.timestamp - t.timestamp <= opt.roundTripMs);
      if (!back) continue;
      seen.add(pair);
      out.push({
        kind: 'round_trip', wallets: [a, b], via: null,
        statement: `${short(a)} sent funds to ${short(b)} and ${short(b)} sent funds back within ${Math.round((back.timestamp - t.timestamp) / 3600_000)} h. Possibly the same owner moving funds between their own wallets (it can also be a refund or a swap between two parties).`,
        evidence: [ev(t, inp.chain, 'outgoing leg'), ev(back, inp.chain, 'return leg')],
      });
    }
  return out.slice(0, opt.maxGroups);
}

const GROUP_TITLE = { common_funder: 'Wallets funded by the same wallet', shared_deposit: 'Wallets paying the same exchange customer account', round_trip: 'Funds went out and came back' } as const;
/** Groups as case-analysis findings (low severity: signals, not facts). */
export function groupFindings(groups: WalletGroup[]) {
  return groups.map((g) => ({
    type: 'possible_same_owner',
    severity: 'low' as const,
    title: `Possibly same owner: ${GROUP_TITLE[g.kind]}`,
    statement: `${g.statement} ${GROUP_NOTE}`,
    evidence: g.evidence.map((e) => ({ kind: 'tx' as const, chain: e.chain, hash: e.hash, address: e.to, amount: e.amount, at: e.at, note: e.note })),
    evidenceTotal: g.evidence.length,
  }));
}
