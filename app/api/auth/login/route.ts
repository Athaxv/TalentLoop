import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateUserAccount,
  SESSION_COOKIE_NAME,
} from '@/lib/auth/session';
import { ensureTalentLoopRuntime } from '@/lib/orchestration/runtime';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      email?: string;
      password?: string;
    };

    const { user, rawSessionToken, expiresAt } = authenticateUserAccount({
      email: body.email ?? '',
      password: body.password ?? '',
    });

    await ensureTalentLoopRuntime();

    const res = NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        slackUserId: user.slackUserId,
        roleSelection: user.roleSelection,
        onboardingStage: user.onboardingStage,
        onboardingCompleted: user.onboardingCompleted,
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
      { status: 401 },
    );
  }
}
