import { NextRequest, NextResponse } from 'next/server';
import {
  revokeSessionToken,
  SESSION_COOKIE_NAME,
} from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    revokeSessionToken(token);
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE_NAME);
  return res;
}
