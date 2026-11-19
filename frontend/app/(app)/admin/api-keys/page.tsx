'use client';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorState, Field, Input, Notice, PageHeader, SkeletonRows, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

interface Key { id: number; name: string; prefix: string; rateLimitPerMin: number; usageCount: number; lastUsedAt?: string; revokedAt?: string; createdAt: string; createdBy?: string | { name?: string; email?: string } }

export default function ApiKeys() {
  const toast = useToast();
  const { data, loading, error, status, reload } = useApi<Key[]>('/api-keys');
  const [create, setCreate] = useState(false);
  const [f, setF] = useState({ name: '', rate: '60' });
  const [shown, setShown] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rev, setRev] = useState<Key | null>(null);
  return (
    <RequirePerm perm="apikeys.manage">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="API keys" sub={<>Use with the screening API: <code>GET /api/v1/screen/:address</code> and header <code>X-API-Key</code>.</>} crumbs={[{ label: 'Admin' }, { label: 'API keys' }]}
          actions={<Button variant="primary" onClick={() => { setF({ name: '', rate: '60' }); setErr(''); setCreate(true); }}><Plus size={15} />Create key</Button>} />
        <Card flush>
          {loading ? <SkeletonRows /> : error ? <ErrorState error={error} status={status} onRetry={reload} /> : (
            <Table caption="API keys" rows={data ?? []} rowKey={(k) => k.id}
              empty={<EmptyState icon={<KeyRound size={22} />} title="No API keys" action={<Button variant="primary" onClick={() => setCreate(true)}>Create a key</Button>}>Keys let your own systems screen addresses programmatically.</EmptyState>}
              cols={[
                { key: 'n', header: 'Name', cell: (k) => <span style={{ fontWeight: 600 }}>{k.name}</span> },
                { key: 'p', header: 'Key', cell: (k) => <code>{k.prefix}…</code> },
                { key: 'r', header: 'Limit / min', num: true, cell: (k) => k.rateLimitPerMin },
                { key: 'u', header: 'Requests', num: true, sort: (k) => k.usageCount, cell: (k) => k.usageCount.toLocaleString() },
                { key: 'l', header: 'Last used', cell: (k) => <Time t={k.lastUsedAt} /> },
                { key: 's', header: 'Status', cell: (k) => (k.revokedAt ? <Badge tone="severe">Revoked</Badge> : <Badge tone="good">Active</Badge>) },
                { key: 'x', header: '', cell: (k) => !k.revokedAt && <Button sm variant="danger" onClick={() => setRev(k)}>Revoke</Button> },
              ]} />
          )}
        </Card>
        {create && (
          <Modal title="Create API key" onClose={() => setCreate(false)} footer={<><Button onClick={() => setCreate(false)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name.trim()} onClick={async () => {
            setBusy(true); setErr('');
            try { const r = await api<{ key: string }>('/api-keys', { body: { name: f.name.trim(), rateLimitPerMin: Number(f.rate) || undefined } }); setCreate(false); setShown(r.key); reload(); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>Create key</Button></>}>
            <div className="stack"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus placeholder="e.g. Onboarding system" /></Field>
              <Field label="Rate limit (requests per minute)"><Input type="number" min="1" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>{err && <Notice tone="error">{err}</Notice>}</div>
          </Modal>
        )}
        {shown && (
          <Modal title="Your new API key" onClose={() => setShown('')} footer={<Button variant="primary" onClick={() => setShown('')}>I have copied it</Button>}>
            <div className="stack">
              <Notice tone="warn">Copy this key now. For security it is shown only once and cannot be retrieved later.</Notice>
              <div className="row nw card card-b" style={{ background: 'var(--surface-3)' }}><code className="break grow">{shown}</code><CopyButton value={shown} label="Copy key" /></div>
            </div>
          </Modal>
        )}
        {rev && <ConfirmDialog title="Revoke API key" confirmLabel="Revoke" onClose={() => setRev(null)} onConfirm={async () => {
          try { await api(`/api-keys/${rev.id}`, { method: 'DELETE' }); toast.success('Key revoked'); reload(); } catch (e) { toast.error((e as Error).message); }
          setRev(null);
        }}>Systems using <b>{rev.name}</b> will immediately lose access.</ConfirmDialog>}
      </div>
    </RequirePerm>
  );
}
