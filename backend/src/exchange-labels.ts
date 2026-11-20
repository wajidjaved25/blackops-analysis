// Phase 8C: automatic exchange / service labels. Pure helpers (parsers, mappings, thresholds) live here so selfcheck can assert them.
import { Chain, detectChain, hexToTron, norm, tronToHex20 } from './chains';

/**
 * 8.14 official proof-of-reserves wallet lists. Rule 5: an entry exists only if the list was fetched and parsed in a
 * session and its exact URL is recorded here. On 2026-11-20 no exchange's list could be fetched legitimately
 * (Binance/OKX pages are script-rendered or blocked, Bybit/KuCoin/Gate/HTX pages carry no address data, Bitget's
 * address API needs undocumented parameters, bitgetlimited/proof-of-reserves holds only a Merkle tree), so this is empty.
 * To add one: `{ exchange: 'Binance', url: '<exact URL of the CSV/JSON/text file>' }`; the weekly sync does the rest.
 */
export interface PorSource {
  exchange: string;
  url: string;
}
export const POR_SOURCES: PorSource[] = [];

export const POR_MAX_BYTES = 20_000_000;
export const POR_MAX_ADDRESSES = 200_000; // per list: a larger file is truncated, never trusted blindly
export const porName = (exchange: string) => `${exchange} (proof-of-reserves wallet)`;

const TOKEN = /\b(?:T[1-9A-HJ-NP-Za-km-z]{33}|0x[0-9a-fA-F]{40})\b/g;
/** Tron addresses must also pass the base58check checksum (hexToTron re-encodes it). */
const validTron = (a: string) => {
  try {
    return hexToTron(tronToHex20(a)) === a;
  } catch {
    return false;
  }
};

/**
 * Format-agnostic parser for a published wallet list (CSV, JSON, plain text, one address per cell/line):
 * pulls out every Tron / 0x token, validates it with chains.ts (+ Tron checksum) and dedupes. A 0x address is stored on
 * Ethereum; BNB Chain lookups already read Ethereum-keyed non-issuer labels (labels.ts lookup).
 * Anything else in the file (balances, tx hashes, other chains' addresses) is ignored; 64-hex hashes never match.
 */
export function parsePorList(text: string, cap = POR_MAX_ADDRESSES): { chain: Chain; address: string }[] {
  const out = new Map<string, Chain>();
  for (const m of text.matchAll(TOKEN)) {
    const chain = detectChain(m[0]);
    if (!chain || (chain === 'tron' && !validTron(m[0]))) continue;
    out.set(norm(m[0]), chain);
    if (out.size >= cap) break;
  }
  return [...out].map(([address, chain]) => ({ chain, address }));
}

/** Small allowlist of exchanges that Tronscan tags may be mapped to `exchange` (matched at the start of the tag). */
const KNOWN_EXCHANGES: [RegExp, string][] = [
  [/^binance/i, 'Binance'],
  [/^okx|^okex/i, 'OKX'],
  [/^bybit/i, 'Bybit'],
  [/^kucoin/i, 'KuCoin'],
  [/^bitget/i, 'Bitget'],
  [/^htx|^huobi/i, 'HTX'],
  [/^gate(\.io|\b)/i, 'Gate'],
  [/^kraken/i, 'Kraken'],
  [/^coinbase/i, 'Coinbase'],
  [/^bitfinex/i, 'Bitfinex'],
  [/^crypto\.com/i, 'Crypto.com'],
  [/^mexc/i, 'MEXC'],
  [/^bitstamp/i, 'Bitstamp'],
  [/^poloniex/i, 'Poloniex'],
];

/**
 * 8.15 tag -> label. The tag text is kept verbatim as the name. `exchange` only when it names an allowlisted exchange;
 * a Tronscan red tag (flagged address) is `other` (weight 20) so it is not silently weighted 0; everything else `service` (weight 0).
 */
export function mapExplorerTag(tag: string, red = false): { name: string; category: 'exchange' | 'service' | 'other'; exchange?: string } {
  const name = tag.trim().slice(0, 200);
  const hit = KNOWN_EXCHANGES.find(([re]) => re.test(name));
  if (hit && !red) return { name, category: 'exchange', exchange: hit[1] };
  return { name, category: red ? 'other' : 'service' };
}

/** First usable tag of a Tronscan accountv2 response: addressTag (public label), then publicTag, blueTag; redTag marks a flagged address. */
export function pickTronscanTag(j: any): { tag: string; red: boolean } | null {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const red = s(j?.redTag);
  if (red) return { tag: red, red: true };
  const tag = s(j?.addressTag) || s(j?.publicTag) || s(j?.blueTag);
  return tag ? { tag, red: false } : null;
}

/** 8.17: indexed wallets with at least this many stored transfers are treated as service-scale even before they hit the cap. */
export const SERVICE_SCALE_ROWS = 20_000;
/** "likely exchange/service (heuristic)": index status `capped`, or service-scale activity. Never a name, never risk-weighted. */
export const isServiceScale = (cov: { status: string; rowCount: number } | null | undefined) => !!cov && (cov.status === 'capped' || cov.rowCount >= SERVICE_SCALE_ROWS);
