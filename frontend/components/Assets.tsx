'use client';
import { ASSET_COLOR, Asset, AssetFilter, assetSym, Chain, isEvmAddr } from '@/lib/format';
import { Segmented } from './ui';

export const ASSET_OPTIONS: { id: AssetFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'usdt', label: 'USDT' }, { id: 'usdc', label: 'USDC' }];

/** Asset filter chips (All / USDT / USDC): the server filters, so changing it refetches. */
export function AssetChips({ value, onChange, label = 'Asset' }: { value: AssetFilter; onChange: (v: AssetFilter) => void; label?: string }) {
  return <Segmented label={label} value={value} onChange={onChange} options={ASSET_OPTIONS} />;
}

/** Ethereum or BNB Chain: only shown for 0x input, since a 0x address exists on both. Tron addresses need no choice. */
export function ChainChoice({ addr, value, onChange }: { addr: string; value: Chain; onChange: (c: 'eth' | 'bsc') => void }) {
  if (!isEvmAddr(addr.trim())) return null;
  return <Segmented label="Chain" value={value === 'bsc' ? 'bsc' : 'eth'} onChange={onChange} options={[{ id: 'eth', label: 'Ethereum' }, { id: 'bsc', label: 'BNB Chain' }]} />;
}

export function AssetTag({ asset }: { asset?: string | null }) {
  const a = (asset ?? 'usdt') as Asset;
  return <span className="chip" style={{ ['--c' as string]: ASSET_COLOR[a] ?? '#8b94a7' }}>{assetSym(a)}</span>;
}
