'use client';
import { Printer } from 'lucide-react';
import { useParams } from 'next/navigation';
import { RequirePerm } from '@/components/Guard';
import { Button, ErrorState, LinkButton, SkeletonRows } from '@/components/ui';
import { exact, num, short } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { Analysis, AnalysisReportSection, Result } from '@/components/CaseAnalysis';
import { OFF_CHAIN_NOTE, STATUS, TxList } from '@/components/CaseTransactions';

interface Report {
  case: { id: number; title: string; description?: string; status: string; createdAt: string; graphPng?: string };
  addresses: { id: number; chain: string; address: string; role: string; note?: string; risk?: { score: number; level: string; reasons: string[] } }[];
  timeline: { hash: string; from: string; to: string; amount: number; asset?: string; timestamp: number; hop: number | null }[];
  warnings?: string[];
  totals: { transfers: number; volume: number };
  generatedAt: string;
  generatedBy: string | { name?: string; email?: string };
}

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const { data: r, loading, error, status, reload } = useApi<Report>(`/cases/${id}/report`);
  const c = useApi<{ graphPng?: string }>(`/cases/${id}`);
  const txs = useApi<TxList>(`/cases/${id}/transactions?limit=1000`);
  const an = useApi<Analysis & { result: Result }>(`/cases/${id}/analyses/latest`); // 404 when no analysis was run: the section is then simply absent
  const png = r?.case.graphPng || c.data?.graphPng;
  return (
    <RequirePerm perm="export.data">
      <div className="page stack">
        <div className="row no-print"><LinkButton href={`/cases/${id}`} variant="ghost">← Back to case</LinkButton><Button variant="primary" className="end" disabled={!r} onClick={() => window.print()}><Printer size={15} />Download PDF</Button></div>
        {loading && <div className="card"><SkeletonRows rows={8} /></div>}
        {error && <div className="card"><ErrorState error={error} status={status} onRetry={reload} /></div>}
        {r && (
          <article className="report">
            <div className="cover">
              <div style={{ fontSize: 12, letterSpacing: '.1em', textTransform: 'uppercase', color: '#3340d0', fontWeight: 700 }}>USDT Trace · Investigation report</div>
              <h1 style={{ fontSize: 28, margin: '8px 0' }}>{r.case.title}</h1>
              <div className="muted">Case #{r.case.id} · {r.case.status} · opened {exact(r.case.createdAt)}</div>
            </div>
            {r.warnings?.length ? <div className="no-print" style={{ background: '#fff4d6', padding: 8, fontSize: 12, marginBottom: 10 }}>Notes: {r.warnings.join(' · ')}</div> : null}
            <h2>Summary</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{r.case.description || 'No description provided.'}</p>
            <table><tbody><tr><th>Addresses in case</th><td>{r.addresses.length}</td><th>Transfers between them</th><td>{r.totals.transfers}</td><th>Total volume</th><td>{num(r.totals.volume)} USD-equivalent (USDT + USDC, both ≈ $1)</td></tr></tbody></table>
            <h2>Addresses and risk</h2>
            <table><thead><tr><th>Address</th><th>Chain</th><th>Role</th><th>Risk</th><th>Notes / reasons</th></tr></thead><tbody>
              {r.addresses.map((a) => (
                <tr key={a.id}><td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{a.address}</td><td>{a.chain}</td><td>{a.role}</td>
                  <td><span className="lv">{a.risk?.level ?? 'n/a'}</span>{a.risk ? ` (${a.risk.score})` : ''}</td><td>{[a.note, ...(a.risk?.reasons ?? [])].filter(Boolean).join('; ') || '—'}</td></tr>
              ))}
            </tbody></table>
            {png && <><h2>Fund-flow graph</h2><img src={png} alt="Fund-flow graph" /></>}
            {txs.data && txs.data.summary.total > 0 && (
              <>
                <h2>Transactions (statement and pasted hashes)</h2>
                <table><tbody><tr><th>Rows</th><td>{txs.data.summary.total}</td><th>Claimed</th><td>{num(txs.data.summary.claimed)} USD-equivalent</td><th>Verified on-chain</th><td>{num(txs.data.summary.verified)} USD-equivalent</td></tr>
                  <tr><th colSpan={2}>By status</th><td colSpan={4}>{Object.entries(txs.data.summary.byStatus).map(([k, v]) => `${STATUS[k]?.label ?? k}: ${v.count}`).join(' · ')}</td></tr></tbody></table>
                <table><thead><tr><th>Status</th><th>Time</th><th>Transaction</th><th>To (claimed)</th><th className="num">Claimed</th><th className="num">On-chain</th><th>Details</th></tr></thead><tbody>
                  {txs.data.rows.map((t) => (
                    <tr key={t.id}><td>{STATUS[t.status]?.label ?? t.status}</td><td>{exact(t.claimedAt ?? t.onAt)}</td>
                      <td style={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 10 }}>{t.hash ?? t.ref ?? '—'}</td><td title={t.address ?? ''} style={{ fontFamily: 'monospace' }}>{t.address ? short(t.address) : '—'}</td>
                      <td className="num">{t.amount === null ? '—' : `${num(t.amount)} ${(t.coin ?? '').toUpperCase()}`}</td><td className="num">{t.onAmount === null ? '—' : `${num(t.onAmount)} ${(t.onAsset ?? '').toUpperCase()}`}</td>
                      <td>{t.status === 'off_chain' ? OFF_CHAIN_NOTE : t.reasons.join('; ')}</td></tr>
                  ))}
                </tbody></table>
                {txs.data.count > txs.data.rows.length && <p className="muted">Showing the first {txs.data.rows.length} of {txs.data.count} rows; the full list is in the CSV export.</p>}
              </>
            )}
            {an.data?.result && <AnalysisReportSection a={an.data as Analysis & { result: Result }} />}
            <h2>Key transfers</h2>
            {r.timeline.length === 0 ? <p className="muted">No transfers between the case addresses were found.</p> : (
              <table><thead><tr><th>Time</th><th>Hop</th><th>From</th><th>To</th><th>Asset</th><th className="num">Amount</th><th>Transaction</th></tr></thead><tbody>
                {r.timeline.map((t, i) => (<tr key={i}><td>{exact(t.timestamp)}</td><td>{t.hop ?? '–'}</td><td title={t.from} style={{ fontFamily: 'monospace' }}>{short(t.from)}</td><td title={t.to} style={{ fontFamily: 'monospace' }}>{short(t.to)}</td><td>{(t.asset ?? 'usdt').toUpperCase()}</td><td className="num">{num(t.amount)}</td><td style={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 10 }}>{t.hash}</td></tr>))}
              </tbody></table>
            )}
            <p className="muted" style={{ fontSize: 11, marginTop: 28, borderTop: '1px solid #ddd', paddingTop: 8 }}>
              Generated {exact(r.generatedAt)} by {typeof r.generatedBy === 'string' ? r.generatedBy : r.generatedBy?.name || r.generatedBy?.email}. Risk scores are indicative and based on public labels and on-chain activity.
            </p>
          </article>
        )}
      </div>
    </RequirePerm>
  );
}
