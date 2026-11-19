export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

interface Opts {
  method?: string;
  body?: unknown;
  form?: FormData;
  /** Do not redirect to /login on 401 (used by the login form itself). */
  quiet?: boolean;
}

/** Fetch JSON from our API (path without the /api prefix). Throws ApiError with the backend's message. */
export async function api<T = unknown>(path: string, o: Opts = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api${path}`, {
      method: o.method ?? (o.body !== undefined || o.form ? 'POST' : 'GET'),
      headers: o.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: o.form ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  }
  const text = await r.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { message: text }; }
  if (r.status === 401 && !o.quiet && typeof window !== 'undefined' && !location.pathname.startsWith('/login') && j?.code !== 'TOTP_REQUIRED') {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  if (!r.ok) {
    const m = j?.message;
    throw new ApiError(Array.isArray(m) ? m.join(', ') : m ?? (r.status === 404 ? 'Not available yet (404)' : `Request failed (HTTP ${r.status})`), r.status, j?.code);
  }
  return j as T;
}
