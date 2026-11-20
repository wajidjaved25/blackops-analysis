// Labels taken from an official vendor page (source "official"). Rule 5: an address is listed here only if the page was
// fetched and the address quoted from it, and (where the chain allows) it was confirmed to be a deployed contract.
// Every entry carries the page it came from; the label row stores that URL as `sourceUrl`.
// Verified 2026-11-20: each address answered TronGrid /wallet/getcontract with a deployed contract (ABI + origin_address).
export interface OfficialLabel {
  chain: 'tron';
  address: string;
  name: string;
  category: 'dex' | 'bridge';
  url: string;
}

export const OFFICIAL_LABELS: OfficialLabel[] = [
  {
    chain: 'tron',
    address: 'TSJEtPuqHpvSaVnSwvCsngaeBxrGUzp95Q',
    name: 'SunSwap Universal Router',
    category: 'dex',
    url: 'https://sunio.zendesk.com/hc/en-us/articles/54899665032601', // SUN.io help centre: "Universal Router (TRON)"
  },
  {
    chain: 'tron',
    address: 'TWPziSAroSacAjDuL52ByQzU86s9mP2gPr',
    name: 'Allbridge Core USDT OFT interface',
    category: 'bridge',
    url: 'https://docs-core.allbridge.io/llms-full.txt', // Allbridge Core docs, "OFT Interface Contracts" table (USDT, Tron)
  },
];
