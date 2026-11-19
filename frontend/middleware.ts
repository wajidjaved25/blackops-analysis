import { NextResponse, type NextRequest } from 'next/server';

// Cheap gate: no session cookie -> /login. The API still enforces everything; a stale cookie is handled by the 401 redirect.
export function middleware(req: NextRequest) {
  if (req.cookies.has('sid')) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/((?!login|setup|api|_next|favicon.ico).*)'] };
