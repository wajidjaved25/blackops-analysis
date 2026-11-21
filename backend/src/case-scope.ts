// Scope of a case analysis (Phase 10B): which of the case's transactions a run looks at. Applied before totals, the wallet table, trace seeds and pattern rules.
import { BadRequestException, ConflictException } from '@nestjs/common';
import { norm } from './chains';
import { detectFormat } from './statements';
import { id, oneOf, str } from './util';

export const MAX_SELECTED = 5000;
export const SCOPE_STATUSES = ['verified', 'mismatch', 'not_found', 'off_chain', 'pending', 'error'] as const;
const CHAINS = ['tron', 'eth', 'bsc'] as const;
const DIRECTIONS = ['withdrawal', 'deposit'] as const;

export interface Scope {
  mode: 'all' | 'selected';
  transactionIds?: number[]; // selected mode only
  from?: string; // ISO instants; the row time is the statement time, else the on-chain time
  to?: string;
  tzMin?: number; // offset the dates were chosen in (minutes east of UTC); display only
  statuses?: string[];
  chains?: string[];
  assets?: string[]; // upper case
  fileIds?: number[]; // imported statement files (CaseFile ids)
  pasted?: boolean; // rows added by pasting hashes (investigate-this-transaction rows are stored the same way)
  wallets?: string[]; // recipient wallets
  minAmount?: number;
  maxAmount?: number;
  direction?: (typeof DIRECTIONS)[number]; // only rows from a recognised Binance statement have one
}

/** The fields of a CaseTransaction that scoping reads. */
export interface ScopeTx {
  id: number; chain: string | null; status: string; coin: string | null; onAsset: string | null; amount: number | null; onAmount: number | null;
  claimedAt: Date | null; onAt: Date | null; address: string | null; onTo: string | null; fileId: number | null; source: string; raw?: unknown;
}

const list = (raw: unknown, field: string, max: number): unknown[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException(`${field} must be a list`);
  if (raw.length > max) throw new BadRequestException(`${field}: at most ${max} entries`);
  return raw;
};
const amount = (raw: unknown, field: string) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`${field} must be a number of 0 or more`);
  return n;
};
const instant = (raw: unknown, field: string) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (Number.isNaN(t)) throw new BadRequestException(`${field} must be an ISO date-time`);
  return new Date(t).toISOString();
};

/** Request value -> validated Scope, or null when it selects everything. Throws 400 on anything malformed. */
export function parseScope(raw: unknown): Scope | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('scope must be an object');
  const b = raw as Record<string, unknown>;
  const mode = oneOf(b.mode ?? 'all', 'scope.mode', ['all', 'selected'] as const);
  const s: Scope = { mode };
  const ids = list(b.transactionIds, 'scope.transactionIds', MAX_SELECTED).map(id);
  const statuses = list(b.statuses, 'scope.statuses', 10).map((x) => oneOf(x, 'scope.statuses', SCOPE_STATUSES));
  const chains = list(b.chains, 'scope.chains', 3).map((x) => oneOf(x, 'scope.chains', CHAINS));
  const assets = list(b.assets, 'scope.assets', 20).map((x) => {
    const v = String(x).toUpperCase();
    if (!/^[A-Z0-9]{1,20}$/.test(v)) throw new BadRequestException(`scope.assets: "${String(x).slice(0, 30)}" is not an asset symbol`);
    return v;
  });
  const fileIds = list(b.fileIds, 'scope.fileIds', 200).map(id);
  const wallets = list(b.wallets, 'scope.wallets', 500).map((x) => {
    if (typeof x !== 'string' || !x.trim() || x.length > 100) throw new BadRequestException('scope.wallets must be wallet addresses');
    return norm(x.trim());
  });
  if (statuses.length) s.statuses = [...new Set(statuses)];
  if (chains.length) s.chains = [...new Set(chains)];
  if (assets.length) s.assets = [...new Set(assets)];
  if (fileIds.length) s.fileIds = [...new Set(fileIds)];
  if (b.pasted !== undefined && typeof b.pasted !== 'boolean') throw new BadRequestException('scope.pasted must be true or false');
  if (b.pasted) s.pasted = true;
  if (wallets.length) s.wallets = [...new Set(wallets)];
  const from = instant(b.from, 'scope.from'), to = instant(b.to, 'scope.to');
  if (from) s.from = from;
  if (to) s.to = to;
  if (from && to && from > to) throw new BadRequestException('scope.from is after scope.to');
  const min = amount(b.minAmount, 'scope.minAmount'), max = amount(b.maxAmount, 'scope.maxAmount');
  if (min !== undefined) s.minAmount = min;
  if (max !== undefined) s.maxAmount = max;
  if (min !== undefined && max !== undefined && min > max) throw new BadRequestException('scope.minAmount is above scope.maxAmount');
  if (b.direction !== undefined && b.direction !== null && b.direction !== '') s.direction = oneOf(b.direction, 'scope.direction', DIRECTIONS);
  if (b.tzMin !== undefined && b.tzMin !== null && b.tzMin !== '') {
    const z = Number(b.tzMin);
    if (!Number.isInteger(z) || z < -720 || z > 840) throw new BadRequestException('scope.tzMin must be minutes between -720 and 840');
    s.tzMin = z;
  }
  const filtered = Object.keys(s).some((k) => !['mode', 'tzMin'].includes(k));
  if (mode === 'selected') {
    if (!ids.length) throw new BadRequestException('Select at least one transaction (scope.transactionIds is empty)');
    if (filtered) throw new BadRequestException('A selected-transactions scope cannot be combined with filters');
    return { mode, transactionIds: [...new Set(ids)] };
  }
  if (ids.length) throw new BadRequestException('scope.transactionIds needs mode "selected"');
  return filtered ? s : null;
}

/** Statement direction of one row, where the file's headers identify a Binance withdrawal or deposit history; null otherwise (pasted rows, other formats). */
export function rowDirection(raw: unknown): 'withdrawal' | 'deposit' | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const f = detectFormat(Object.keys(raw)).format;
  return f === 'binance_withdrawal' ? 'withdrawal' : f === 'binance_deposit' ? 'deposit' : null;
}

/** The rows a scope keeps. A filter never matches a row that lacks the field (no time, no chain, no direction). */
export function filterScope<T extends ScopeTx>(txs: T[], s: Scope | null): T[] {
  if (!s) return txs;
  if (s.mode === 'selected') {
    const ids = new Set(s.transactionIds);
    return txs.filter((t) => ids.has(t.id));
  }
  const from = s.from ? Date.parse(s.from) : null, to = s.to ? Date.parse(s.to) : null;
  const statuses = s.statuses && new Set(s.statuses), chains = s.chains && new Set(s.chains), assets = s.assets && new Set(s.assets), files = s.fileIds && new Set(s.fileIds), wallets = s.wallets && new Set(s.wallets);
  const bySource = !!(s.fileIds || s.pasted);
  return txs.filter((t) => {
    if (statuses && !statuses.has(t.status)) return false;
    if (chains && !(t.chain && chains.has(t.chain))) return false;
    if (assets && !assets.has((t.coin ?? t.onAsset ?? 'USDT').toUpperCase())) return false;
    if (bySource && !((t.fileId !== null && files?.has(t.fileId)) || (s.pasted && t.source === 'manual' && t.fileId === null))) return false;
    if (wallets) {
      const w = t.address ?? t.onTo;
      if (!w || !wallets.has(norm(w))) return false;
    }
    const amt = t.amount ?? t.onAmount ?? 0;
    if (s.minAmount !== undefined && amt < s.minAmount) return false;
    if (s.maxAmount !== undefined && amt > s.maxAmount) return false;
    if (from !== null || to !== null) {
      const at = (t.claimedAt ?? t.onAt)?.getTime();
      if (at === undefined || (from !== null && at < from) || (to !== null && at > to)) return false;
    }
    if (s.direction && rowDirection(t.raw) !== s.direction) return false;
    return true;
  });
}

const tzText = (m: number) => `UTC${m < 0 ? '-' : '+'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? ':' + String(Math.abs(m) % 60).padStart(2, '0') : ''}`;
const day = (iso: string, tz: number) => new Date(Date.parse(iso) + tz * 60_000).toISOString().slice(0, 10);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One line for the run picker and the report. */
export function describeScope(s: Scope | null): string {
  if (!s) return 'Scope: all transactions';
  if (s.mode === 'selected') return `Scope: ${plural(s.transactionIds!.length, 'selected transaction')}`;
  const tz = s.tzMin ?? 0;
  const amt = [s.minAmount !== undefined && `≥ ${s.minAmount}`, s.maxAmount !== undefined && `≤ ${s.maxAmount}`].filter(Boolean).join(' and ');
  const parts = [
    s.statuses && `${s.statuses.map((x) => x.replace('_', ' ')).join(' or ')} only`,
    s.chains && s.chains.join(', '),
    s.assets && s.assets.join(', '),
    (s.from || s.to) && `${s.from ? day(s.from, tz) : 'start'} → ${s.to ? day(s.to, tz) : 'now'} (${tzText(tz)})`,
    (s.fileIds || s.pasted) && [s.fileIds && plural(s.fileIds.length, 'statement file'), s.pasted && 'pasted'].filter(Boolean).join(' + '),
    s.wallets && plural(s.wallets.length, 'wallet'),
    amt && `amount ${amt}`,
    s.direction && `${s.direction}s only`,
  ].filter(Boolean);
  return `Scope: ${parts.join(', ')}`;
}

/** Selected ids must all be rows of this case; the message does not say whether an id exists elsewhere. */
export function assertSelectedInCase(ids: number[], caseIds: Set<number>): void {
  const bad = ids.filter((x) => !caseIds.has(x));
  if (bad.length) throw new BadRequestException(`${plural(bad.length, 'selected transaction')} ${bad.length === 1 ? 'does' : 'do'} not belong to this case`);
}

export function assertNotEmpty(inScope: number, total: number): void {
  if (!inScope) throw new BadRequestException(`No transactions match this scope (0 of ${total}). Widen the filters or choose other transactions.`);
}

// ----- saved scopes (Phase 10C) -----
export const SCOPE_NAME_MAX = 80;
export const SCOPE_DESC_MAX = 500;
export const parseScopeName = (raw: unknown) => str(raw, 'name', { max: SCOPE_NAME_MAX });
export const parseScopeDescription = (raw: unknown) => str(raw, 'description', { optional: true, max: SCOPE_DESC_MAX });

/** The scope of a saved scope: the same validation as a run, and "all transactions" is not worth saving. */
export function parseSavedScope(raw: unknown): Scope {
  const s = parseScope(raw);
  if (!s) throw new BadRequestException('Choose at least one filter or some transactions: "all transactions" has nothing to save');
  return s;
}

/** Names are unique per case, compared without regard to case (the database enforces the exact-match case too). */
export function assertNameFree(name: string, others: string[]): void {
  const n = name.trim().toLowerCase();
  if (others.some((o) => o.trim().toLowerCase() === n)) throw new ConflictException(`A saved scope named "${name}" already exists in this case`);
}

/** A run that used a saved scope keeps a COPY of the scope and its name in its params, so later edits or deletion of the saved scope never change it. */
export function applySavedScope<P extends object>(params: P, saved: { id: number; name: string; scope: unknown }) {
  return { ...params, scope: parseScope(JSON.parse(JSON.stringify(saved.scope))) ?? undefined, scopeId: saved.id, scopeName: saved.name };
}

/** Summary line: `describeScope`, with the saved scope's name in front when the run used one. */
export function describeRunScope(s: Scope | null, savedName?: string | null): string {
  return savedName ? `Scope: ${savedName} (saved): ${describeScope(s).replace(/^Scope: /, '')}` : describeScope(s);
}
