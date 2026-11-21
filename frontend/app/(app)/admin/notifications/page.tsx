'use client';
import { Mail, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, CopyButton, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, SkeletonRows } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

interface T { id: number; type: 'email' | 'webhook'; target: string; secret?: string; createdAt?: string }

export default function Notifications() {
  const toast = useToast();
  const { data, loading, error, status, reload } = useApi<T[]>('/notify-targets');
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ type: 'email', target: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [del, setDel] = useState<T | null>(null);
  const [secret, setSecret] = useState('');
  const [testing, setTesting] = useState<number | null>(null);
  return (
    <RequirePerm perm="notify.manage">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="Notification targets" sub="Where new alerts are sent. Webhooks are signed with HMAC-SHA256 (header X-Tracera-Signature)." crumbs={[{ label: 'Admin' }, { label: 'Notifications' }]}
          actions={<Button variant="primary" onClick={() => { setF({ type: 'email', target: '' }); setErr(''); setAdd(true); }}><Plus size={15} />Add target</Button>} />
        <Card flush>
          {loading ? <SkeletonRows /> : error ? <ErrorState error={error} status={status} onRetry={reload} /> : (
            <Table caption="Notification targets" rows={data ?? []} rowKey={(t) => t.id}
              empty={<EmptyState icon={<Mail size={22} />} title="No targets" action={<Button variant="primary" onClick={() => setAdd(true)}>Add a target</Button>}>Add an email address or webhook URL to be told when alerts fire.</EmptyState>}
              cols={[
                { key: 't', header: 'Type', cell: (t) => <Badge tone="outline">{t.type === 'email' ? <Mail size={12} /> : <Webhook size={12} />}{t.type}</Badge> },
                { key: 'g', header: 'Target', wrap: true, cell: (t) => <span className="break">{t.target}</span> },
                { key: 's', header: 'Secret', cell: (t) => (t.secret ? <span className="row nw"><code className="xs">{t.secret.slice(0, 6)}…</code><CopyButton value={t.secret} label="Copy secret" /></span> : <span className="faint">—</span>) },
                { key: 'x', header: '', cell: (t) => <span className="row nw"><Button sm busy={testing === t.id} onClick={async () => { setTesting(t.id); try { await api(`/notify-targets/${t.id}/test`, { method: 'POST' }); toast.success('Test notification sent'); } catch (e) { toast.error((e as Error).message); } finally { setTesting(null); } }}><Send size={13} />Send test</Button>
                  <Button sm variant="ghost" icon aria-label="Delete target" onClick={() => setDel(t)}><Trash2 size={14} /></Button></span> },
              ]} />
          )}
        </Card>
        {add && (
          <Modal title="Add notification target" onClose={() => setAdd(false)} footer={<><Button onClick={() => setAdd(false)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.target.trim()} onClick={async () => {
            setBusy(true); setErr('');
            try { const r = await api<T>('/notify-targets', { body: { type: f.type, target: f.target.trim() } }); toast.success('Target added'); setAdd(false); if (r.secret) setSecret(r.secret); reload(); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>Add</Button></>}>
            <div className="stack">
              <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="email">Email</option><option value="webhook">Webhook</option></Select></Field>
              <Field label={f.type === 'email' ? 'Email address' : 'Webhook URL'}><Input type={f.type === 'email' ? 'email' : 'url'} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} autoFocus placeholder={f.type === 'email' ? 'soc@example.com' : 'https://…'} /></Field>
              {err && <Notice tone="error">{err}</Notice>}
            </div>
          </Modal>
        )}
        {secret && <Modal title="Webhook signing secret" onClose={() => setSecret('')} footer={<Button variant="primary" onClick={() => setSecret('')}>Done</Button>}>
          <div className="stack"><Notice tone="warn">Store this secret to verify webhook signatures.</Notice><div className="row nw card card-b" style={{ background: 'var(--surface-3)' }}><code className="break grow">{secret}</code><CopyButton value={secret} label="Copy secret" /></div></div></Modal>}
        {del && <ConfirmDialog title="Delete target" onClose={() => setDel(null)} onConfirm={async () => {
          try { await api(`/notify-targets/${del.id}`, { method: 'DELETE' }); toast.success('Target deleted'); reload(); } catch (e) { toast.error((e as Error).message); }
          setDel(null);
        }}>Stop sending alerts to <b>{del.target}</b>?</ConfirmDialog>}
      </div>
    </RequirePerm>
  );
}
