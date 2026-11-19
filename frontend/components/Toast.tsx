'use client';
import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useState } from 'react';

type T = { id: number; kind: 'success' | 'error' | 'info'; msg: string };
const Ctx = createContext<(kind: T['kind'], msg: string) => void>(() => {});
export const useToast = () => {
  const push = useContext(Ctx);
  return { success: (m: string) => push('success', m), error: (m: string) => push('error', m), info: (m: string) => push('info', m) };
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<T[]>([]);
  const push = useCallback((kind: T['kind'], msg: string) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-3), { id, kind, msg }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" role="region" aria-label="Notifications">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <div className="grow small">{t.msg}</div>
            <button className="copy" aria-label="Dismiss" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}><X size={14} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
