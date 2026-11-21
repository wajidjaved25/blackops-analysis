'use client';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Field, Input, Notice } from '@/components/ui';

export default function Setup() {
  const [f, setF] = useState({ orgName: '', name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ setupNeeded: boolean }>('/auth/status', { quiet: true }).then((s) => { if (!s.setupNeeded) location.replace('/login'); }).catch(() => {});
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const pwErr = f.password && f.password.length < 12 ? 'At least 12 characters' : '';
  return (
    <div className="auth-wrap">
      <form className="card auth-card stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { await api('/auth/setup', { quiet: true, body: f }); location.href = '/'; }
        catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <div className="row"><span className="logo"><ShieldCheck size={18} /></span><strong style={{ fontSize: 16 }}>Tracera</strong></div>
        <div><h1>Set up your organisation</h1><p className="muted" style={{ marginTop: 4 }}>Create the organisation and its Owner account. You can invite teammates afterwards.</p></div>
        <Field label="Organisation name"><Input value={f.orgName} onChange={set('orgName')} required autoFocus /></Field>
        <Field label="Your name"><Input value={f.name} onChange={set('name')} autoComplete="name" required /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} autoComplete="username" required /></Field>
        <Field label="Password" hint="At least 12 characters." error={pwErr}><Input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required /></Field>
        {err && <Notice tone="error">{err}</Notice>}
        <Button variant="primary" type="submit" busy={busy} disabled={!!pwErr}>Create organisation</Button>
      </form>
    </div>
  );
}
