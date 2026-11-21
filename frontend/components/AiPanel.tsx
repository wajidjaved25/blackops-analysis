'use client';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Badge, Button, Card, CopyButton, Input, Notice, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addrHref } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Citation { kind: 'tx' | 'address'; id: string; chain: string | null }
interface Answer { text: string; citations: Citation[]; unverified: string[]; model: string; cached: boolean; contextTruncated: boolean; generatedAt: string }
interface Status { enabled: boolean; model: string | null }

const ID_RE = /(0x[0-9a-fA-F]{64}\b|0x[0-9a-fA-F]{40}\b|\bT[1-9A-HJ-NP-Za-km-z]{33}\b|\b[0-9a-fA-F]{64}\b)/g;
const short = (s: string) => `${s.slice(0, 8)}…${s.slice(-6)}`;

/** Answer text with every id the backend verified against the evidence turned into a link; unverified ids stay plain text and are listed below. */
function Cited({ a, chain }: { a: Answer; chain?: string }) {
  const by = new Map(a.citations.map((c) => [c.id.toLowerCase(), c]));
  return (
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {a.text.split(ID_RE).map((part, i) => {
        const c = by.get(part.toLowerCase());
        if (!c) return <Fragment key={i}>{part}</Fragment>;
        const ch = c.chain ?? chain ?? 'tron';
        return <Link key={i} href={c.kind === 'tx' ? `/tx/${ch}/${c.id}` : addrHref(c.id, ch)} title={c.id}><code>{short(part)}</code></Link>;
      })}
    </div>
  );
}

/** Phase 9D. Feature-flagged: when /ai/status says disabled, this renders a static "Coming soon" card and never calls an AI endpoint. */
export function AiPanel({ kind, chain, address, caseId }: { kind: 'address' | 'case'; chain?: string; address?: string; caseId?: string }) {
  const { can } = useAuth();
  const allowed = can('ai.use');
  const status = useApi<Status>(allowed ? '/ai/status' : null);
  const [ans, setAns] = useState<Answer>();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!allowed) return null;
  const title = kind === 'case' ? 'AI case summary' : 'AI summary';
  const blurb = kind === 'case' ? 'A plain-language summary of this case analysis, with next steps, and answers to your questions, each claim linked to its evidence.' : 'A plain-language summary of this wallet, with next steps, and answers to your questions, each claim linked to its evidence.';

  if (status.loading) return <Card title={title}><Spinner label="Checking AI assistant" /></Card>;
  if (!status.data?.enabled) {
    return (
      <Card title={<span className="row" style={{ gap: 8 }}><Sparkles size={15} aria-hidden />{title}<Badge tone="accent">Coming soon</Badge></span>} className="ai-panel">
        <div className="row" style={{ gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span className="small muted" style={{ flex: '1 1 240px' }}>{blurb}</span>
          <Button disabled title="Coming soon" aria-label={`${title} (coming soon)`}>Summarise with AI</Button>
        </div>
      </Card>
    );
  }

  async function go(path: string, body: Record<string, unknown>) {
    setBusy(true); setErr('');
    try { setAns(await api<Answer>(path, { body })); } catch (e) { setErr(e instanceof ApiError && e.code === 'ai_disabled' ? 'AI assistant is coming soon' : (e as Error).message); } finally { setBusy(false); }
  }
  const ctx = kind === 'case' ? { caseId: Number(caseId) } : { chain, address };
  return (
    <Card title={<span className="row" style={{ gap: 8 }}><Sparkles size={15} aria-hidden />{title}<Badge tone="outline">{status.data.model}</Badge></span>}
      actions={ans && <CopyButton value={ans.text} label="Copy AI summary" />}>
      <div className="stack">
        <Notice tone="warn">AI-generated. Verify against the evidence before relying on it. It only sees this page&apos;s data and cannot identify who owns a wallet.</Notice>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Button variant="primary" busy={busy} onClick={() => go(kind === 'case' ? '/ai/case-summary' : '/ai/address-summary', ctx)}>{ans ? 'Regenerate summary' : 'Summarise with AI'}</Button>
        </div>
        <form className="row" style={{ gap: 8, flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (q.trim() && !busy) go('/ai/ask', { ...ctx, question: q.trim() }); }}>
          <Input aria-label="Ask a question about this data" placeholder="Ask a question about this data…" maxLength={600} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <Button type="submit" disabled={busy || !q.trim()}>Ask</Button>
        </form>
        {busy && <Spinner label="Thinking…" />}
        {err && <Notice tone="error">{err}</Notice>}
        {ans && !busy && (
          <div className="stack" style={{ gap: 8 }}>
            <Cited a={ans} chain={chain} />
            {ans.unverified.length > 0 && <Notice tone="warn">The model mentioned {ans.unverified.length} id(s) that are not in the evidence; they are not linked: {ans.unverified.map(short).join(', ')}.</Notice>}
            {ans.contextTruncated && <div className="small muted">Large input: only the top items were sent to the model.</div>}
            <div className="small muted">{ans.model}{ans.cached ? ' · cached result' : ''} · {new Date(ans.generatedAt).toLocaleString()}</div>
          </div>
        )}
      </div>
    </Card>
  );
}
