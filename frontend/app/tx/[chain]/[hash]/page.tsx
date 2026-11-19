'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, Chain, chainName, explorerTx, usdt, when } from '@/lib/format';

interface TxData {
  chain: Chain;
  hash: string;
  block: number;
  timestamp: number;
  success: boolean;
  transfers: { from: string; to: string; amount: number }[];
}

export default function TxPage() {
  const { chain, hash } = useParams<{ chain: string; hash: string }>();
  const [tx, setTx] = useState<TxData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<TxData>(`/api/tx/${chain}/${hash}`).then(setTx, (e) => setError(e.message));
  }, [chain, hash]);

  if (error) return <p className="bad">{error}</p>;
  if (!tx) return <p className="muted">Loading transaction…</p>;

  return (
    <>
      <span className="badge">{chainName(tx.chain)}</span>
      <span className={`badge ${tx.success ? 'good' : 'danger'}`}>{tx.success ? 'Success' : 'Failed'}</span>
      <h1 className="mono break">{tx.hash}</h1>
      <div className="stats">
        <div className="card stat"><div className="muted small">Time</div><div className="stat-value">{when(tx.timestamp)}</div></div>
        <div className="card stat"><div className="muted small">Block</div><div className="stat-value">{tx.block.toLocaleString()}</div></div>
      </div>
      <p><a href={explorerTx(tx.chain, tx.hash)} target="_blank" rel="noreferrer">View on explorer ↗</a></p>

      <h2>USDT transfers in this transaction</h2>
      {tx.transfers.length === 0 ? (
        <p className="muted">No USDT transfers in this transaction.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>From</th><th>To</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {tx.transfers.map((t, i) => (
                <tr key={i}>
                  <td className="mono"><a href={`/address/${t.from}`}>{t.from}</a></td>
                  <td className="mono"><a href={`/address/${t.to}`}>{t.to}</a></td>
                  <td className="num">{usdt(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
