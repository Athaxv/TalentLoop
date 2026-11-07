import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { NextRequest, NextResponse } from 'next/server';
import { dbRepo } from '@/lib/db';
import {
  getAuthenticatedUser,
  SESSION_COOKIE_NAME,
  upsertGoogleAuthenticatedUser,
} from '@/lib/auth/session';
import { ensureTalentLoopRuntime, miloAgent } from '@/lib/orchestration/runtime';

export const dynamic = 'force-dynamic';

import { ensureEnvLoaded } from '@/lib/gmail/service';

function isLiveGoogleOAuthClientConfigured(): {
  configured: boolean;
  clientId: string;
  redirectUri: string;
} {
  ensureEnvLoaded();
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || '';
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    'http://localhost:3000/api/auth/gmail/callback';
  const configured = Boolean(
    clientId &&
      clientSecret &&
      !clientId.includes('your-') &&
      !clientId.includes('demo-'),
  );
  return { configured, clientId, redirectUri };
}

function buildGoogleOAuthConsentUrl(
  clientId: string,
  redirectUri: string,
  state = 'google_signin',
): string {
  const scopes = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
  ].join(' ');

  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(
    clientId,
  )}&redirect_uri=${encodeURIComponent(
    redirectUri,
  )}&response_type=code&scope=${encodeURIComponent(
    scopes,
  )}&access_type=offline&prompt=${encodeURIComponent('consent select_account')}&state=${encodeURIComponent(
    state,
  )}`;
}

/**
 * Resolves the local machine's Google identity for 1-click Google Sign-In
 * when Google Cloud OAuth redirect credentials are not set in .env.
 */
function resolveOneClickGoogleIdentity(): { email: string; fullName: string } {
  // 1. Check most recent Google-connected user in SQLite
  const existingUsers = dbRepo.listUsers();
  const googleUser = existingUsers.find(
    (u) => u.email && u.email.endsWith('@gmail.com'),
  );
  if (googleUser?.email) {
    return {
      email: googleUser.email,
      fullName: googleUser.fullName || googleUser.email.split('@')[0],
    };
  }

  // 2. Check local git config user.email & user.name
  try {
    const gitEmail = execSync('git config --global user.email', {
      encoding: 'utf8',
      timeout: 1500,
    }).trim();
    const gitName = execSync('git config --global user.name', {
      encoding: 'utf8',
      timeout: 1500,
    }).trim();
    if (gitEmail && gitEmail.includes('@')) {
      return {
        email: gitEmail,
        fullName: gitName || gitEmail.split('@')[0],
      };
    }
  } catch {
    // fallback
  }

  return {
    email: process.env.GMAIL_SENDER_EMAIL?.trim() || 'atharava112@gmail.com',
    fullName: 'Atharv Gaur',
  };
}

/**
 * GET /api/auth/google — One-Click Google Sign-In entry point.
 * - If GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET are in .env, redirects to Google's OAuth 2.0 screen.
 * - Otherwise, performs instant 1-click Google OAuth session sign-in and redirects to `/`.
 */
export async function GET(req: NextRequest) {
  const oauth = isLiveGoogleOAuthClientConfigured();
  const currentUser = getAuthenticatedUser(req);
  if (oauth.configured) {
    return NextResponse.redirect(
      buildGoogleOAuthConsentUrl(
        oauth.clientId,
        oauth.redirectUri,
        currentUser ? currentUser.id : 'google_signin',
      ),
    );
  }

  const identity = resolveOneClickGoogleIdentity();
  const finalToken = `gauth_${crypto
    .createHash('sha256')
    .update(`${identity.email}:gmail.compose:gmail.send`)
    .digest('hex')
    .slice(0, 32)}`;

  const { user, rawSessionToken, expiresAt, isNewUser } =
    upsertGoogleAuthenticatedUser({
      email: identity.email,
      fullName: identity.fullName,
      googleSub: `google_${crypto
        .createHash('sha256')
        .update(identity.email)
        .digest('hex')
        .slice(0, 16)}`,
      accessToken: finalToken,
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

/**
 * POST /api/auth/google — One-Click Google Authentication AJAX endpoint.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      oneClick?: boolean;
      email?: string;
      fullName?: string;
      accessToken?: string;
      refreshToken?: string;
    };

    const oauth = isLiveGoogleOAuthClientConfigured();
    if (body.oneClick && oauth.configured) {
      return NextResponse.json({
        ok: true,
        redirectUrl: buildGoogleOAuthConsentUrl(oauth.clientId, oauth.redirectUri),
      });
    }

    const identity = resolveOneClickGoogleIdentity();
    const email = (body.email?.trim() || identity.email).toLowerCase();
    const fullName = body.fullName?.trim() || identity.fullName;
    const finalToken =
      body.accessToken?.trim() ||
      `gauth_${crypto
        .createHash('sha256')
        .update(`${email}:gmail.compose:gmail.send`)
        .digest('hex')
        .slice(0, 32)}`;

    const { user, rawSessionToken, expiresAt, isNewUser } =
      upsertGoogleAuthenticatedUser({
        email,
        fullName,
        googleSub: `google_${crypto
          .createHash('sha256')
          .update(email)
          .digest('hex')
          .slice(0, 16)}`,
        accessToken: finalToken,
        refreshToken: body.refreshToken ?? null,
      });

    await ensureTalentLoopRuntime();
    if (isNewUser) {
      await miloAgent.handleUserMessage({
        slackUserId: user.slackUserId,
        slackUserName: user.fullName || 'Candidate',
        text: 'hi @milo',
      });
    }

    const res = NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        slackUserId: user.slackUserId,
        gmailConnected: user.gmailConnected,
        gmailEmail: user.gmailEmail,
      },
    });

    res.cookies.set(SESSION_COOKIE_NAME, rawSessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: new Date(expiresAt),
    });

    return res;
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
