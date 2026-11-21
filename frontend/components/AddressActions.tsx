'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Chain, isEvmAddr } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ChainChoice } from './Assets';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { Button, Field, Input, Notice, Select, Textarea } from './ui';

export const ROLES = ['suspect', 'victim', 'exchange', 'intermediary', 'other'];
interface CaseRow { id: number; title: string; status: string }

export function AddToCaseModal({ address, chain, onClose }: { address: string; chain?: string; onClose: () => void }) {
  const toast = useToast();
  const cases = useApi<CaseRow[]>('/cases');
  const [caseId, setCaseId] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState('suspect');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = (cases.data ?? []).filter((c) => c.status === 'open');
  useEffect(() => { if (cases.data && !caseId) setCaseId(open[0] ? String(open[0].id) : 'new'); }, [cases.data]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    setBusy(true); setErr('');
    try {
      let id = caseId;
      if (caseId === 'new') {
        if (!title.trim()) throw new Error('Give the new case a title');
        id = String((await api<{ id: number }>('/cases', { body: { title: title.trim() } })).id);
      }
      await api(`/cases/${id}/addresses`, { body: { address, chain, role, note: note || undefined } }); // the case remembers the chain per address (Ethereum vs BNB Chain)
      toast.success('Address added to case');
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Add to case" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Add address</Button></>}>
      <div className="stack">
        <div className="mono small break muted">{address}</div>
        {cases.error && <Notice tone="warn">Could not load cases: {cases.error}. You can still create a new one.</Notice>}
        <Field label="Case">
          <Select value={caseId} onChange={(e) => setCaseId(e.target.value)}>
            {open.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            <option value="new">+ Create new case…</option>
          </Select>
        </Field>
        {caseId === 'new' && <Field label="New case title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Phishing wave – March" /></Field>}
        <Field label="Role in case"><Select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        <Field label="Note (optional)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Modal>
  );
}

export function WatchModal({ address, chain, onClose }: { address: string; chain?: string; onClose: () => void }) {
  const toast = useToast();
  const lists = useApi<{ id: number; name: string }[]>('/watchlists');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (lists.data && !id) setId(lists.data[0] ? String(lists.data[0].id) : 'new'); }, [lists.data]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    setBusy(true); setErr('');
    try {
      let wid = id;
      if (id === 'new') { if (!name.trim()) throw new Error('Name the new watchlist'); wid = String((await api<{ id: number }>('/watchlists', { body: { name: name.trim() } })).id); }
      await api(`/watchlists/${wid}/items`, { body: { addresses: [address], chain } });
      toast.success('Now watching this address');
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Watch address" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Start watching</Button></>}>
      <div className="stack">
        <div className="mono small break muted">{address}</div>
        {lists.error && <Notice tone="warn">Could not load watchlists: {lists.error}</Notice>}
        <Field label="Watchlist"><Select value={id} onChange={(e) => setId(e.target.value)}>{(lists.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}<option value="new">+ Create new watchlist…</option></Select></Field>
        {id === 'new' && <Field label="Watchlist name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        <p className="muted small">New transfers are checked automatically; add rules on the watchlist to raise alerts.</p>
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Modal>
  );
}

export function AddLabelModal({ address, onClose, onDone }: { address?: string; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const st = useApi<{ categories: string[] }>('/labels/status');
  const cats = st.data?.categories ?? ['sanctioned', 'frozen', 'ransomware', 'darknet', 'terrorism', 'scam', 'fraud', 'mixer', 'gambling', 'other', 'exchange', 'exchange_deposit', 'service', 'bridge', 'dex'];
  const [f, setF] = useState({ address: address ?? '', name: '', category: 'other', chain: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal title="Add label" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.address || !f.name} onClick={async () => {
      setBusy(true); setErr('');
      try { await api('/labels', { body: { ...f, chain: isEvmAddr(f.address.trim()) ? f.chain || undefined : undefined, address: f.address.trim(), name: f.name.trim() } }); toast.success('Label added'); onDone?.(); onClose(); }
      catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
    }}>Save label</Button></>}>
      <div className="stack">
        <Field label="Address"><Input className="mono" value={f.address} disabled={!!address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="T… or 0x…" /></Field>
        <ChainChoice addr={f.address} value={(f.chain || 'eth') as Chain} onChange={(c) => setF({ ...f, chain: c })} />
        <Field label="Name" hint="Visible to your organisation only."><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Binance deposit" autoFocus /></Field>
        <Field label="Category"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{cats.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Modal>
  );
}
