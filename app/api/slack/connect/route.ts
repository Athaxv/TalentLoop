import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/session';
import { slackClient } from '@/lib/slack/client';
import { ensureTalentLoopRuntime } from '@/lib/orchestration/runtime';

export const dynamic = 'force-dynamic';

export async function GET() {
  await ensureTalentLoopRuntime();
  let socketInit: unknown = null;
  if (slackClient.isLiveSlackConfigured()) {
    socketInit = await slackClient.ensureSocketModeStarted();
  }
  return NextResponse.json({
    ok: true,
    socketInit,
    status: slackClient.getStatus(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      return NextResponse.json(
        { ok: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const body = (await req.json()) as {
      botToken?: string;
      appToken?: string;
      channelId?: string;
    };

    const botToken = body.botToken?.trim();
    const appToken = body.appToken?.trim();
    const channelId = body.channelId?.trim();

    if (botToken) process.env.SLACK_BOT_TOKEN = botToken;
    if (appToken) process.env.SLACK_APP_TOKEN = appToken;
    if (channelId) process.env.SLACK_DEFAULT_CHANNEL_ID = channelId;

    // Persist to .env so it survives server restarts
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      if (botToken) {
        envContent = envContent.replace(
          /^SLACK_BOT_TOKEN=.*$/m,
          `SLACK_BOT_TOKEN=${botToken}`,
        );
      }
      if (appToken) {
        envContent = envContent.replace(
          /^SLACK_APP_TOKEN=.*$/m,
          `SLACK_APP_TOKEN=${appToken}`,
        );
      }
      if (channelId) {
        envContent = envContent.replace(
          /^SLACK_DEFAULT_CHANNEL_ID=.*$/m,
          `SLACK_DEFAULT_CHANNEL_ID=${channelId}`,
        );
      }
      fs.writeFileSync(envPath, envContent, 'utf8');
    }

    await ensureTalentLoopRuntime();
    const socketStatus = await slackClient.ensureSocketModeStarted();

    if (!socketStatus.connected) {
      return NextResponse.json(
        {
          ok: false,
          error: socketStatus.error || 'Could not open Slack Socket Mode connection.',
          status: slackClient.getStatus(),
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      status: slackClient.getStatus(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
