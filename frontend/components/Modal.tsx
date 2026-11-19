'use client';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Focus trap + Escape + restore focus. Shared by Modal and Drawer. */
function useTrap(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); }
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const ov = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ov; prev?.focus?.(); };
  }, []);
  return ref;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const ref = useTrap(onClose);
  return createPortal(
    <div className="modal-wrap">
      <div className="scrim" onClick={onClose} />
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-h"><h2 className="grow">{title}</h2><Button variant="ghost" icon sm aria-label="Close dialog" onClick={onClose}><X size={16} /></Button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useTrap(onClose);
  return createPortal(
    <div className="drawer-wrap">
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-h"><h2 className="grow">{title}</h2><Button variant="ghost" icon sm aria-label="Close panel" onClick={onClose}><X size={16} /></Button></div>
        <div className="modal-b" style={{ flex: 1 }}>{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ title, children, confirmLabel = 'Delete', busy, onConfirm, onClose, danger = true }: { title: string; children: React.ReactNode; confirmLabel?: string; busy?: boolean; onConfirm: () => void; onClose: () => void; danger?: boolean }) {
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose} data-autofocus>Cancel</Button><Button variant={danger ? 'solid' : 'primary'} busy={busy} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <div className="muted">{children}</div>
    </Modal>
  );
}
