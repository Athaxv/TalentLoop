import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return NextResponse.json({ ok: true, authenticated: false, user: null });
  }

  return NextResponse.json({
    ok: true,
    authenticated: true,
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      slackUserId: user.slackUserId,
      roleSelection: user.roleSelection,
      onboardingStage: user.onboardingStage,
      onboardingCompleted: user.onboardingCompleted,
      gmailConnected: user.gmailConnected,
      gmailEmail: user.gmailEmail,
    },
  });
}
