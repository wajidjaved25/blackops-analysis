'use client';
import Link from 'next/link';
import { addrHref, catColor, Level, short } from '@/lib/format';
import { Badge, CopyButton } from './ui';

export const LEVEL_COLOR: Record<string, string> = { severe: 'var(--severe)', high: 'var(--high)', medium: 'var(--medium)', low: 'var(--low)' };
export const levelOf = (score: number): Level => (score >= 75 ? 'severe' : score >= 40 ? 'high' : score >= 15 ? 'medium' : 'low');

export function RiskBadge({ level, score }: { level: string; score?: number }) {
  const l = (level || 'low') as Level;
  return <Badge tone={l}><span className="dot" style={{ background: LEVEL_COLOR[l] }} aria-hidden />{l.charAt(0).toUpperCase() + l.slice(1)}{score !== undefined && ` · ${score}`}</Badge>;
}

export function RiskGauge({ score, level }: { score: number; level: string }) {
  const r = 64, c = Math.PI * r, p = Math.max(0, Math.min(100, score)) / 100;
  const col = LEVEL_COLOR[level] ?? LEVEL_COLOR.low;
  return (
    <div className="gauge" role="img" aria-label={`Risk score ${score} of 100, ${level}`}>
      <svg viewBox="0 0 150 86" width="150" height="86" aria-hidden>
        <path d="M11 78 A64 64 0 0 1 139 78" fill="none" stroke="var(--surface-3)" strokeWidth="12" strokeLinecap="round" />
        <path d="M11 78 A64 64 0 0 1 139 78" fill="none" stroke={col} strokeWidth="12" strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} />
      </svg>
      <div className="gv" style={{ color: col }}>{score}</div>
    </div>
  );
}

export function CategoryChip({ category, name }: { category?: string | null; name?: string }) {
  if (!category && !name) return null;
  return <span className="chip" style={{ ['--c' as string]: catColor(category) }} title={category ?? undefined}>{name ?? category}{name && category && <span style={{ opacity: .7, fontWeight: 500 }}>· {category}</span>}</span>;
}

export function AddressLink({ address, label, full, href, noCopy, chain }: { address: string; label?: { name: string; category: string } | null; full?: boolean; href?: string; noCopy?: boolean; chain?: string }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="addr">
        <Link href={href ?? addrHref(address, chain)} title={address}>{full ? address : short(address)}</Link>
        {!noCopy && <CopyButton value={address} label="Copy address" />}
      </span>
      {label && <CategoryChip category={label.category} name={label.name} />}
    </span>
  );
}

export function TxLink({ hash, chain }: { hash: string; chain: string }) {
  return (
    <span className="addr">
      <Link href={`/tx/${chain}/${hash}`} title={hash}>{short(hash)}</Link>
      <CopyButton value={hash} label="Copy hash" />
    </span>
  );
}

export const CATEGORY_LEGEND: [string, string][] = [
  ['Sanctioned / frozen / terror / ransomware / darknet', '#ef4444'], ['Scam / fraud', '#f43f5e'], ['Mixer', '#f97316'], ['Gambling', '#f59e0b'],
  ['Exchange / service', '#14b8a6'], ['Bridge', '#0ea5e9'], ['DEX', '#6366f1'], ['Other label', '#8b5cf6'], ['Unlabelled', '#8b94a7'],
];
export function CategoryLegend() {
  return <div className="legend" aria-label="Category colours">{CATEGORY_LEGEND.map(([n, c]) => <span key={n}><i className="dot" style={{ background: c }} />{n}</span>)}</div>;
}
