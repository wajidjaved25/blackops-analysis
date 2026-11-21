'use client';
// Saved analysis scopes (Phase 10C): named, reusable scopes per case. Applying one fills the scope form; a run that uses it unchanged sends `scopeId`.
import { Bookmark, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { buildScope, EMPTY_SCOPE, ScopeForm } from '@/components/AnalysisScope';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';

export interface SavedScope { id: number; name: string; description: string; scope: Record<string, unknown>; inScope: number | null; total: number }
export const NAME_MAX = 80, DESC_MAX = 500;

export const useSavedScopes = (caseId: string) => useApi<SavedScope[]>(`/cases/${caseId}/scopes`);

/** Scope JSON -> form (the reverse of buildScope). Dates come back as whole days in the scope's own timezone. */
export function scopeToForm(s: Record<string, unknown>): ScopeForm {
  if (s.mode === 'selected') return { ...EMPTY_SCOPE, choose: true, selectedIds: s.transactionIds as number[] };
  const tzMin = typeof s.tzMin === 'number' ? s.tzMin : 0;
  const day = (iso: unknown) => (typeof iso === 'string' ? new Date(Date.parse(iso) + tzMin * 60_000).toISOString().slice(0, 10) : '');
  const list = <T,>(k: string) => (Array.isArray(s[k]) ? (s[k] as T[]) : []);
  return {
    ...EMPTY_SCOPE, choose: true, from: day(s.from), to: day(s.to), tz: s.from || s.to ? String(tzMin / 60) : '',
    statuses: list('statuses'), chains: list('chains'), assets: list('assets'), fileIds: list('fileIds'), pasted: s.pasted === true, wallets: list('wallets'),
    min: typeof s.minAmount === 'number' ? String(s.minAmount) : '', max: typeof s.maxAmount === 'number' ? String(s.maxAmount) : '', direction: (s.direction as ScopeForm['direction']) ?? '',
  };
}

const canon = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${k}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v));

/** The saved scope the form still equals exactly (editing a filter after applying one makes it an ordinary, unsaved scope). */
export function savedMatch(f: ScopeForm, list: SavedScope[] | undefined): SavedScope | undefined {
  if (!f.savedId) return undefined;
  const body = buildScope(f);
  const s = list?.find((x) => x.id === f.savedId);
  return s && body && canon(s.scope) === canon({ mode: 'all', ...body }) ? s : undefined;
}

/** Name + description form shared by "save" and "edit". */
function ScopeDialog({ title, summary, initial, confirm, onClose, onSubmit }: { title: string; summary?: string; initial?: { name: string; description: string }; confirm: string; onClose: () => void; onSubmit: (v: { name: string; description: string }) => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await onSubmit({ name: name.trim(), description: description.trim() }); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!name.trim()} onClick={go}>{confirm}</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) void go(); }}>
        {summary && <p className="small muted" style={{ margin: 0 }}>{summary}</p>}
        <Field label="Name" error={err} hint={`${name.trim().length} / ${NAME_MAX}`}><Input aria-label="Scope name" data-autofocus maxLength={NAME_MAX} placeholder="For example: Night withdrawals" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description (optional)" hint={`${description.length} / ${DESC_MAX}`}><Textarea aria-label="Scope description" rows={3} maxLength={DESC_MAX} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Saves a scope (filters or selected rows). Used by the scope form and by the Transactions tab. */
export function SaveScopeDialog({ caseId, scope, summary, onClose, onSaved }: { caseId: string; scope: Record<string, unknown>; summary: string; onClose: () => void; onSaved: (s: SavedScope) => void }) {
  const toast = useToast();
  return (
    <ScopeDialog title="Save scope" summary={summary} confirm="Save scope" onClose={onClose} onSubmit={async (v) => {
      const s = await api<SavedScope>(`/cases/${caseId}/scopes`, { body: { ...v, scope } });
      toast.success(`Scope "${s.name}" saved`); onSaved(s);
    }} />
  );
}

/** Saved-scopes picker for the scope form: apply, save the current scope, rename / edit the description, delete. Writes need cases.manage. */
export function SavedScopesBar({ caseId, f, setF, list, reload, manage, summary }: { caseId: string; f: ScopeForm; setF: (f: ScopeForm) => void; list: ReturnType<typeof useSavedScopes>; reload: () => void; manage: boolean; summary: string }) {
  const toast = useToast();
  const [dlg, setDlg] = useState<'save' | 'edit' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = list.data ?? [];
  const cur = savedMatch(f, list.data);
  const body = buildScope(f);
  const apply = (v: string) => {
    const s = saved.find((x) => x.id === Number(v));
    setF(s ? { ...scopeToForm(s.scope), savedId: s.id } : { ...f, savedId: null });
  };
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }} data-testid="saved-scopes">
      <Bookmark size={14} aria-hidden />
      <Select sm aria-label="Saved scopes" style={{ width: 'min(100%, 320px)' }} value={cur?.id ?? ''} disabled={list.loading && !list.data} onChange={(e) => apply(e.target.value)}>
        <option value="">{saved.length ? 'Saved scopes…' : 'No saved scopes yet'}</option>
        {saved.map((s) => <option key={s.id} value={s.id}>{s.name}{s.inScope === null ? ' (needs review)' : ` (${s.inScope} of ${s.total})`}</option>)}
      </Select>
      {manage && <Button sm disabled={!f.choose || !body} title={f.choose && body ? '' : 'Choose filters or transactions first'} onClick={() => setDlg('save')}>Save this scope…</Button>}
      {manage && cur && <Button sm variant="ghost" onClick={() => setDlg('edit')}><Pencil size={13} />Rename / description</Button>}
      {manage && cur && <Button sm variant="ghost" aria-label={`Delete saved scope ${cur.name}`} onClick={() => setDlg('delete')}><Trash2 size={13} />Delete</Button>}
      {cur?.description && <span className="small muted" style={{ flexBasis: '100%' }}>{cur.description}</span>}
      {list.error && <span className="small" style={{ color: 'var(--high)' }}>{list.error}</span>}
      {dlg === 'save' && body && <SaveScopeDialog caseId={caseId} scope={body} summary={summary} onClose={() => setDlg(null)} onSaved={(s) => { reload(); setF({ ...f, savedId: s.id }); }} />}
      {dlg === 'edit' && cur && <ScopeDialog title="Rename saved scope" initial={cur} confirm="Save" onClose={() => setDlg(null)} onSubmit={async (v) => { await api(`/case-scopes/${cur.id}`, { method: 'PATCH', body: v }); toast.success('Saved scope updated'); reload(); }} />}
      {dlg === 'delete' && cur && (
        <ConfirmDialog title="Delete saved scope" busy={busy} onClose={() => setDlg(null)} onConfirm={async () => {
          setBusy(true);
          try { await api(`/case-scopes/${cur.id}`, { method: 'DELETE' }); toast.success('Saved scope deleted'); setF({ ...f, savedId: null }); reload(); setDlg(null); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
        }}>Delete <b>{cur.name}</b>? Analyses that already used it keep their own copy of the scope.</ConfirmDialog>
      )}
    </div>
  );
}
