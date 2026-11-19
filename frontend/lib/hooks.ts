'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export interface Res<T> { data: T | undefined; error: string; status: number; loading: boolean; reload: () => void }

/** GET `path` (null = skip). Polls while `poll` returns a number of ms. */
export function useApi<T>(path: string | null, poll?: (d: T) => number | false): Res<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState(0);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  const pollRef = useRef(poll);
  pollRef.current = poll;
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let dead = false;
    let timer: ReturnType<typeof setTimeout>;
    const go = async (first: boolean) => {
      if (first) { setLoading(true); setError(''); setStatus(0); }
      try {
        const d = await api<T>(path);
        if (dead) return;
        setData(d); setError('');
        const ms = pollRef.current?.(d);
        if (ms) timer = setTimeout(() => go(false), ms);
      } catch (e) {
        if (dead) return;
        if (first) setData(undefined);
        setError((e as Error).message); setStatus(e instanceof ApiError ? e.status : 0);
      } finally {
        if (!dead) setLoading(false);
      }
    };
    go(true);
    return () => { dead = true; clearTimeout(timer); };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, status, loading, reload };
}

/** Wrap an async action with busy state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try { return await fn(); } finally { setBusy(false); }
  }, []);
  return [busy, run] as const;
}

export function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}
