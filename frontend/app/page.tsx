'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { detectChain, detectTx } from '@/lib/format';

export default function Home() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = q.trim();
    if (detectChain(v)) return router.push(`/address/${v}`);
    const txChain = detectTx(v);
    if (txChain) return router.push(`/tx/${txChain}/${v}`);
    setError('Enter a Tron address (T…), an Ethereum address (0x… 40 hex), or a transaction hash.');
  }

  return (
    <section className="hero">
      <h1>Trace USDT</h1>
      <p className="muted">Look up any wallet or transaction on Tron (TRC20) or Ethereum (ERC20).</p>
      <form onSubmit={submit} className="search">
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setError('');
          }}
          placeholder="Address or transaction hash"
          aria-label="Address or transaction hash"
          spellCheck={false}
        />
        <button type="submit">Search</button>
      </form>
      {error && <p className="bad">{error}</p>}
      <p className="muted small">
        Or open the <a href="/graph">graph workspace</a> to trace flows and find paths between wallets.
      </p>
    </section>
  );
}
