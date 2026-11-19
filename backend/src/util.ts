import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Chain, detectChain, norm } from './chains';

export function parseAddr(raw: unknown): { chain: Chain; addr: string } {
  const v = typeof raw === 'string' ? raw.trim() : '';
  const chain = detectChain(v);
  if (!chain) throw new BadRequestException(`Not a valid Tron (T…) or Ethereum (0x…) address: "${String(raw ?? '').slice(0, 80)}"`);
  return { chain, addr: norm(v) };
}

export function int(raw: unknown, def: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new BadRequestException(`Expected an integer, got "${String(raw)}"`);
  return Math.min(max, Math.max(min, n));
}

export function str(raw: unknown, field: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string {
  if ((raw === undefined || raw === null || raw === '') && opts.optional) return '';
  if (typeof raw !== 'string') throw new BadRequestException(`${field} is required`);
  const v = raw.trim();
  if (v.length < (opts.min ?? 1)) throw new BadRequestException(`${field} is required`);
  if (v.length > (opts.max ?? 500)) throw new BadRequestException(`${field} is too long (max ${opts.max ?? 500})`);
  return v;
}

export function oneOf<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T {
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}`);
  return raw as T;
}

export function id(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException('Invalid id');
  return n;
}

export function found<T>(v: T | null | undefined, what = 'Not found'): T {
  if (!v) throw new NotFoundException(what);
  return v;
}

/** RFC 4180-ish CSV parser: commas, quoted fields, "" escapes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Quote every cell; neutralise spreadsheet formula injection (=, +, -, @ at start). */
export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Pull addresses out of a JSON list or free text / CSV (first column, or any cell that looks like an address). */
export function extractAddresses(input: { addresses?: unknown; csv?: unknown }, max: number): { chain: Chain; addr: string }[] {
  const raw: string[] = Array.isArray(input.addresses)
    ? input.addresses.map(String)
    : typeof input.csv === 'string'
      ? parseCsv(input.csv).flatMap((r) => r.map((c) => c.trim()).filter((c) => detectChain(c)))
      : [];
  const seen = new Set<string>();
  const out: { chain: Chain; addr: string }[] = [];
  for (const r of raw) {
    const a = parseAddr(r);
    const k = a.chain + a.addr;
    if (!seen.has(k)) seen.add(k), out.push(a);
  }
  if (!out.length) throw new BadRequestException('No valid addresses found');
  if (out.length > max) throw new BadRequestException(`Too many addresses (${out.length}); max ${max} per request`);
  return out;
}
