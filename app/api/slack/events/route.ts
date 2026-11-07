import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/session';
import { ensureTalentLoopRuntime, miloAgent } from '@/lib/orchestration/runtime';
import { slackClient } from '@/lib/slack/client';
import { switchCoordinator } from '@/lib/switch/coordinator';

export const dynamic = 'force-dynamic';

/**
 * Slack Events API & Authenticated Interactive Chat Endpoint
 * - External Slack webhooks (`url_verification`, `event_callback`) authenticate via Slack event payload.
 * - Direct messages from the TalentLoop web console strictly require an authenticated user session (`tl_session`).
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      type?: string;
      challenge?: string;
      event?: {
        type?: string;
        subtype?: string;
        bot_id?: string;
        user?: string;
        text?: string;
        channel?: string;
        thread_ts?: string;
        ts?: string;
      };
      text?: string;
      uploadedResumeText?: string;
      channel?: string;
      threadTs?: string;
    };

    // 1. Slack URL Verification Challenge
    if (body.type === 'url_verification' && body.challenge) {
      return NextResponse.json({ challenge: body.challenge });
    }

    await ensureTalentLoopRuntime();

    // 2. External Slack Event Callback
    if (body.type === 'event_callback' && body.event) {
      const ev = body.event;
      if (ev.bot_id || ev.subtype === 'bot_message') {
        return NextResponse.json({ ok: true, ignored: 'bot_message' });
      }

      if (ev.type === 'app_home_opened' && ev.user) {
        const res = await miloAgent.handleUserMessage({
          slackUserId: ev.user,
          slackUserName: ev.user,
          slackChannelId: ev.channel ?? null,
          text: 'hi',
        });
        return NextResponse.json({ ok: true, result: res });
      }

      if (ev.type === 'message' && ev.user && typeof ev.text === 'string') {
        const res = await miloAgent.handleUserMessage({
          slackUserId: ev.user,
          slackUserName: ev.user,
          slackChannelId: ev.channel ?? null,
          threadTs: ev.thread_ts ?? null,
          text: ev.text,
        });
        return NextResponse.json({ ok: true, result: res });
      }

      return NextResponse.json({ ok: true });
    }

    // 3. Direct message from the TalentLoop web console — MUST BE AUTHENTICATED!
    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Authentication Required: Please sign in to your TalentLoop account before talking to @milo or using any agents.',
        },
        { status: 401 },
      );
    }

    const result = await miloAgent.handleUserMessage({
      slackUserId: authUser.slackUserId,
      slackUserName: authUser.fullName || authUser.email || 'Candidate',
      slackChannelId: body.channel ?? 'C_TALENTLOOP_JOB_SEARCH',
      threadTs: body.threadTs ?? null,
      text: body.text ?? '',
      uploadedResumeText: body.uploadedResumeText ?? null,
    });

    return NextResponse.json({
      ok: true,
      result,
      slackOutbox: slackClient.getOutboxMessages(30),
      switchTranscript: switchCoordinator.getRoomTranscript().slice(-30),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const authUser = getAuthenticatedUser(req);
  if (!authUser) {
    return NextResponse.json(
      { ok: false, error: 'Authentication required' },
      { status: 401 },
    );
  }
  await ensureTalentLoopRuntime();
  return NextResponse.json({
    ok: true,
    slackOutbox: slackClient.getOutboxMessages(100),
    switchTranscript: switchCoordinator.getRoomTranscript().slice(-100),
  });
}
