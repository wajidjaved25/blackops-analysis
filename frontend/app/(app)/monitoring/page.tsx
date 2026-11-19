'use client';
import { Eye, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, SkeletonRows, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

interface WL { id: number; name: string; createdAt: string; items: number; rules: number; openAlerts: number }

export default function Monitoring() {
  const { can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const { data, loading, error, status, reload } = useApi<WL[]>('/watchlists');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [del, setDel] = useState<WL | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can('monitor.manage');
  return (
    <RequirePerm perm="monitor.view">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="Monitoring" sub="Watchlists are checked automatically; rules raise alerts on new activity." crumbs={[{ label: 'Compliance' }, { label: 'Monitoring' }]}
          actions={<Button variant="primary" disabled={!manage} title={manage ? '' : 'Requires monitor.manage'} onClick={() => setCreating(true)}><Plus size={15} />New watchlist</Button>} />
        <Card flush>
          {loading ? <SkeletonRows /> : error ? <ErrorState error={error} status={status} onRetry={reload} /> : (
            <Table caption="Watchlists" rows={data ?? []} rowKey={(w) => w.id} onRowClick={(w) => router.push(`/monitoring/${w.id}`)}
              empty={<EmptyState icon={<Eye size={22} />} title="No watchlists yet" action={manage ? <Button variant="primary" onClick={() => setCreating(true)}>Create your first watchlist</Button> : undefined}>Group wallets you care about, add rules, and get alerts when they move money.</EmptyState>}
              cols={[
                { key: 'n', header: 'Name', sort: (w) => w.name, cell: (w) => <span style={{ fontWeight: 600 }}>{w.name}</span> },
                { key: 'i', header: 'Addresses', num: true, sort: (w) => w.items, cell: (w) => w.items },
                { key: 'r', header: 'Rules', num: true, sort: (w) => w.rules, cell: (w) => w.rules },
                { key: 'a', header: 'Open alerts', num: true, sort: (w) => w.openAlerts, cell: (w) => (w.openAlerts ? <Badge tone="severe">{w.openAlerts}</Badge> : <span className="faint">0</span>) },
                { key: 'c', header: 'Created', sort: (w) => Date.parse(w.createdAt), cell: (w) => <Time t={w.createdAt} /> },
                { key: 'x', header: '', cell: (w) => <Button sm variant="ghost" icon aria-label={`Delete ${w.name}`} disabled={!manage} onClick={(e) => { e.stopPropagation(); setDel(w); }}><Trash2 size={14} /></Button> },
              ]} />
          )}
        </Card>
        {creating && (
          <Modal title="New watchlist" onClose={() => setCreating(false)} footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!name.trim()} onClick={async () => {
            setBusy(true); setErr('');
            try { const w = await api<{ id: number }>('/watchlists', { body: { name: name.trim() } }); toast.success('Watchlist created'); router.push(`/monitoring/${w.id}`); }
            catch (e) { setErr((e as Error).message); setBusy(false); }
          }}>Create</Button></>}>
            <div className="stack"><Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. High-value customers" /></Field>{err && <Notice tone="error">{err}</Notice>}</div>
          </Modal>
        )}
        {del && <ConfirmDialog title="Delete watchlist" busy={busy} onClose={() => setDel(null)} onConfirm={async () => {
          setBusy(true);
          try { await api(`/watchlists/${del.id}`, { method: 'DELETE' }); toast.success('Watchlist deleted'); setDel(null); reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
        }}>Delete <b>{del.name}</b> with its {del.items} addresses, {del.rules} rules and alerts? This cannot be undone.</ConfirmDialog>}
      </div>
    </RequirePerm>
  );
}
