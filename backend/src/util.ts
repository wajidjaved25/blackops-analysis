import { BadRequestException, NotFoundException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
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

export function privateIp(ip: string): boolean {
  if (isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateIp(mapped[1]) : l === '::1' || l === '::' || /^f[cd]/.test(l) || l.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * SSRF guard for URLs users give us (webhooks, label import): http(s) only, and the host must not resolve to a
 * private/loopback address. ALLOW_PRIVATE_URLS=true switches this off (local development only).
 * ponytail: resolves once here and fetch resolves again, so DNS rebinding is not covered; pin the IP if that matters.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadRequestException('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BadRequestException('URL must start with http:// or https://');
  if (process.env.ALLOW_PRIVATE_URLS === 'true') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs: { address: string }[];
  try {
    addrs = isIPv4(host) || isIPv6(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw new BadRequestException(`Cannot resolve host "${host}"`);
  }
  if (addrs.some((a) => privateIp(a.address))) throw new BadRequestException('URL points to a private or local address, which is not allowed');
  return u;
}
