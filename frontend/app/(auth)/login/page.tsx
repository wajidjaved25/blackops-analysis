'use client';
import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Field, Input, Notice } from '@/components/ui';

function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [step, setStep] = useState<'pw' | 'totp'>('pw');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ setupNeeded: boolean }>('/auth/status', { quiet: true }).then((s) => { if (s.setupNeeded) router.replace('/setup'); }).catch(() => {});
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api('/auth/login', { quiet: true, body: { email: email.trim(), password, ...(step === 'totp' ? { totp: totp.trim() } : {}) } });
      const next = new URLSearchParams(location.search).get('next');
      location.href = next && /^\/(?![/\\])/.test(next) ? next : '/';
    } catch (x) {
      const a = x as ApiError;
      if (a.code === 'TOTP_REQUIRED') { if (step === 'totp') setErr('That code is not valid. Try again or use a recovery code.'); setStep('totp'); }
      else if (a.code === 'USER_DISABLED') setErr('This account has been disabled. Contact your organisation administrator.');
      else if (a.status === 429) setErr('Too many attempts. Wait a few minutes and try again.');
      else setErr(a.status === 401 ? 'Incorrect email or password.' : a.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card stack" onSubmit={submit}>
        <div className="row"><span className="logo"><ShieldCheck size={18} /></span><strong style={{ fontSize: 16 }}>Tracera</strong></div>
        <div><h1>{step === 'pw' ? 'Sign in' : 'Two-factor authentication'}</h1><p className="muted" style={{ marginTop: 4 }}>{step === 'pw' ? 'Blockchain investigation and compliance platform.' : 'Enter the 6-digit code from your authenticator app, or a recovery code.'}</p></div>
        {step === 'pw' ? (
          <>
            <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
            <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          </>
        ) : (
          <Field label="Authentication code"><Input autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="123456" required autoFocus /></Field>
        )}
        {err && <Notice tone="error">{err}</Notice>}
        <Button variant="primary" type="submit" busy={busy}>{step === 'pw' ? 'Sign in' : 'Verify'}</Button>
        {step === 'totp' && <Button variant="ghost" onClick={() => { setStep('pw'); setTotp(''); setErr(''); }}>Back</Button>}
      </form>
    </div>
  );
}
export default function Page() { return <Suspense><Login /></Suspense>; }
