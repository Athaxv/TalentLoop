import { NextRequest, NextResponse } from 'next/server';
import { getDb, dbRepo } from '@/lib/db';
import {
  SESSION_COOKIE_NAME,
  upsertGoogleAuthenticatedUser,
} from '@/lib/auth/session';
import { ensureTalentLoopRuntime, miloAgent } from '@/lib/orchestration/runtime';

import { ensureEnvLoaded } from '@/lib/gmail/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/gmail/callback — Handles Google OAuth 2.0 callback for BOTH:
 * 1. Google Sign-In (`state === 'google_signin'`) -> creates/logs in user, sets `tl_session` cookie, and connects Gmail
 * 2. Linking Gmail to an existing logged-in user (`state === <userId>`)
 */
export async function GET(req: NextRequest) {
  ensureEnvLoaded();
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(
      new URL(`/?auth_error=${encodeURIComponent(error)}`, req.url),
    );
  }

  if (!code) {
    return NextResponse.json(
      { ok: false, error: 'Missing authorization code from Google OAuth callback.' },
      { status: 400 },
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    'http://localhost:3000/api/auth/gmail/callback';

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      {
        ok: false,
        error: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured in .env.',
      },
      { status: 500 },
    );
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => '');
    return NextResponse.redirect(
      new URL(
        `/?auth_error=${encodeURIComponent(`Google token exchange failed: ${errBody.slice(0, 120)}`)}`,
        req.url,
      ),
    );
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
  };

  // Fetch user profile from Google UserInfo + Gmail API
  const userInfoRes = await fetch(
    'https://www.googleapis.com/oauth2/v3/userinfo',
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  );
  const userInfo = userInfoRes.ok
    ? ((await userInfoRes.json()) as { email?: string; name?: string; sub?: string })
    : {};

  const gmailProfileRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  );
  const gmailProfile = gmailProfileRes.ok
    ? ((await gmailProfileRes.json()) as { emailAddress?: string })
    : {};

  const resolvedEmail =
    userInfo.email || gmailProfile.emailAddress || 'user@gmail.com';
  const resolvedName =
    userInfo.name || resolvedEmail.split('@')[0] || 'Candidate';

  // Case 1: Google Sign-In flow (creates or signs in user + issues session cookie)
  if (!state || state === 'google_signin') {
    const { user, rawSessionToken, expiresAt, isNewUser } =
      upsertGoogleAuthenticatedUser({
        email: resolvedEmail,
        fullName: resolvedName,
        googleSub: userInfo.sub,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
      });

    await ensureTalentLoopRuntime();
    if (isNewUser) {
      await miloAgent.handleUserMessage({
        slackUserId: user.slackUserId,
        slackUserName: user.fullName || 'Candidate',
        text: 'hi @milo',
      });
    }

    const res = NextResponse.redirect(new URL('/?google_signed_in=1', req.url));
    res.cookies.set(SESSION_COOKIE_NAME, rawSessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: new Date(expiresAt),
    });
    return res;
  }

  // Case 2: Linking Gmail to existing user account (`state === userId`)
  const targetUser = dbRepo.getUserById(state);
  if (targetUser) {
    const now = new Date().toISOString();
    getDb()
      .prepare(`
        UPDATE users SET
          gmail_connected = 1,
          gmail_email = ?,
          gmail_access_token = ?,
          gmail_refresh_token = COALESCE(?, gmail_refresh_token),
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        resolvedEmail,
        tokens.access_token,
        tokens.refresh_token ?? null,
        now,
        targetUser.id,
      );

    // Notify the user directly in Slack that their Gmail OAuth2 account is now connected!
    const { slackClient } = await import('@/lib/slack/client');
    const notifyChan =
      targetUser.dedicatedSlackChannelId ||
      slackClient.getOnboardingChannelId() ||
      undefined;
    await slackClient.postAgentMessage({
      agentId: 'pip',
      channel: notifyChan,
      text: `✅ *Gmail OAuth 2.0 Connected!* (<@${targetUser.slackUserId}>)\nYour Google account (*${resolvedEmail}*) is now authorized for *@pip*. Whenever you approve an outreach batch, @pip will send directly from your Gmail account.`,
    });
  }

  return NextResponse.redirect(new URL('/?gmail_connected=1', req.url));
}
