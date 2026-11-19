'use client';
import { ArrowRight, CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import { useParams } from 'next/navigation';
import { RequirePerm } from '@/components/Guard';
import { AddressLink } from '@/components/Risk';
import { Badge, Card, CopyButton, DateTime, EmptyState, ErrorState, Notice, PageHeader, SkeletonRows } from '@/components/ui';
import { chainName, explorerTx, usdt } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Tx { chain: 'tron' | 'eth'; hash: string; block: number; timestamp: number; success: boolean; transfers: { from: string; to: string; amount: number }[] }

export default function TxPage() {
  const { chain, hash } = useParams<{ chain: string; hash: string }>();
  const ok = chain === 'tron' || chain === 'eth';
  const { data: t, loading, error, status, reload } = useApi<Tx>(ok ? `/tx/${chain}/${hash}` : null);
  return (
    <RequirePerm perm="investigate.view">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader crumbs={[{ label: 'Investigate', href: '/graph' }, { label: 'Transaction' }]} title={<span className="row" style={{ gap: 10 }}>Transaction {t && <Badge tone="outline">{chainName(t.chain)}</Badge>}{t && (t.success ? <Badge tone="good"><CheckCircle2 size={13} />Success</Badge> : <Badge tone="severe"><XCircle size={13} />Failed</Badge>)}</span>}
          sub={<span className="row nw" style={{ gap: 6 }}><code className="break">{hash}</code><CopyButton value={hash} label="Copy hash" />{ok && <a href={explorerTx(chain as 'tron' | 'eth', hash)} target="_blank" rel="noreferrer" aria-label="Open in block explorer"><ExternalLink size={14} /></a>}</span>} />
        {!ok && <ErrorState error="Chain must be tron or eth." />}
        {loading && <div className="card"><SkeletonRows rows={4} /></div>}
        {error && <div className="card"><ErrorState error={error} status={status} onRetry={reload} /></div>}
        {t && (
          <>
            <div className="card card-b"><dl className="kv"><dt>Block</dt><dd className="mono">{t.block?.toLocaleString()}</dd><dt>Time</dt><dd><DateTime t={t.timestamp} /></dd><dt>USDT transfers</dt><dd>{t.transfers.length}</dd></dl></div>
            <Card title="Transfers" flush>
              {t.transfers.length === 0 ? <EmptyState title="No USDT transfers">This transaction did not move USDT.</EmptyState> : (
                <div className="stack sm" style={{ padding: 8 }}>
                  {t.transfers.map((x, i) => (
                    <div key={i} className="row" style={{ padding: '10px 12px', gap: 14, borderBottom: '1px solid var(--border)' }}>
                      <AddressLink address={x.from} /><ArrowRight size={15} className="muted" aria-label="to" /><AddressLink address={x.to} />
                      <strong className="end num">{usdt(x.amount)}</strong>
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
