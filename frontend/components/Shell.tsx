'use client';
import { Activity, Bell, Briefcase, ChevronDown, Fingerprint, FolderKanban, History, KeyRound, LayoutDashboard, LogOut, Menu, Moon, Network, PanelLeft, ScanSearch, Search, ShieldCheck, Sun, Tag, UserCog, Users, Building2, X, Eye } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { detectChain, detectTx } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ChangePasswordForm } from './AuthForms';
import { useToast } from './Toast';
import { Button, cx, Notice } from './ui';

interface Item { href: string; label: string; icon: React.ReactNode; perm?: string | string[]; badge?: boolean }
const NAV: { group: string; items: Item[] }[] = [
  { group: 'Investigate', items: [
    { href: '/', label: 'Dashboard', icon: <LayoutDashboard size={18} /> },
    { href: '/graph', label: 'Search & graph', icon: <Network size={18} />, perm: 'investigate.view' },
  ] },
  { group: 'Compliance', items: [
    { href: '/screening', label: 'Screening', icon: <ScanSearch size={18} />, perm: 'investigate.view' },
    { href: '/monitoring', label: 'Monitoring', icon: <Eye size={18} />, perm: 'monitor.view' },
    { href: '/alerts', label: 'Alerts', icon: <Bell size={18} />, perm: 'monitor.view', badge: true },
  ] },
  { group: 'Casework', items: [{ href: '/cases', label: 'Cases', icon: <Briefcase size={18} />, perm: 'cases.view' }] },
  { group: 'Intelligence', items: [
    { href: '/labels', label: 'Labels', icon: <Tag size={18} />, perm: 'labels.view' },
    { href: '/attribution', label: 'Attribution', icon: <Fingerprint size={18} />, perm: ['attribution.run', 'attribution.review'] },
  ] },
  { group: 'Admin', items: [
    { href: '/admin/users', label: 'Users', icon: <Users size={18} />, perm: 'users.manage' },
    { href: '/admin/roles', label: 'Roles', icon: <UserCog size={18} />, perm: ['roles.manage', 'users.manage'] },
    { href: '/admin/api-keys', label: 'API keys', icon: <KeyRound size={18} />, perm: 'apikeys.manage' },
    { href: '/admin/audit', label: 'Audit log', icon: <History size={18} />, perm: 'audit.view' },
    { href: '/admin/notifications', label: 'Notifications', icon: <Activity size={18} />, perm: 'notify.manage' },
    { href: '/admin/org', label: 'Organisation', icon: <Building2 size={18} />, perm: 'org.manage' },
  ] },
];

function applyTheme(t: 'dark' | 'light') {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch { /* storage blocked */ }
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { me, loading, can, roleName } = useAuth();
  const path = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [q, setQ] = useState('');
  const [qErr, setQErr] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const alerts = useApi<{ total: number }>(can('monitor.view') ? '/alerts?status=open' : null, () => 60000);

  useEffect(() => { try { setCollapsed(localStorage.getItem('nav') === '1'); } catch { /* */ } }, []);
  useEffect(() => { setDrawer(false); setMenu(false); }, [path]);
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [menu]);
  useEffect(() => {
    if (me?.mustEnrollTotp && !me.totpEnabled && !path.startsWith('/profile')) router.replace('/profile?enroll=1');
  }, [me, path, router]);

  if (loading) return <div className="auth-wrap" role="status" aria-label="Loading"><div className="skel" style={{ width: 160, height: 12 }} /></div>;
  if (!me) {
    return <div className="auth-wrap"><div className="card auth-card stack"><h1>Could not load your session</h1><p className="muted">The server did not return your account. Try again, or sign in again.</p><div className="row"><Button variant="primary" onClick={() => location.reload()}>Retry</Button><Button onClick={() => { location.href = '/login'; }}>Sign in</Button></div></div></div>;
  }
  if (me.mustChangePassword) {
    return (
      <div className="auth-wrap"><div className="card auth-card stack">
        <h1>Choose a new password</h1>
        <Notice tone="warn">An administrator set a temporary password for your account. Set your own to continue.</Notice>
        <ChangePasswordForm onDone={() => location.reload()} />
      </div></div>
    );
  }

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    const tx = detectTx(v);
    if (detectChain(v)) router.push(`/address/${v}`);
    else if (tx) router.push(`/tx/${tx}/${v}`);
    else { setQErr('Not a valid address or tx hash'); return; }
    setQ(''); setQErr('');
  };
  const dark = () => document.documentElement.dataset.theme !== 'light';
  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* already out */ }
    toast.info('Signed out');
    location.href = '/login';
  };
  const open = alerts.data?.total ?? 0;
  const active = (h: string) => (h === '/' ? path === '/' : path === h || path.startsWith(h + '/') || (h === '/graph' && (path.startsWith('/address') || path.startsWith('/tx'))));

  return (
    <div className={cx('app', collapsed && 'collapsed', drawer && 'drawer-open')}>
      {drawer && <div className="scrim only-sm" style={{ zIndex: 25 }} onClick={() => setDrawer(false)} />}
      <aside className="sidebar" aria-label="Main navigation">
        <Link href="/" className="brand"><span className="logo"><ShieldCheck size={18} /></span><span className="lbl hide-collapsed" style={collapsed ? { display: 'none' } : undefined}>USDT Trace</span></Link>
        <nav className="nav">
          {NAV.map((g) => {
            const items = g.items.filter((i) => !i.perm || (Array.isArray(i.perm) ? i.perm : [i.perm]).some(can));
            if (!items.length) return null;
            return (
              <div key={g.group}>
                <div className="nav-group">{g.group}</div>
                {items.map((i) => (
                  <Link key={i.href} href={i.href} className={cx('nav-item', active(i.href) && 'active')} aria-current={active(i.href) ? 'page' : undefined} title={i.label}>
                    {i.icon}<span className="lbl">{i.label}</span>
                    {i.badge && open > 0 && <span className="nav-badge" aria-label={`${open} open alerts`}>{open > 99 ? '99+' : open}</span>}
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="side-foot hide-sm">
          <button className="nav-item" style={{ width: '100%', background: 'none', border: 0, font: 'inherit', cursor: 'pointer' }} onClick={() => setCollapsed((c) => { try { localStorage.setItem('nav', c ? '0' : '1'); } catch { /* */ } return !c; })} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <PanelLeft size={18} /><span className="lbl">Collapse</span>
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar no-print">
          <Button variant="ghost" icon className="only-sm" aria-label="Open navigation" onClick={() => setDrawer(true)}><Menu size={18} /></Button>
          <form className="gsearch" onSubmit={search} role="search">
            <Search size={15} aria-hidden />
            <input className="input" value={q} onChange={(e) => { setQ(e.target.value); setQErr(''); }} placeholder="Search address or tx hash…" aria-label="Search address or transaction hash" aria-invalid={!!qErr} spellCheck={false} />
            {qErr && <span className="small bad" role="alert" style={{ position: 'absolute', top: 38, left: 4 }}>{qErr}</span>}
          </form>
          <span className="grow" />
          <Button variant="ghost" icon aria-label="Toggle light/dark theme" onClick={() => applyTheme(dark() ? 'light' : 'dark')}>
            <Sun size={17} className="theme-ico-dark" /><Moon size={17} className="theme-ico-light" />
          </Button>
          <div style={{ position: 'relative' }} ref={menuRef}>
            <button className="btn ghost" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} style={{ gap: 9, padding: '0 8px' }}>
              <span className="logo" style={{ width: 26, height: 26, borderRadius: 13, fontSize: 12, fontWeight: 700 }}>{(me?.name || me?.email || '?').slice(0, 1).toUpperCase()}</span>
              <span className="hide-sm" style={{ textAlign: 'left', lineHeight: 1.2 }}><span style={{ display: 'block', fontSize: 13 }}>{me?.name}</span><span className="muted xs">{roleName}</span></span>
              <ChevronDown size={14} className="hide-sm" />
            </button>
            {menu && (
              <div className="menu" role="menu">
                <div style={{ padding: '8px 10px' }}><div style={{ fontWeight: 600 }}>{me?.name}</div><div className="muted xs break">{me?.email}</div><div className="muted xs">{roleName}{me?.org ? ` · ${me.org.name}` : ''}</div></div>
                <hr />
                <Link href="/profile" role="menuitem"><ShieldCheck size={15} />Profile &amp; security</Link>
                <button role="menuitem" onClick={logout}><LogOut size={15} />Sign out</button>
              </div>
            )}
          </div>
        </header>
        <main id="main">{children}</main>
      </div>
      {drawer && <button className="btn icon ghost only-sm" style={{ position: 'fixed', top: 10, left: 280, zIndex: 35, color: '#fff' }} aria-label="Close navigation" onClick={() => setDrawer(false)}><X size={18} /></button>}
    </div>
  );
}
