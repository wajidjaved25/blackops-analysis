'use client';
import { Printer } from 'lucide-react';
import { useParams } from 'next/navigation';
import { RequirePerm } from '@/components/Guard';
import { Button, ErrorState, LinkButton, SkeletonRows } from '@/components/ui';
import { exact, num, short } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Report {
  case: { id: number; title: string; description?: string; status: string; createdAt: string; graphPng?: string };
  addresses: { id: number; chain: string; address: string; role: string; note?: string; risk?: { score: number; level: string; reasons: string[] } }[];
  timeline: { hash: string; from: string; to: string; amount: number; timestamp: number; hop: number | null }[];
  warnings?: string[];
  totals: { transfers: number; volume: number };
  generatedAt: string;
  generatedBy: string | { name?: string; email?: string };
}

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const { data: r, loading, error, status, reload } = useApi<Report>(`/cases/${id}/report`);
  const c = useApi<{ graphPng?: string }>(`/cases/${id}`);
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
            <table><tbody><tr><th>Addresses in case</th><td>{r.addresses.length}</td><th>Transfers between them</th><td>{r.totals.transfers}</td><th>Total volume</th><td>{num(r.totals.volume)} USDT</td></tr></tbody></table>
            <h2>Addresses and risk</h2>
            <table><thead><tr><th>Address</th><th>Chain</th><th>Role</th><th>Risk</th><th>Notes / reasons</th></tr></thead><tbody>
              {r.addresses.map((a) => (
                <tr key={a.id}><td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{a.address}</td><td>{a.chain}</td><td>{a.role}</td>
                  <td><span className="lv">{a.risk?.level ?? 'n/a'}</span>{a.risk ? ` (${a.risk.score})` : ''}</td><td>{[a.note, ...(a.risk?.reasons ?? [])].filter(Boolean).join('; ') || '—'}</td></tr>
              ))}
            </tbody></table>
            {png && <><h2>Fund-flow graph</h2><img src={png} alt="Fund-flow graph" /></>}
            <h2>Key transfers</h2>
            {r.timeline.length === 0 ? <p className="muted">No transfers between the case addresses were found.</p> : (
              <table><thead><tr><th>Time</th><th>Hop</th><th>From</th><th>To</th><th className="num">USDT</th><th>Transaction</th></tr></thead><tbody>
                {r.timeline.map((t, i) => (<tr key={i}><td>{exact(t.timestamp)}</td><td>{t.hop ?? '–'}</td><td title={t.from} style={{ fontFamily: 'monospace' }}>{short(t.from)}</td><td title={t.to} style={{ fontFamily: 'monospace' }}>{short(t.to)}</td><td className="num">{num(t.amount)}</td><td style={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: 10 }}>{t.hash}</td></tr>))}
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
