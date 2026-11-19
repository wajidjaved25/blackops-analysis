'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';

export interface Me {
  id: number | string; email: string; name: string;
  role: string | { id: number | string; name: string };
  permissions?: string[]; totpEnabled?: boolean; mustEnrollTotp?: boolean; mustChangePassword?: boolean;
  org?: { id: number | string; name: string; require2fa?: boolean };
}
interface Ctx { me: Me | null; loading: boolean; can: (p: string) => boolean; roleName: string; refresh: () => Promise<void> }

const ANALYST = ['investigate.view', 'export.data', 'screen.run', 'labels.view', 'labels.manage', 'monitor.view', 'monitor.manage', 'alerts.triage', 'cases.view', 'cases.manage', 'attribution.run', 'attribution.review'];
const VIEWER = ['investigate.view', 'labels.view', 'monitor.view', 'cases.view'];

const C = createContext<Ctx>({ me: null, loading: true, can: () => false, roleName: '', refresh: async () => {} });
export const useAuth = () => useContext(C);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try { setMe(await api<Me>('/auth/me')); } catch { setMe(null); } finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);
  const v = useMemo<Ctx>(() => {
    const roleName = me ? (typeof me.role === 'string' ? me.role : me.role?.name ?? '') : '';
    const rl = roleName.toLowerCase();
    // Transition fallback: derive permissions from a legacy string role until /auth/me returns `permissions`.
    const perms = me?.permissions ?? (rl === 'admin' || rl === 'owner' ? null : rl === 'analyst' ? ANALYST : rl === 'viewer' ? VIEWER : []);
    return { me, loading, roleName, refresh, can: (p) => !!me && (perms === null || perms.includes(p)) };
  }, [me, loading]);
  return <C.Provider value={v}>{children}</C.Provider>;
}
