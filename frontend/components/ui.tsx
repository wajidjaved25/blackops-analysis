'use client';
import { AlertTriangle, Check, ChevronRight, Copy, Info, Loader2, XCircle, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { createContext, useContext, useId, useState } from 'react';
import { exact, ago } from '@/lib/format';

export function cx(...a: (string | false | null | undefined)[]) { return a.filter(Boolean).join(' '); }

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost' | 'solid'; sm?: boolean; icon?: boolean; busy?: boolean };
export function Button({ variant, sm, icon, busy, className, children, disabled, type = 'button', ...p }: BtnProps) {
  return (
    <button type={type} disabled={disabled || busy} className={cx('btn', variant === 'primary' && 'primary', variant === 'danger' && 'danger', variant === 'solid' && 'danger solid', variant === 'ghost' && 'ghost', sm && 'sm', icon && 'icon', className)} {...p}>
      {busy ? <Loader2 size={15} className="spin" aria-hidden /> : null}
      {children}
    </button>
  );
}
export function LinkButton({ href, variant, sm, children, disabled, className, ...p }: { href: string; variant?: 'primary' | 'ghost'; sm?: boolean; disabled?: boolean; className?: string; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return <Link href={href} aria-disabled={disabled} tabIndex={disabled ? -1 : undefined} className={cx('btn', variant === 'primary' && 'primary', variant === 'ghost' && 'ghost', sm && 'sm', className)} style={disabled ? { pointerEvents: 'none', opacity: .5 } : undefined} {...p}>{children}</Link>;
}

const FieldCtx = createContext<{ id: string; invalid: boolean }>({ id: '', invalid: false });
export function Field({ label, error, hint, children, className }: { label?: string; error?: string; hint?: string; children: React.ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx('field', className)}>
      {label && <label htmlFor={id}>{label}</label>}
      <FieldCtx.Provider value={{ id, invalid: !!error }}>{children}</FieldCtx.Provider>
      {error ? <span className="err" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
export function Input({ className, sm, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { sm?: boolean }) {
  const f = useContext(FieldCtx);
  return <input id={f.id || undefined} aria-invalid={f.invalid || undefined} className={cx('input', sm && 'sm', className)} {...p} />;
}
export function Textarea({ className, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const f = useContext(FieldCtx);
  return <textarea id={f.id || undefined} aria-invalid={f.invalid || undefined} className={cx('input', className)} {...p} />;
}
export function Select({ className, sm, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement> & { sm?: boolean }) {
  const f = useContext(FieldCtx);
  return <select id={f.id || undefined} className={cx('select', sm && 'sm', className)} {...p}>{children}</select>;
}
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="switch" onClick={() => onChange(!checked)} />;
}
export function Check2({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children?: React.ReactNode; disabled?: boolean }) {
  return <label className="check"><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />{children}</label>;
}

export function Card({ title, actions, children, flush, className, id }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; flush?: boolean; className?: string; id?: string }) {
  return (
    <section className={cx('card', className)} id={id}>
      {(title || actions) && <div className="card-h"><h2 className="grow">{title}</h2>{actions}</div>}
      <div className={cx('card-b', flush && 'flush')}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, icon, href, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon?: React.ReactNode; href?: string; tone?: string }) {
  const body = (
    <>
      <div className="k">{icon}{label}</div>
      <div className="v" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="s">{sub}</div>}
    </>
  );
  return href ? <Link href={href} className="card stat">{body}</Link> : <div className="card stat">{body}</div>;
}

export function Badge({ tone, children, title }: { tone?: 'severe' | 'high' | 'medium' | 'low' | 'good' | 'info' | 'accent' | 'outline'; children: React.ReactNode; title?: string }) {
  return <span className={cx('badge', tone)} title={title}>{children}</span>;
}

export function Skeleton({ w, h, className }: { w?: number | string; h?: number; className?: string }) {
  return <div className={cx('skel', className)} style={{ width: w, height: h }} aria-hidden />;
}
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 16 }} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={16} w={`${90 - (i * 7) % 35}%`} />)}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="ico" aria-hidden>{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: React.ReactNode; action?: React.ReactNode }) {
  const I = tone === 'error' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'success' ? CheckCircle2 : Info;
  return <div className={cx('alert', tone)} role={tone === 'error' ? 'alert' : 'status'}><I size={16} aria-hidden /><div className="grow">{children}</div>{action}</div>;
}

/** Inline error block for a failed fetch; 404 is shown as "not available yet" (backend transition). */
export function ErrorState({ error, status, onRetry }: { error: string; status?: number; onRetry?: () => void }) {
  return (
    <EmptyState icon={<AlertTriangle size={22} />} title={status === 404 ? 'Not available yet' : status === 403 ? 'No permission' : 'Something went wrong'}
      action={onRetry && <Button sm onClick={onRetry}>Try again</Button>}>{error}</EmptyState>
  );
}

export interface Crumb { label: string; href?: string }
export function PageHeader({ title, sub, crumbs, actions }: { title: React.ReactNode; sub?: React.ReactNode; crumbs?: Crumb[]; actions?: React.ReactNode }) {
  return (
    <header>
      {crumbs && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} className="row" style={{ gap: 6 }}>
              {c.href ? <Link href={c.href}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
              {i < crumbs.length - 1 && <ChevronRight size={13} aria-hidden />}
            </span>
          ))}
        </nav>
      )}
      <div className="page-head">
        <div className="grow" style={{ minWidth: 220 }}><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </header>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={value === t.id} aria-controls={`panel-${t.id}`} className="tab" onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.id === value);
            if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length].id);
            if (e.key === 'ArrowLeft') onChange(tabs[(i - 1 + tabs.length) % tabs.length].id);
          }}>
          {t.label}{t.count !== undefined && <Badge>{t.count}</Badge>}
        </button>
      ))}
    </div>
  );
}
export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return <div className="seg" role="group" aria-label={label}>{options.map((o) => <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>)}</div>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="copy" aria-label={`${label} ${value}`} title={label} onClick={async (e) => {
      e.preventDefault(); e.stopPropagation();
      try { await navigator.clipboard.writeText(value); } catch { /* clipboard blocked */ }
      setOk(true); setTimeout(() => setOk(false), 1200);
    }}>{ok ? <Check size={14} /> : <Copy size={14} />}</button>
  );
}

/** Relative time with the exact value on hover. */
export function Time({ t }: { t: number | string | null | undefined }) {
  if (!t) return <span className="faint">—</span>;
  const iso = new Date(t).toISOString();
  return <time dateTime={iso} title={exact(t)}>{ago(t)}</time>;
}
export function DateTime({ t }: { t: number | string | null | undefined }) {
  if (!t) return <span className="faint">—</span>;
  return <time dateTime={new Date(t).toISOString()} title={exact(t)}>{new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>;
}

export function Spinner({ label }: { label?: string }) {
  return <span className="row muted small" role="status"><Loader2 size={15} className="spin" aria-hidden />{label}</span>;
}
