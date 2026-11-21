'use client';
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Chain, chainName, short } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ROLES } from './AddressActions';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { Button, Field, Input, Notice, Select } from './ui';

interface CaseRow { id: number; title: string; status: string }
interface Tr { from: string; to: string }
const MAX_ADDRS = 50; // a batch transaction can have hundreds of transfers; the dialog lists the first ones
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Investigate this transaction": case (new or existing) + sender/receiver as case addresses + the tx via paste/verify + a case analysis, then the Analysis tab. */
export function InvestigateTx({ chain, hash, transfers }: { chain: Chain; hash: string; transfers: Tr[] }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const manage = can('cases.manage');
  return (
    <>
      <Button variant="primary" disabled={!manage} title={manage ? '' : 'Requires cases.manage'} onClick={() => setOpen(true)}><Search size={14} />Investigate this transaction</Button>
      {open && <InvestigateDialog chain={chain} hash={hash} transfers={transfers} onClose={() => setOpen(false)} />}
    </>
  );
}

function InvestigateDialog({ chain, hash, transfers, onClose }: { chain: Chain; hash: string; transfers: Tr[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const cases = useApi<CaseRow[]>('/cases');
  const open = (cases.data ?? []).filter((c) => c.status === 'open');
  const [caseId, setCaseId] = useState('');
  const [title, setTitle] = useState(`Investigation of ${short(hash)}`);
  const list = useMemo(() => {
    const m = new Map<string, string>(); // address -> default role; a sender stays a sender when it also receives
    for (const t of transfers) if (t.from) m.set(t.from, 'suspect');
    for (const t of transfers) if (t.to && !m.has(t.to)) m.set(t.to, 'intermediary');
    return [...m.entries()];
  }, [transfers]);
  const shown = list.slice(0, MAX_ADDRS);
  const senders = new Set(transfers.map((t) => t.from));
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (cases.data && !caseId) setCaseId(open[0] ? String(open[0].id) : 'new'); }, [cases.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = !!step;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []); // the poll below must not redirect after the dialog is gone

  async function start() {
    setErr('');
    try {
      let id = caseId;
      if (caseId === 'new') {
        if (!title.trim()) throw new Error('Give the new case a title');
        setStep('Creating the case…');
        id = String((await api<{ id: number }>('/cases', { body: { title: title.trim() } })).id);
        setCaseId(id); // a retry after a later failure reuses this case instead of creating another
        cases.reload();
      }
      setStep('Adding sender and receiver…');
      const note = `From transaction ${hash}`;
      if (shown.length) await api(`/cases/${id}/addresses/bulk`, { body: { chain: chain === 'tron' ? undefined : chain, addresses: shown.map(([a, d]) => ({ address: a, role: roles[a] ?? d, note: `${senders.has(a) ? 'Sender' : 'Receiver'} in ${note}` })) } });
      setStep('Adding the transaction and verifying it on-chain…');
      await api(`/cases/${id}/transactions`, { body: { hashes: [hash], ...(chain === 'tron' ? {} : { chain }) } });
      let pending = 1;
      for (let i = 0; i < 60 && pending; i++) { // the verify job runs in the background; the analysis needs the verified recipient
        pending = (await api<{ summary: { pending: number } }>(`/cases/${id}/transactions?limit=1`)).summary.pending;
        if (pending) await sleep(2000);
        if (!alive.current) return;
      }
      setStep('Starting the analysis…');
      try { await api(`/cases/${id}/analyses`, { body: { direction: 'both' } }); } catch (e) { if ((e as { status?: number }).status !== 409) throw e; } // 409: one is already running, show it
      toast.success(pending ? 'Investigation started (verification was still running; the analysis counts the transaction as claimed)' : 'Investigation started');
      router.push(`/cases/${id}?tab=analysis`);
    } catch (e) { setErr((e as Error).message); setStep(''); }
  }

  return (
    <Modal title="Investigate this transaction" onClose={busy ? () => undefined : onClose} wide footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!caseId} onClick={start}>Start investigation</Button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Adds this {chainName(chain)} transaction to a case together with its sender and receiver, verifies it on-chain, then runs a case analysis that follows the money onward and traces where it came from. You land on the case&apos;s Analysis tab.</p>
        {cases.error && <Notice tone="warn">Could not load cases: {cases.error}. Reload and try again.</Notice>}
        <Field label="Case">
          <Select value={caseId} onChange={(e) => setCaseId(e.target.value)} disabled={busy}>
            {open.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            <option value="new">+ Create new case…</option>
          </Select>
        </Field>
        {caseId === 'new' && <Field label="New case title"><Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} /></Field>}
        {shown.length > 0 ? (
          <div className="stack sm" aria-label="Addresses to add">
            {shown.map(([a, d]) => (
              <div key={a} className="row" style={{ gap: 10 }}>
                <span className="mono small grow break" title={a}>{short(a)}</span>
                <span className="xs muted">{senders.has(a) ? 'sender' : 'receiver'}</span>
                <Select sm aria-label={`Role for ${a}`} style={{ width: 140 }} value={roles[a] ?? d} disabled={busy} onChange={(e) => setRoles({ ...roles, [a]: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</Select>
              </div>
            ))}
            {list.length > shown.length && <div className="xs muted">{list.length - shown.length} more addresses in this transaction are not added (limit {MAX_ADDRS}).</div>}
          </div>
        ) : <Notice tone="warn">This transaction moved no USDT or USDC, so there is no sender or receiver to add. The transaction itself is still added.</Notice>}
        {step && <div role="status" className="small muted">{step}</div>}
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Modal>
  );
}
