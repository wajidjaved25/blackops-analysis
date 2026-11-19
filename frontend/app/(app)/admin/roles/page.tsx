'use client';
import { Lock, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, Check2, ErrorState, Field, Input, Notice, PageHeader, SkeletonRows, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

interface Role { id: number; name: string; description?: string; system: boolean; permissions: string[]; users: number }
interface Perm { key: string; group: string; label: string; description: string }

export default function Roles() {
  const { can } = useAuth();
  const toast = useToast();
  const roles = useApi<Role[]>('/roles');
  const perms = useApi<Perm[]>('/permissions');
  const [selId, setSelId] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<{ name: string; description: string; permissions: Set<string> }>({ name: '', description: '', permissions: new Set() });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [del, setDel] = useState(false);
  const manage = can('roles.manage');
  const role = typeof selId === 'number' ? roles.data?.find((r) => r.id === selId) : undefined;
  const readOnly = !manage || !!role?.system;

  useEffect(() => { if (selId === null && roles.data?.[0]) setSelId(roles.data[0].id); }, [roles.data, selId]);
  useEffect(() => {
    if (selId === 'new') setDraft({ name: '', description: '', permissions: new Set() });
    else if (role) setDraft({ name: role.name, description: role.description ?? '', permissions: new Set(role.permissions) });
    setErr('');
  }, [selId, role?.id, roles.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const m = new Map<string, Perm[]>();
    (perms.data ?? []).forEach((p) => m.set(p.group, [...(m.get(p.group) ?? []), p]));
    return [...m.entries()];
  }, [perms.data]);
  const toggle = (k: string, v: boolean) => { const s = new Set(draft.permissions); if (v) s.add(k); else s.delete(k); setDraft({ ...draft, permissions: s }); };

  async function save() {
    setBusy(true); setErr('');
    const body = { name: draft.name.trim(), description: draft.description || undefined, permissions: [...draft.permissions] };
    try {
      if (selId === 'new') { const r = await api<{ id: number }>('/roles', { body }); setSelId(r.id); toast.success('Role created'); }
      else { await api(`/roles/${selId}`, { method: 'PATCH', body }); toast.success('Role saved'); }
      roles.reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <RequirePerm perm={['roles.manage', 'users.manage']}>
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="Roles & permissions" sub="Control exactly what each group of people can do." crumbs={[{ label: 'Admin' }, { label: 'Roles' }]}
          actions={<Button variant="primary" disabled={!manage} title={manage ? '' : 'Requires roles.manage'} onClick={() => setSelId('new')}><Plus size={15} />New role</Button>} />
        {(roles.loading || perms.loading) && <div className="card"><SkeletonRows /></div>}
        {roles.error && <div className="card"><ErrorState error={roles.error} status={roles.status} onRetry={roles.reload} /></div>}
        {roles.data && (
          <div className="grid roles-grid" style={{ alignItems: 'start' }}>
            <Card flush>
              <div role="listbox" aria-label="Roles">
                {roles.data.map((r) => (
                  <button key={r.id} role="option" aria-selected={selId === r.id} className="nav-item" style={{ width: '100%', border: 0, background: selId === r.id ? 'var(--accent-soft)' : 'none', color: selId === r.id ? 'var(--accent)' : undefined, font: 'inherit', cursor: 'pointer', borderRadius: 0, padding: '12px 16px', textAlign: 'left' }} onClick={() => setSelId(r.id)}>
                    <span className="grow"><span style={{ fontWeight: 600, display: 'block' }}>{r.name}</span><span className="xs muted">{r.users} user{r.users === 1 ? '' : 's'} · {r.permissions.length} permissions</span></span>
                    {r.system && <Lock size={13} aria-label="System role" />}
                  </button>
                ))}
                {selId === 'new' && <div className="nav-item active" style={{ borderRadius: 0, padding: '12px 16px' }}>New role…</div>}
              </div>
            </Card>
            <Card title={selId === 'new' ? 'New role' : role?.name} actions={role?.system && <Badge><Lock size={11} />System role, read-only</Badge>}>
              <div className="stack">
                <Field label="Name"><Input value={draft.name} disabled={readOnly} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                <Field label="Description"><Textarea rows={2} value={draft.description} disabled={readOnly} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
                {perms.error ? <Notice tone="warn">Could not load permissions: {perms.error}</Notice> : (
                  <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
                    <legend className="lbl-t" style={{ marginBottom: 8 }}>Permissions ({draft.permissions.size})</legend>
                    {groups.map(([g, ps]) => (
                      <div key={g} className="card" style={{ background: 'var(--surface-2)' }}>
                        <div className="card-h" style={{ padding: '8px 14px' }}><h3 className="grow" style={{ textTransform: 'capitalize' }}>{g}</h3>
                          {!readOnly && <Button sm variant="ghost" onClick={() => { const s = new Set(draft.permissions); const all = ps.every((p) => s.has(p.key)); ps.forEach((p) => (all ? s.delete(p.key) : s.add(p.key))); setDraft({ ...draft, permissions: s }); }}>Toggle all</Button>}</div>
                        <div className="card-b stack sm">
                          {ps.map((p) => <div key={p.key}><Check2 checked={draft.permissions.has(p.key)} disabled={readOnly || !can(p.key)} onChange={(v) => toggle(p.key, v)}><span><b style={{ fontWeight: 600 }}>{p.label}</b> <code className="faint xs">{p.key}</code></span></Check2><div className="xs muted" style={{ marginLeft: 24 }}>{p.description}{!readOnly && !can(p.key) ? ' (you do not hold this permission)' : ''}</div></div>)}
                        </div>
                      </div>
                    ))}
                  </fieldset>
                )}
                {err && <Notice tone="error">{err}</Notice>}
                {!readOnly && (
                  <div className="row"><Button variant="primary" busy={busy} disabled={!draft.name.trim()} onClick={save}>{selId === 'new' ? 'Create role' : 'Save changes'}</Button>
                    {role && <Button variant="danger" className="end" onClick={() => setDel(true)}>Delete role</Button>}</div>
                )}
              </div>
            </Card>
          </div>
        )}
        {del && role && <ConfirmDialog title="Delete role" onClose={() => setDel(false)} onConfirm={async () => {
          try { await api(`/roles/${role.id}`, { method: 'DELETE' }); toast.success('Role deleted'); setSelId(null); roles.reload(); } catch (e) { toast.error((e as Error).message); }
          setDel(false);
        }}>Delete <b>{role.name}</b>? Roles still assigned to users cannot be deleted.</ConfirmDialog>}
      </div>
    </RequirePerm>
  );
}
