// Phase 10A: pure parsers for the exchange address lists (no network, no DB) so selfcheck can assert them on synthetic samples.
// Every parser yields candidate rows; exchange-lists.ts validates each one again (address format, Tron checksum) before storing.
import { Chain } from './chains';
import { mapExplorerTag, validTron } from './exchange-labels';

export type RowKind = 'hot' | 'deposit' | 'controlled';
export interface ExRow {
  chain: Chain;
  address: string;
  kind: RowKind;
  exchange?: string; // only for datasets that name the exchange per row (community lists)
}

const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
export const EVM_ANY = /0x[0-9a-fA-F]{40}/;
export const TRON_ANY = /T[1-9A-HJ-NP-Za-km-z]{33}/;

/** Row for an address string found in a published list: Tron needs a valid checksum, 0x goes on `evmChain` (BNB Chain lookups also read Ethereum rows). */
export function addrRow(raw: string, kind: RowKind, evmChain: Chain = 'eth'): ExRow | null {
  const a = raw.trim();
  if (TRON_RE.test(a)) return validTron(a) ? { chain: 'tron', address: a, kind } : null;
  if (EVM_RE.test(a)) return { chain: evmChain, address: a.toLowerCase(), kind };
  return null;
}

/** Hacken proof-of-reserves audit PDFs (Bybit, KuCoin), text form: lines "<Network>\t<address>". Only Ethereum / BSC / Tron networks are read; other chains are skipped. */
const HACKEN_NET: Record<string, Chain> = { ethereum: 'eth', bsc: 'bsc', 'bnb smart chain': 'bsc', 'bnb chain': 'bsc', tron: 'tron' };
const HACKEN_LINE = /^\s*([A-Za-z][A-Za-z0-9 ().-]*?)\s+(0x[0-9a-fA-F]{40}|T[1-9A-HJ-NP-Za-km-z]{33})\s*$/;
export function parseHackenText(text: string): ExRow[] {
  const out: ExRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = HACKEN_LINE.exec(line);
    const chain = m && HACKEN_NET[m[1].trim().toLowerCase()];
    if (!m || !chain) continue;
    const r = addrRow(m[2], 'hot', chain === 'tron' ? 'eth' : chain);
    if (r && (chain === 'tron') === (r.chain === 'tron')) out.push(r);
  }
  return out;
}

/** OKX por_csv: a coin/amount table first, then a header "coin,Type,Network,Snapshot Height,address,..." followed by one row per address. Network TRON / ETH / BSC are kept. */
const OKX_NET: Record<string, Chain> = { TRON: 'tron', ETH: 'eth', BSC: 'bsc' };
export function okxParser() {
  let cols: { net: number; addr: number } | null = null;
  return (line: string): ExRow | null => {
    if (!cols) {
      if (line.startsWith('coin,Type,Network')) {
        const h = line.split(',');
        cols = { net: h.indexOf('Network'), addr: h.indexOf('address') };
        if (cols.addr < 0) cols = null;
      }
      return null;
    }
    const f = line.split(',');
    const chain = OKX_NET[f[cols.net]];
    if (!chain) return null;
    const r = addrRow(f[cols.addr] ?? '', 'controlled', chain === 'tron' ? 'eth' : chain);
    return r && (chain === 'tron') === (r.chain === 'tron') ? r : null;
  };
}

/** MEXC daily CSV (BOM, header "asset,chain,address,balance" in Chinese): the address column is read by pattern, every 0x address goes on Ethereum. One address repeats per asset (deduped by the loader). */
export function parseMexcLine(line: string): ExRow | null {
  const f = line.replace(/^﻿/, '').split(',');
  return f.length >= 3 ? addrRow(f[2], 'hot') : null;
}

/** dawsbot/eth-labels accounts.csv: `"address",chainId,"label","nameTag"`. Community-scraped Etherscan/BscScan labels. */
const DAWS_LINE = /^"(0x[0-9a-fA-F]{40})",(\d+),"((?:[^"]|"")*)","((?:[^"]|"")*)"\s*$/;
// Etherscan label slug -> exchange. bitget / bilaxy / deribit are deliberately absent: thousands of deposit-address spam rows.
export const COMMUNITY_SLUGS: Record<string, string> = {
  coinbase: 'Coinbase', kraken: 'Kraken', bitfinex: 'Bitfinex', bithumb: 'Bithumb', okx: 'OKX', kucoin: 'KuCoin', poloniex: 'Poloniex',
  'crypto-com': 'Crypto.com', mexc: 'MEXC', gemini: 'Gemini', upbit: 'Upbit', 'gate-io': 'Gate', bitstamp: 'Bitstamp', bittrex: 'Bittrex',
};
export function parseCommunityLine(line: string): ExRow | null {
  const m = DAWS_LINE.exec(line);
  if (!m) return null;
  const [, address, chainId, label, tag] = m;
  if (chainId === '1') {
    const exchange = COMMUNITY_SLUGS[label];
    return exchange ? { chain: 'eth', address: address.toLowerCase(), kind: 'hot', exchange } : null;
  }
  if (chainId === '56' && label === 'exchange') {
    const t = mapExplorerTag(tag.replace(/""/g, '"'));
    const exchange = t.exchange ?? tag.split(/[:\d]/)[0].trim().slice(0, 40);
    return exchange ? { chain: 'bsc', address: address.toLowerCase(), kind: 'hot', exchange } : null;
  }
  return null;
}

/** Display text for a stored row: hot -> exchange wallet, deposit / controlled -> customer deposit address (exchange_deposit). */
export function rowLabel(exchange: string, kind: string, listName: string): { name: string; category: 'exchange' | 'exchange_deposit' } {
  return kind === 'hot'
    ? { name: `${exchange} hot/cold wallet (${listName})`, category: 'exchange' }
    : { name: `${exchange} customer deposit address (${listName})`, category: 'exchange_deposit' };
}
