import type { NextFunction, Request, Response } from 'express';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const allowed = () => (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);

/**
 * CSRF defence for cookie auth, on top of SameSite=Lax. State-changing requests must
 *  1. be JSON or multipart (a cross-site <form> can only send urlencoded/text/plain), and
 *  2. come from our own origin when the browser says where they come from (Origin header; Sec-Fetch-Site).
 * Non-browser clients (curl, API keys) send no Origin and pass.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  const fail = (status: number, message: string) => res.status(status).json({ statusCode: status, message, error: status === 415 ? 'Unsupported Media Type' : 'Forbidden' });

  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || !!req.headers['transfer-encoding'];
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (hasBody && type !== 'application/json' && type !== 'multipart/form-data') return fail(415, 'Send JSON (Content-Type: application/json)');

  if (req.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Cross-site requests are not allowed');
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      return fail(403, 'Bad Origin header');
    }
    const mine = [req.headers['x-forwarded-host'], req.headers.host].flat().filter(Boolean).map(String);
    if (!mine.includes(host) && !allowed().includes(origin)) return fail(403, 'Cross-origin requests are not allowed');
  } else if (origin === 'null') return fail(403, 'Cross-origin requests are not allowed');
  next();
}
