'use client';
import { History } from 'lucide-react';
import { useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { Table } from '@/components/Table';
import { Badge, Card, DateTime, EmptyState, ErrorState, Field, Input, PageHeader, Select, SkeletonRows } from '@/components/ui';
import { useApi } from '@/lib/hooks';

interface Row { id: number; action: string; target?: string; detail?: unknown; createdAt: string; user?: { name?: string; email?: string } | string | null; ip?: string }
const who = (u: Row['user']) => (typeof u === 'string' ? u : u?.name || u?.email || 'system');

export default function Audit() {
  const [action, setAction] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const users = useApi<{ id: number; name: string }[]>('/users');
  const qs = new URLSearchParams({ page: String(page) });
  if (action) qs.set('action', action);
  if (userId) qs.set('userId', userId);
  if (from) qs.set('from', from);
  if (to) qs.set('to', `${to}T23:59:59`);
  const { data, loading, error, status, reload } = useApi<{ rows: Row[]; total: number; pageSize: number }>(`/audit?${qs}`);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };
  return (
    <RequirePerm perm="audit.view">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader title="Audit log" sub="Who did what, and when." crumbs={[{ label: 'Admin' }, { label: 'Audit log' }]} />
        <Card flush title={<span className="row">
          <Field><Input sm style={{ width: 180 }} aria-label="Action" placeholder="Action (e.g. login)" value={action} onChange={(e) => reset(setAction)(e.target.value)} /></Field>
          <Select sm style={{ width: 160 }} aria-label="User" value={userId} onChange={(e) => reset(setUserId)(e.target.value)}><option value="">All users</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
          <Input sm type="date" aria-label="From date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
          <Input sm type="date" aria-label="To date" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
        </span>}>
          {loading ? <SkeletonRows rows={8} /> : error ? <ErrorState error={error} status={status} onRetry={reload} /> : (
            <Table caption="Audit log" rows={data?.rows ?? []} rowKey={(r) => r.id} pageSize={50} server={{ page, total: data?.total ?? data?.rows.length ?? 0, pageSize: data?.pageSize ?? 50, onPage: setPage }}
              empty={<EmptyState icon={<History size={22} />} title="No entries match" />}
              cols={[
                { key: 't', header: 'When', cell: (r) => <DateTime t={r.createdAt} /> },
                { key: 'u', header: 'User', cell: (r) => who(r.user) },
                { key: 'a', header: 'Action', cell: (r) => <Badge>{r.action}</Badge> },
                { key: 'g', header: 'Target', cell: (r) => <span className="mono small break">{r.target ?? '—'}</span>, wrap: true },
                { key: 'd', header: 'Detail', wrap: true, cell: (r) => <span className="xs muted break">{r.detail == null ? '' : typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}</span> },
                { key: 'i', header: 'IP', cell: (r) => <span className="mono xs muted">{r.ip ?? ''}</span> },
              ]} />
          )}
        </Card>
      </div>
    </RequirePerm>
  );
}
