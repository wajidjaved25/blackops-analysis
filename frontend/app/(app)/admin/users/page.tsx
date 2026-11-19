'use client';
import { MoreHorizontal, Plus, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, SkeletonRows, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

interface U { id: number; email: string; name: string; role: { id: number; name: string }; status: 'active' | 'disabled'; totpEnabled?: boolean; lastLoginAt?: string; createdAt: string }
interface Role { id: number; name: string }
type Confirm = { kind: 'delete' | 'reset2fa' | 'revoke' | 'disable'; u: U } | null;

function RowMenu({ u, self, onPick }: { u: U; self: boolean; onPick: (k: NonNullable<Confirm>['kind'] | 'enable') => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  const item = (k: Parameters<typeof onPick>[0], label: string, dis = false, danger = false) => <button role="menuitem" disabled={dis} style={{ color: danger ? 'var(--severe)' : undefined, opacity: dis ? .5 : 1 }} onClick={() => { setOpen(false); onPick(k); }}>{label}</button>;
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <Button sm variant="ghost" icon aria-label={`Actions for ${u.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal size={16} /></Button>
      {open && <div className="menu" role="menu">
        {u.status === 'active' ? item('disable', 'Disable account', self) : item('enable', 'Enable account')}
        {item('reset2fa', 'Reset 2FA', !u.totpEnabled)}
        {item('revoke', 'Revoke all sessions')}
        <hr />
        {item('delete', 'Delete user', self, true)}
      </div>}
    </div>
  );
}

export default function UsersPage() {
  const { me } = useAuth();
  const toast = useToast();
  const { data, loading, error, status, reload } = useApi<U[]>('/users');
  const roles = useApi<Role[]>('/roles');
  const [create, setCreate] = useState(false);
  const [f, setF] = useState({ email: '', name: '', roleId: '', password: '' });
  const [err, setErr] = useState('');
  const [conf, setConf] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const pwErr = f.password && f.password.length < 12 ? 'At least 12 characters' : '';

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); toast.success(ok); reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); setConf(null); }
  }
  const run = (k: string, u: U) => {
    if (k === 'enable') return act(() => api(`/users/${u.id}`, { method: 'PATCH', body: { status: 'active' } }), 'Account enabled');
    setConf({ kind: k as NonNullable<Confirm>['kind'], u });
  };
  const text = { delete: 'Delete', reset2fa: 'Reset 2FA for', revoke: 'Sign out everywhere:', disable: 'Disable' } as const;
  return (
    <RequirePerm perm="users.manage">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="Users" sub="People who can sign in to your organisation." crumbs={[{ label: 'Admin' }, { label: 'Users' }]}
          actions={<Button variant="primary" onClick={() => { setCreate(true); setF({ email: '', name: '', roleId: String(roles.data?.[0]?.id ?? ''), password: '' }); }}><Plus size={15} />Create user</Button>} />
        <Card flush>
          {loading ? <SkeletonRows /> : error ? <ErrorState error={error} status={status} onRetry={reload} /> : (
            <Table caption="Users" rows={data ?? []} rowKey={(u) => u.id}
              empty={<EmptyState icon={<Users size={22} />} title="No users" />}
              cols={[
                { key: 'n', header: 'User', sort: (u) => u.name, wrap: true, cell: (u) => <div><div style={{ fontWeight: 600 }}>{u.name}{u.id === me?.id && <span className="muted small"> (you)</span>}</div><div className="xs muted">{u.email}</div></div> },
                { key: 'r', header: 'Role', cell: (u) => (
                  <Select sm style={{ width: 130 }} aria-label={`Role for ${u.name}`} value={u.role?.id ?? ''} disabled={u.id === me?.id} onChange={(e) => act(() => api(`/users/${u.id}`, { method: 'PATCH', body: { roleId: Number(e.target.value) } }), 'Role changed')}>
                    {(roles.data ?? [u.role]).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>) },
                { key: 's', header: 'Status', cell: (u) => <Badge tone={u.status === 'active' ? 'good' : 'outline'}>{u.status}</Badge> },
                { key: 't', header: '2FA', cell: (u) => (u.totpEnabled ? <Badge tone="info">On</Badge> : <span className="faint">Off</span>) },
                { key: 'l', header: 'Last login', sort: (u) => (u.lastLoginAt ? Date.parse(u.lastLoginAt) : 0), cell: (u) => <Time t={u.lastLoginAt} /> },
                { key: 'x', header: '', cell: (u) => <RowMenu u={u} self={u.id === me?.id} onPick={(k) => run(k, u)} /> },
              ]} />
          )}
        </Card>
        {create && (
          <Modal title="Create user" onClose={() => setCreate(false)} footer={<><Button onClick={() => setCreate(false)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.email || !f.name || !f.roleId || f.password.length < 12} onClick={async () => {
            setBusy(true); setErr('');
            try { await api('/users', { body: { ...f, roleId: Number(f.roleId) } }); toast.success('User created'); setCreate(false); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>Create user</Button></>}>
            <div className="stack">
              <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
              <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
              <Field label="Role"><Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>{(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
              <Field label="Initial password" hint="The user must change it at first sign-in." error={pwErr}><Input type="text" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
              {roles.error && <Notice tone="warn">Could not load roles: {roles.error}</Notice>}
              {err && <Notice tone="error">{err}</Notice>}
            </div>
          </Modal>
        )}
        {conf && <ConfirmDialog title={`${text[conf.kind]} ${conf.u.name}?`} busy={busy} confirmLabel={conf.kind === 'delete' ? 'Delete user' : 'Confirm'} danger onClose={() => setConf(null)} onConfirm={() => {
          const u = conf.u;
          if (conf.kind === 'delete') act(() => api(`/users/${u.id}`, { method: 'DELETE' }), 'User deleted');
          else if (conf.kind === 'reset2fa') act(() => api(`/users/${u.id}/reset-2fa`, { method: 'POST' }), '2FA reset');
          else if (conf.kind === 'revoke') act(() => api(`/users/${u.id}/revoke-sessions`, { method: 'POST' }), 'Sessions revoked');
          else act(() => api(`/users/${u.id}`, { method: 'PATCH', body: { status: 'disabled' } }), 'Account disabled');
        }}>{conf.kind === 'delete' ? 'This permanently removes the account.' : conf.kind === 'reset2fa' ? 'They will need to enrol a new authenticator.' : conf.kind === 'revoke' ? 'Every active session for this user will end.' : 'They will be signed out and unable to sign in until re-enabled.'} <b>{conf.u.email}</b></ConfirmDialog>}
      </div>
    </RequirePerm>
  );
}
