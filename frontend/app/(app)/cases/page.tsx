'use client';
import { Briefcase, Plus, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { Modal } from '@/components/Modal';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Segmented, SkeletonRows, Textarea, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

interface CaseRow { id: number; title: string; status: string; createdAt: string; updatedAt: string; addresses: number; notes: number; files: number }

function Cases() {
  const { can } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const sp = useSearchParams();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ title: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const { data, loading, error, status: st, reload } = useApi<CaseRow[]>(`/cases?status=${status}`);
  const manage = can('cases.manage');
  useEffect(() => { if (sp.get('new') && manage) setCreating(true); }, [sp, manage]);
  const rows = (data ?? []).filter((c) => c.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page stack" style={{ gap: 20 }}>
      <PageHeader title="Cases" sub="Organise addresses, graphs, notes and evidence for an investigation." crumbs={[{ label: 'Casework' }, { label: 'Cases' }]}
        actions={<Button variant="primary" disabled={!manage} title={manage ? '' : 'Requires cases.manage'} onClick={() => setCreating(true)}><Plus size={15} />New case</Button>} />
      <Card flush title={<span className="row">
        <Segmented label="Status" value={status} onChange={setStatus} options={[{ id: '', label: 'All' }, { id: 'open', label: 'Open' }, { id: 'closed', label: 'Closed' }]} />
        <span style={{ position: 'relative' }}><Search size={14} style={{ position: 'absolute', left: 10, top: 8, color: 'var(--faint)' }} aria-hidden /><Input sm style={{ paddingLeft: 30, width: 220 }} placeholder="Search cases" aria-label="Search cases" value={q} onChange={(e) => setQ(e.target.value)} /></span>
      </span>}>
        {loading ? <SkeletonRows /> : error ? <ErrorState error={error} status={st} onRetry={reload} /> : (
          <Table caption="Cases" rows={rows} rowKey={(c) => c.id} onRowClick={(c) => router.push(`/cases/${c.id}`)} initialSort={{ key: 'u', dir: 'desc' }}
            empty={<EmptyState icon={<Briefcase size={22} />} title={q ? 'No matching cases' : 'No cases yet'} action={manage && !q ? <Button variant="primary" onClick={() => setCreating(true)}>Create a case</Button> : undefined}>{q ? 'Try a different search.' : 'A case collects the wallets, transfer graph, notes and files of one investigation.'}</EmptyState>}
            cols={[
              { key: 't', header: 'Title', sort: (c) => c.title, cell: (c) => <span style={{ fontWeight: 600 }}>{c.title}</span> },
              { key: 's', header: 'Status', cell: (c) => <Badge tone={c.status === 'open' ? 'info' : undefined}>{c.status}</Badge> },
              { key: 'a', header: 'Addresses', num: true, sort: (c) => c.addresses, cell: (c) => c.addresses },
              { key: 'n', header: 'Notes', num: true, cell: (c) => c.notes },
              { key: 'f', header: 'Files', num: true, cell: (c) => c.files },
              { key: 'u', header: 'Updated', sort: (c) => Date.parse(c.updatedAt), cell: (c) => <Time t={c.updatedAt} /> },
            ]} />
        )}
      </Card>
      {creating && (
        <Modal title="New case" onClose={() => setCreating(false)} footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.title.trim()} onClick={async () => {
          setBusy(true); setErr('');
          try { const c = await api<{ id: number }>('/cases', { body: { title: f.title.trim(), description: f.description || undefined } }); toast.success('Case created'); router.push(`/cases/${c.id}`); }
          catch (e) { setErr((e as Error).message); setBusy(false); }
        }}>Create case</Button></>}>
          <div className="stack">
            <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus placeholder="e.g. Romance scam – victim 2291" /></Field>
            <Field label="Description (optional)"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            {err && <Notice tone="error">{err}</Notice>}
          </div>
        </Modal>
      )}
    </div>
  );
}
export default function Page() { return <RequirePerm perm="cases.view"><Suspense><Cases /></Suspense></RequirePerm>; }
