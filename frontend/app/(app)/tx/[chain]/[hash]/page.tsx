'use client';
import { ArrowRight, CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { AssetTag } from '@/components/Assets';
import { RequirePerm } from '@/components/Guard';
import { AddressLink } from '@/components/Risk';
import { Badge, Card, CopyButton, DateTime, EmptyState, ErrorState, Notice, PageHeader, Segmented, SkeletonRows } from '@/components/ui';
import { Chain, chainName, explorerTx, money } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Tx { chain: Chain; hash: string; block: number; timestamp: number; success: boolean; transfers: { from: string; to: string; amount: number; asset: 'usdt' | 'usdc' }[] }

export default function TxPage() {
  const { chain, hash } = useParams<{ chain: string; hash: string }>();
  const router = useRouter();
  const ok = chain === 'tron' || chain === 'eth' || chain === 'bsc';
  const { data: t, loading, error, status, reload } = useApi<Tx>(ok ? `/tx/${chain}/${hash}` : null);
  return (
    <RequirePerm perm="investigate.view">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader crumbs={[{ label: 'Investigate', href: '/graph' }, { label: 'Transaction' }]} title={<span className="row" style={{ gap: 10 }}>Transaction {t && <Badge tone="outline">{chainName(t.chain)}</Badge>}{t && (t.success ? <Badge tone="good"><CheckCircle2 size={13} />Success</Badge> : <Badge tone="severe"><XCircle size={13} />Failed</Badge>)}</span>}
          sub={<span className="row nw" style={{ gap: 6 }}><code className="break">{hash}</code><CopyButton value={hash} label="Copy hash" />{ok && <a href={explorerTx(chain as Chain, hash)} target="_blank" rel="noreferrer" aria-label="Open in block explorer"><ExternalLink size={14} /></a>}</span>} />
        {!ok && <ErrorState error="Chain must be tron, eth or bsc." />}
        {ok && chain !== 'tron' && <Segmented label="Chain" value={chain as 'eth' | 'bsc'} onChange={(c) => router.replace(`/tx/${c}/${hash}`)} options={[{ id: 'eth', label: 'Ethereum' }, { id: 'bsc', label: 'BNB Chain' }]} />}
        {loading && <div className="card"><SkeletonRows rows={4} /></div>}
        {error && <div className="card"><ErrorState error={error} status={status} onRetry={reload} /></div>}
        {t && (
          <>
            <div className="card card-b"><dl className="kv"><dt>Block</dt><dd className="mono">{t.block?.toLocaleString()}</dd><dt>Time</dt><dd><DateTime t={t.timestamp} /></dd><dt>USDT / USDC transfers</dt><dd>{t.transfers.length}</dd></dl></div>
            <Card title="Transfers" flush>
              {t.transfers.length === 0 ? <EmptyState title="No USDT or USDC transfers">This transaction did not move USDT or USDC.</EmptyState> : (
                <div className="stack sm" style={{ padding: 8 }}>
                  {t.transfers.map((x, i) => (
                    <div key={i} className="row" style={{ padding: '10px 12px', gap: 14, borderBottom: '1px solid var(--border)' }}>
                      <AddressLink address={x.from} chain={t.chain} /><ArrowRight size={15} className="muted" aria-label="to" /><AddressLink address={x.to} chain={t.chain} />
                      <span className="end row" style={{ gap: 8 }}><AssetTag asset={x.asset} /><strong className="num">{money(x.amount, x.asset)}</strong></span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            {!t.success && <Notice tone="warn">This transaction failed on-chain; no funds moved.</Notice>}
          </>
        )}
      </div>
    </RequirePerm>
  );
}
