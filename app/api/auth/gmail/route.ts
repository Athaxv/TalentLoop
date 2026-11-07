import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/session';
import { gmailOutreachService } from '@/lib/gmail/service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authUser = getAuthenticatedUser(req);
  if (!authUser) {
    return NextResponse.json(
      { ok: false, error: 'Please sign in before connecting Gmail OAuth.' },
      { status: 401 },
    );
  }

  const status = gmailOutreachService.getOAuthConfigStatus(authUser.id);
  if (!status.clientConfigured) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env. Add your Google Cloud OAuth 2.0 Web Client credentials to .env to start the OAuth redirect flow, or paste a valid Google OAuth2 Access Token in Settings.',
      },
      { status: 400 },
    );
  }

  const consentUrl = gmailOutreachService.getOAuthConsentUrl(authUser.id);
  return NextResponse.redirect(consentUrl);
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      return NextResponse.json(
        { ok: false, error: 'Authentication required to configure Gmail OAuth.' },
        { status: 401 },
      );
    }

    const body = (await req.json()) as {
      action: 'connect_token' | 'disconnect';
      accessToken?: string;
      refreshToken?: string;
    };

    const db = getDb();
    const now = new Date().toISOString();

    if (body.action === 'disconnect') {
      db.prepare(`
        UPDATE users SET
          gmail_connected = 0,
          gmail_email = NULL,
          gmail_access_token = NULL,
          gmail_refresh_token = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(now, authUser.id);
      return NextResponse.json({ ok: true, connected: false });
    }

    if (body.action === 'connect_token') {
      const token = body.accessToken?.trim();
      if (!token) {
        return NextResponse.json(
          { ok: false, error: 'A valid Google OAuth2 Access Token is required.' },
          { status: 400 },
        );
      }

      const profileRes = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(6000),
        },
      );

      if (!profileRes.ok) {
        const errText = await profileRes.text().catch(() => '');
        return NextResponse.json(
          {
            ok: false,
            error: `Google Gmail API rejected the token (${profileRes.status}): ${errText.slice(0, 200)}`,
          },
          { status: 401 },
        );
      }

      const profileData = (await profileRes.json()) as { emailAddress?: string };
      const gmailEmail =
        profileData.emailAddress || authUser.email || 'authenticated@gmail.com';

      db.prepare(`
        UPDATE users SET
          gmail_connected = 1,
          gmail_email = ?,
          gmail_access_token = ?,
          gmail_refresh_token = ?,
          updated_at = ?
        WHERE id = ?
      `).run(gmailEmail, token, body.refreshToken?.trim() ?? null, now, authUser.id);

      return NextResponse.json({
        ok: true,
        connected: true,
        gmailEmail,
      });
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
