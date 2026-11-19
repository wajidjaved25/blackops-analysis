'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, Chain, chainName, explorerAddr, short, usdt, when } from '@/lib/format';

interface Transfer {
  hash: string;
  from: string;
  to: string;
  amount: number;
  timestamp: number;
}
interface Flow {
  address: string;
  in: number;
  out: number;
  inCount: number;
  outCount: number;
}
interface AddressData {
  chain: Chain;
  address: string;
  balance: number;
  frozen: boolean;
  totalIn: number;
  totalOut: number;
  txCount: number;
  truncated: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
  counterparties: Flow[];
  transfers: Transfer[];
}

const PAGE = 50;

export default function AddressPage() {
  const { addr } = useParams<{ addr: string }>();
  const [data, setData] = useState<AddressData | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    setData(null);
    setError('');
    setPage(0);
    api<AddressData>(`/api/address/${addr}`).then(setData, (e) => setError(e.message));
  }, [addr]);

  if (error) return <p className="bad">{error}</p>;
  if (!data) return <p className="muted">Loading wallet… (large wallets take a few seconds)</p>;

  const me = data.address;
  const isMe = (a: string) => (data.chain === 'eth' ? a.toLowerCase() === me : a === me);
  const pages = Math.ceil(data.transfers.length / PAGE);
  const rows = data.transfers.slice(page * PAGE, page * PAGE + PAGE);

  return (
    <>
      <div className="title-row">
        <div>
          <span className="badge">{chainName(data.chain)}</span>
          {data.frozen && <span className="badge danger">Frozen by Tether</span>}
          <h1 className="mono break">{me}</h1>
        </div>
        <div className="actions no-print">
          <a className="button" href={`/graph?addr=${me}`}>Open in graph</a>
          <a className="button secondary" href={explorerAddr(data.chain, me)} target="_blank" rel="noreferrer">Explorer ↗</a>
        </div>
      </div>

      <div className="stats">
        <Stat label="Balance" value={usdt(data.balance)} />
        <Stat label="Received" value={usdt(data.totalIn)} />
        <Stat label="Sent" value={usdt(data.totalOut)} />
        <Stat label="Transfers" value={data.txCount.toLocaleString()} />
        <Stat label="First seen" value={when(data.firstSeen)} />
        <Stat label="Last seen" value={when(data.lastSeen)} />
      </div>
      {data.truncated && (
        <p className="note">
          Showing the latest {data.txCount.toLocaleString()} transfers. Received, sent and first seen cover this window only, not the wallet's full history.
        </p>
      )}

      <h2>Top counterparties</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th className="num">Received from</th>
              <th className="num">Sent to</th>
              <th className="num">Transfers</th>
            </tr>
          </thead>
          <tbody>
            {data.counterparties.map((f) => (
              <tr key={f.address}>
                <td className="mono"><a href={`/address/${f.address}`}>{f.address}</a></td>
                <td className="num">{f.in ? usdt(f.in) : '—'}</td>
                <td className="num">{f.out ? usdt(f.out) : '—'}</td>
                <td className="num">{f.inCount + f.outCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Transfers</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Direction</th>
              <th>Counterparty</th>
              <th className="num">Amount</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => {
              const incoming = isMe(t.to);
              const other = incoming ? t.from : t.to;
              return (
                <tr key={t.hash + i}>
                  <td>{when(t.timestamp)}</td>
                  <td><span className={incoming ? 'ok' : 'bad'}>{incoming ? 'IN' : 'OUT'}</span></td>
                  <td className="mono"><a href={`/address/${other}`}>{short(other)}</a></td>
                  <td className="num">{usdt(t.amount)}</td>
                  <td className="mono"><a href={`/tx/${data.chain}/${t.hash}`}>{short(t.hash)}</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager no-print">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>← Newer</button>
          <span className="muted">Page {page + 1} of {pages}</span>
          <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Older →</button>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
