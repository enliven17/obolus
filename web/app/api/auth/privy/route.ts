// POST /api/auth/privy
// Privy login'den sonra frontend buraya access token gönderir.
// Backend'e Privy user bilgisiyle oturum açar, HttpOnly session cookie set eder.

import { NextResponse, type NextRequest } from 'next/server';
import { getBackendBaseUrl } from '@/app/lib/admin-session';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { accessToken?: string; email?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { accessToken, email } = body;
  if (!accessToken || !email) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  // Backend'e Privy token + email göndererek session al
  let upstream: Response;
  try {
    upstream = await fetch(`${getBackendBaseUrl()}/auth/privy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ accessToken, email }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return NextResponse.json({ error: 'backend_unavailable' }, { status: 502 });
  }

  const data = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    return NextResponse.json(data, { status: upstream.status });
  }

  // Backend'den gelen Set-Cookie header'ını forward et
  const res = NextResponse.json(data, { status: 200 });
  const setCookie = upstream.headers.get('set-cookie');
  if (setCookie) {
    res.headers.set('set-cookie', setCookie);
  }
  return res;
}
