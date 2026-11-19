'use client';
import { Monitor } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ChangePasswordForm, TotpEnroll } from '@/components/AuthForms';
import { Modal } from '@/components/Modal';
import { Table } from '@/components/Table';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, DateTime, ErrorState, Field, Input, Notice, PageHeader, SkeletonRows, Time } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

interface S { id: number | string; current: boolean; createdAt: string; lastSeenAt: string; ip?: string; userAgent?: string }

function Profile() {
  const { me, roleName, refresh } = useAuth();
  const toast = useToast();
  const sp = useSearchParams();
  const sessions = useApi<S[]>('/auth/sessions');
  const [enrol, setEnrol] = useState(!!sp.get('enroll'));
  const [off, setOff] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="page stack" style={{ gap: 20, maxWidth: 900 }}>
      <PageHeader title="Profile & security" crumbs={[{ label: 'Account' }, { label: 'Profile & security' }]} />
      {me?.mustEnrollTotp && !me.totpEnabled && <Notice tone="warn">Your organisation requires two-factor authentication. Set it up below to continue using the platform.</Notice>}
      <Card title="Account"><dl className="kv"><dt>Name</dt><dd>{me?.name}</dd><dt>Email</dt><dd>{me?.email}</dd><dt>Role</dt><dd>{roleName}</dd><dt>Organisation</dt><dd>{me?.org?.name}</dd></dl></Card>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <Card title="Change password"><ChangePasswordForm /></Card>
        <Card title="Two-factor authentication" actions={me?.totpEnabled ? <Badge tone="good">Enabled</Badge> : <Badge>Off</Badge>}>
          <div className="stack">
            <p className="muted">Protect your account with a code from an authenticator app in addition to your password.</p>
            {me?.totpEnabled ? <div><Button variant="danger" disabled={!!me.org?.require2fa} title={me.org?.require2fa ? 'Your organisation requires 2FA' : ''} onClick={() => { setOff(true); setErr(''); setPw(''); }}>Disable 2FA</Button></div> : <div><Button variant="primary" onClick={() => setEnrol(true)}>Set up 2FA</Button></div>}
          </div>
        </Card>
      </div>
      <Card title="Active sessions" flush>
        {sessions.loading ? <SkeletonRows rows={3} /> : sessions.error ? <ErrorState error={sessions.error} status={sessions.status} onRetry={sessions.reload} /> : (
          <Table caption="Active sessions" rows={sessions.data ?? []} rowKey={(s) => s.id}
            cols={[
              { key: 'd', header: 'Device', wrap: true, cell: (s) => <span className="row nw"><Monitor size={15} className="muted" /><span className="small break">{s.userAgent ?? 'Unknown device'}</span>{s.current && <Badge tone="good">This session</Badge>}</span> },
              { key: 'i', header: 'IP', cell: (s) => <span className="mono xs">{s.ip ?? '—'}</span> },
              { key: 's', header: 'Signed in', cell: (s) => <DateTime t={s.createdAt} /> },
              { key: 'l', header: 'Last active', cell: (s) => <Time t={s.lastSeenAt} /> },
              { key: 'x', header: '', cell: (s) => !s.current && <Button sm variant="danger" onClick={async () => { try { await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }); toast.success('Session revoked'); sessions.reload(); } catch (e) { toast.error((e as Error).message); } }}>Revoke</Button> },
            ]} />
        )}
      </Card>
      {enrol && <Modal title="Set up two-factor authentication" onClose={() => setEnrol(false)}><TotpEnroll onCancel={() => setEnrol(false)} onDone={() => { setEnrol(false); toast.success('Two-factor authentication enabled'); refresh(); }} /></Modal>}
      {off && (
        <Modal title="Disable two-factor authentication" onClose={() => setOff(false)} footer={<><Button onClick={() => setOff(false)}>Cancel</Button><Button variant="solid" busy={busy} disabled={!pw} onClick={async () => {
          setBusy(true); setErr('');
          try { await api('/auth/2fa/disable', { quiet: true, body: { password: pw } }); toast.success('2FA disabled'); setOff(false); refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>Disable 2FA</Button></>}>
          <div className="stack"><Field label="Confirm your password"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>{err && <Notice tone="error">{err}</Notice>}</div>
        </Modal>
      )}
    </div>
  );
}
export default function Page() { return <Suspense><Profile /></Suspense>; }
