'use client';
import { Network, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Button, Card, EmptyState, ErrorState, Field, Input, LinkButton, Notice, SkeletonRows, Textarea, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { short } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export interface GraphRow { id: number; name: string; remarks: string; chain: string; rootAddress: string | null; depth: number | null; nodeCount: number; edgeCount: number; hasImage: boolean; author: string | null; createdAt: string; updatedAt: string }

/** The Graph tab of a case: every saved snapshot, newest first. A snapshot's graph is never changed; only its name and remarks are. */
export function GraphsTab({ caseId, graphs, manage, reload }: { caseId: string; graphs: GraphRow[]; manage: boolean; reload: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<GraphRow | null>(null);
  const [edit, setEdit] = useState<GraphRow | null>(null);
  const [del, setDel] = useState<GraphRow | null>(null);
  return (
    <div className="stack" data-testid="case-graphs">
      <Card title={`Graph snapshots (${graphs.length})`} flush actions={<LinkButton href="/graph" sm><Network size={14} />Open graph workspace</LinkButton>}>
        <Table caption="Graph snapshots" rows={graphs} rowKey={(g) => g.id}
          empty={<EmptyState icon={<Network size={22} />} title="No graph saved">Build a graph in the workspace and use “Save to case”. Each save is a new snapshot with its own name and remarks.</EmptyState>}
          cols={[
            { key: 'n', header: 'Name', wrap: true, cell: (g) => <div><strong>{g.name}</strong>{g.remarks && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{g.remarks}</div>}</div> },
            { key: 'r', header: 'Root wallet', cell: (g) => (g.rootAddress ? <span className="mono small" title={g.rootAddress}>{short(g.rootAddress)}</span> : <span className="muted">—</span>) },
            { key: 'c', header: 'Shows', cell: (g) => <span className="small">{g.nodeCount} wallets · {g.edgeCount} links<span className="muted"> · {g.chain}{g.depth ? ` · depth ${g.depth}` : ''}</span></span> },
            { key: 'a', header: 'Saved by', cell: (g) => <span className="small">{g.author ?? '—'}</span> },
            { key: 't', header: 'Saved', sort: (g) => Date.parse(g.createdAt), cell: (g) => <Time t={g.createdAt} /> },
            { key: 'x', header: '', cell: (g) => (
              <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                <Button sm onClick={() => setView(g)}>View</Button>
                <LinkButton sm href={`/graph?case=${caseId}&snapshot=${g.id}`}><Network size={14} />Open</LinkButton>
                <Button sm variant="ghost" icon aria-label={`Edit ${g.name}`} disabled={!manage} title={manage ? 'Rename / edit remarks' : 'Requires cases.manage'} onClick={() => setEdit(g)}><Pencil size={14} /></Button>
                <Button sm variant="ghost" icon aria-label={`Delete ${g.name}`} disabled={!manage} title={manage ? '' : 'Requires cases.manage'} onClick={() => setDel(g)}><Trash2 size={14} /></Button>
              </div>
            ) },
          ]} />
      </Card>
      {view && <ViewModal g={view} onClose={() => setView(null)} />}
      {edit && <EditModal g={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); toast.success('Snapshot updated'); reload(); }} />}
      {del && <ConfirmDialog title="Delete graph snapshot" onClose={() => setDel(null)} onConfirm={async () => {
        try { await api(`/case-graphs/${del.id}`, { method: 'DELETE' }); toast.success('Snapshot deleted'); reload(); } catch (e) { toast.error((e as Error).message); }
        setDel(null);
      }}>Delete <b>{del.name}</b>? The other snapshots of this case are not affected.</ConfirmDialog>}
    </div>
  );
}

function ViewModal({ g, onClose }: { g: GraphRow; onClose: () => void }) {
  const { data, loading, error, status, reload } = useApi<{ graphPng?: string | null }>(`/case-graphs/${g.id}`);
  return (
    <Modal wide title={g.name} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        {g.remarks && <p style={{ whiteSpace: 'pre-wrap' }}>{g.remarks}</p>}
        <p className="muted small">{g.nodeCount} wallets · {g.edgeCount} links · {g.chain}{g.rootAddress ? ` · root ${g.rootAddress}` : ''}. Read-only picture taken when it was saved; use “Open” to work with it in the graph workspace.</p>
        {loading && <SkeletonRows rows={4} />}
        {error && <ErrorState error={error} status={status} onRetry={reload} />}
        {data && (data.graphPng ? <img src={data.graphPng} alt={`Graph snapshot ${g.name}`} style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)' }} /> : <Notice tone="warn">This snapshot has no picture. Open it in the graph workspace to see it.</Notice>)}
      </div>
    </Modal>
  );
}

function EditModal({ g, onClose, onSaved }: { g: GraphRow; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(g.name);
  const [remarks, setRemarks] = useState(g.remarks);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal title="Edit snapshot" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!name.trim()} onClick={async () => {
      setBusy(true); setErr('');
      try { await api(`/case-graphs/${g.id}`, { method: 'PATCH', body: { name: name.trim(), remarks } }); onSaved(); } catch (e) { setErr((e as Error).message); setBusy(false); }
    }}>Save</Button></>}>
      <div className="stack">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Remarks"><Textarea rows={5} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Modal>
  );
}
