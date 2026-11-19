'use client';
import { useEffect, useState } from 'react';
import { RequirePerm } from '@/components/Guard';
import { useToast } from '@/components/Toast';
import { Button, Card, ErrorState, Field, Input, Notice, PageHeader, SkeletonRows, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

interface Org { name: string; require2fa: boolean; sessionDays: number }

export default function OrgPage() {
  const toast = useToast();
  const { refresh } = useAuth();
  const { data, loading, error, status, reload } = useApi<Org>('/org');
  const [f, setF] = useState<Org | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setF(data); }, [data]);
  const bad = f && (f.sessionDays < 1 || f.sessionDays > 90) ? 'Between 1 and 90 days' : '';
  return (
    <RequirePerm perm="org.manage">
      <div className="page stack" style={{ gap: 20, maxWidth: 720 }}>
        <PageHeader title="Organisation" sub="Settings that apply to everyone in your organisation." crumbs={[{ label: 'Admin' }, { label: 'Organisation' }]} />
        {loading && <div className="card"><SkeletonRows /></div>}
        {error && <div className="card"><ErrorState error={error} status={status} onRetry={reload} /></div>}
        {f && (
          <Card>
            <form className="stack" onSubmit={async (e) => {
              e.preventDefault(); setBusy(true);
              try { await api('/org', { method: 'PATCH', body: { name: f.name.trim(), require2fa: f.require2fa, sessionDays: Number(f.sessionDays) } }); toast.success('Settings saved'); refresh(); reload(); } catch (x) { toast.error((x as Error).message); } finally { setBusy(false); }
            }}>
              <Field label="Organisation name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
              <div className="row nw" style={{ alignItems: 'flex-start' }}>
                <Switch label="Require two-factor authentication" checked={f.require2fa} onChange={(v) => setF({ ...f, require2fa: v })} />
                <div><div style={{ fontWeight: 600 }}>Require two-factor authentication</div><div className="muted small">Everyone must enrol an authenticator app at next sign-in.</div></div>
              </div>
              {f.require2fa && !data?.require2fa && <Notice tone="warn">Users without 2FA will be forced to set it up the next time they sign in.</Notice>}
              <Field label="Session lifetime (days)" hint="How long someone stays signed in. 1–90." error={bad}><Input type="number" min={1} max={90} style={{ width: 120 }} value={f.sessionDays} onChange={(e) => setF({ ...f, sessionDays: Number(e.target.value) })} /></Field>
              <div><Button variant="primary" type="submit" busy={busy} disabled={!!bad || !f.name.trim()}>Save changes</Button></div>
            </form>
          </Card>
        )}
      </div>
    </RequirePerm>
  );
}
