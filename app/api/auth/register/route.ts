import { NextRequest, NextResponse } from 'next/server';
import {
  registerUserAccount,
  SESSION_COOKIE_NAME,
} from '@/lib/auth/session';
import { ensureTalentLoopRuntime, miloAgent } from '@/lib/orchestration/runtime';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      fullName?: string;
      email?: string;
      password?: string;
      slackUserId?: string;
    };

    const { user, rawSessionToken, expiresAt } = registerUserAccount({
      fullName: body.fullName ?? '',
      email: body.email ?? '',
      password: body.password ?? '',
      slackUserId: body.slackUserId,
    });

    await ensureTalentLoopRuntime();

    // Milo automatically greets the newly registered user in the Switch room / Slack channel
    await miloAgent.handleUserMessage({
      slackUserId: user.slackUserId,
      slackUserName: user.fullName || 'Candidate',
      text: 'hi @milo',
    });

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
      { status: 400 },
    );
  }
}
