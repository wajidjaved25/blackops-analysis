'use client';
import { useEffect, useState } from 'react';

// Phase 0 home: proves the /api proxy reaches the backend. Search arrives in task 1.5.
export default function Home() {
  const [status, setStatus] = useState<'checking' | 'up' | 'down'>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((j) => setStatus(j.ok ? 'up' : 'down'))
      .catch(() => setStatus('down'));
  }, []);

  return (
    <section className="card">
      <h1>USDT Trace</h1>
      <p className="muted">Investigate and screen USDT wallets on Tron (TRC20) and Ethereum (ERC20).</p>
      <p>
        Backend:{' '}
        {status === 'checking' && <span className="muted">checking…</span>}
        {status === 'up' && <span className="ok">connected</span>}
        {status === 'down' && <span className="bad">not reachable — start it with <code>npm run dev</code> in backend/</span>}
      </p>
    </section>
  );
}
