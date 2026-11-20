// Asset registry (Phase 7B): every stablecoin contract we trace. Pure data + helpers, no I/O — covered by selfcheck.ts.
// Each entry below was verified live (symbol() and decimals() via TronGrid / public RPC) on 2026-11-20.

export type Chain = 'tron' | 'eth' | 'bsc';
export type Asset = 'usdt' | 'usdc';
export type AssetFilter = Asset | 'all';
export const CHAINS: readonly Chain[] = ['tron', 'eth', 'bsc'];
export const ASSETS: readonly Asset[] = ['usdt', 'usdc'];

/** Who can freeze a wallet for this token. null = nobody (BSC pegged tokens are bridge-issued, no issuer blacklist). */
export type Issuer = 'tether' | 'circle' | null;

export interface AssetDef {
  chain: Chain;
  asset: Asset;
  symbol: string;
  /** Tron: base58. EVM: lowercase 0x. */
  contract: string;
  decimals: number;
  issuer: Issuer;
  /** Shown in the UI next to the asset. */
  note?: string;
}

export const REGISTRY: readonly AssetDef[] = [
  { chain: 'tron', asset: 'usdt', symbol: 'USDT', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, issuer: 'tether' },
  { chain: 'tron', asset: 'usdc', symbol: 'USDC', contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', decimals: 6, issuer: 'circle', note: 'Circle no longer supports USDC on Tron (since 2024); tokens still move but Circle does not mint or redeem them' },
  { chain: 'eth', asset: 'usdt', symbol: 'USDT', contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, issuer: 'tether' },
  { chain: 'eth', asset: 'usdc', symbol: 'USDC', contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, issuer: 'circle' },
  { chain: 'bsc', asset: 'usdt', symbol: 'USDT', contract: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, issuer: null },
  { chain: 'bsc', asset: 'usdc', symbol: 'USDC', contract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18, issuer: null },
];

export const assetDef = (chain: Chain, asset: Asset): AssetDef => REGISTRY.find((d) => d.chain === chain && d.asset === asset)!;
export const assetsOf = (chain: Chain): AssetDef[] => REGISTRY.filter((d) => d.chain === chain);
/** Registry entries on `chain` that match the filter (`all` = every asset). */
export const selectAssets = (chain: Chain, filter: AssetFilter = 'all'): AssetDef[] => assetsOf(chain).filter((d) => filter === 'all' || d.asset === filter);
/** Reverse lookup for log parsing: which tracked asset lives at this contract (case-insensitive for EVM). */
export const assetByContract = (chain: Chain, contract: string): AssetDef | undefined => {
  const c = chain === 'tron' ? contract : contract.toLowerCase();
  return assetsOf(chain).find((d) => d.contract === c);
};
export const isAsset = (v: unknown): v is Asset => ASSETS.includes(v as Asset);

/**
 * Raw on-chain integer -> token units as a JS number, without precision loss in the integer part
 * (18-decimal tokens: Number(raw) / 1e18 loses digits once raw > 2^53 ≈ 9e15, i.e. any balance above ~0.009 tokens).
 */
export function parseUnits(raw: string | bigint, decimals: number): number {
  const v = typeof raw === 'bigint' ? raw : BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  return Number(whole) + Number(frac) / Number(base);
}

// Issuer freeze ABI. Selectors/topics are keccak256 of the signature, verified against TronGrid
// (function_selector / event_name lookups) and, for Tether, against the constants that were already live.
export const TETHER = {
  isFrozen: '0xe47d6060', // isBlackListed(address)
  added: '42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc', // AddedBlackList(address)
  removed: 'd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c', // RemovedBlackList(address)
};
export const CIRCLE = {
  isFrozen: '0xfe575a87', // isBlacklisted(address)
  added: 'ffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855', // Blacklisted(address indexed _account)
  removed: '117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e', // UnBlacklisted(address indexed _account)
};
export const freezeAbi = (issuer: 'tether' | 'circle') => (issuer === 'tether' ? TETHER : CIRCLE);
export const issuerName = { tether: 'Tether', circle: 'Circle' } as const;

/** Canonical csv of every asset registered for a chain, in registry order: what a fully indexed wallet stores in IndexedAddress.assets. */
export const assetsCsv = (chain: Chain) => assetsOf(chain).map((d) => d.asset).join(',');
