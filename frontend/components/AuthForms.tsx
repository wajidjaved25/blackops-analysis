'use client';
import { Download } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { download } from '@/lib/format';
import { useToast } from './Toast';
import { Button, CopyButton, Field, Input, Notice } from './ui';

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const bad = next && next.length < 12 ? 'At least 12 characters' : again && again !== next ? 'Passwords do not match' : '';
  return (
    <form className="stack" onSubmit={async (e) => {
      e.preventDefault();
      if (bad || !next) return;
      setBusy(true); setErr('');
      try { await api('/auth/password', { quiet: true, body: { current: cur, next } }); toast.success('Password changed'); setCur(''); setNext(''); setAgain(''); onDone?.(); }
      catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      <Field label="Current password"><Input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
      <Field label="New password" hint="At least 12 characters, and not your email." error={next && next.length < 12 ? 'At least 12 characters' : ''}><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></Field>
      <Field label="Repeat new password" error={again && again !== next ? 'Passwords do not match' : ''}><Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></Field>
      {err && <Notice tone="error">{err}</Notice>}
      <Button variant="primary" type="submit" busy={busy} disabled={!!bad || !next || !cur}>Change password</Button>
    </form>
  );
}

/** 2FA enrolment: QR + manual secret, verify the first code, then show recovery codes once. */
export function TotpEnroll({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup', { method: 'POST' })
      .then(async (s) => { setSetup(s); setQr(await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 192 })); })
      .catch((e) => setErr((e as Error).message));
  }, []);
  if (codes) {
    const txt = codes.join('\n');
    return (
      <div className="stack">
        <Notice tone="warn">Save these recovery codes now. Each works once if you lose your authenticator. They will not be shown again.</Notice>
        <div className="codes">{codes.map((c) => <span key={c}>{c}</span>)}</div>
        <div className="row">
          <Button onClick={async () => { try { await navigator.clipboard.writeText(txt); toast.success('Copied'); } catch { toast.error('Copy failed'); } }}>Copy all</Button>
          <Button onClick={() => download('usdt-trace-recovery-codes.txt', txt, 'text/plain')}><Download size={15} />Download</Button>
          <Button variant="primary" className="end" onClick={onDone}>I saved them</Button>
        </div>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr('');
      try { const r = await api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { body: { code: code.trim() } }); setCodes(r.recoveryCodes ?? []); }
      catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      <p className="muted">1. Scan this QR code with an authenticator app (Google Authenticator, 1Password, Authy).</p>
      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        {qr ? <img src={qr} alt="Two-factor QR code" width={160} height={160} style={{ background: '#fff', borderRadius: 8, padding: 4 }} /> : <div className="skel" style={{ width: 160, height: 160 }} />}
        <div className="stack sm grow">
          <span className="muted small">Cannot scan? Enter this key manually:</span>
          {setup && <div className="row nw"><code className="break">{setup.secret}</code><CopyButton value={setup.secret} label="Copy secret" /></div>}
        </div>
      </div>
      <p className="muted">2. Enter the 6-digit code it shows.</p>
      <Field label="Verification code"><Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" required /></Field>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="row">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button variant="primary" type="submit" busy={busy} disabled={code.length !== 6 || !setup}>Verify and enable</Button>
      </div>
    </form>
  );
}
