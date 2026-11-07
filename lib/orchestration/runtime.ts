import { switchCoordinator } from '../switch/coordinator';
import { slackClient } from '../slack/client';
import { miloAgent } from '../agents/milo';
import { scoutAgent } from '../agents/scout';
import { wallyAgent } from '../agents/wally';
import { inkyAgent } from '../agents/inky';
import { cloverAgent } from '../agents/clover';
import { pipAgent } from '../agents/pip';

let handlersRegistered = false;

/**
 * Registers all 6 TalentLoop agents (`milo`, `wally`, `inky`, `scout`, `clover`, `pip`)
 * with the Switch Coordinator and starts the Slack Socket Mode listener if configured.
 */
export async function ensureTalentLoopRuntime(): Promise<{
  serverUrl: string;
  roomId: string;
  agentsOnline: string[];
}> {
  // Always bind the latest agent handlers onto the global SwitchCoordinator & SlackClient
  scoutAgent.registerWithSwitch();
  wallyAgent.registerWithSwitch();
  inkyAgent.registerWithSwitch();
  cloverAgent.registerWithSwitch();
  pipAgent.registerWithSwitch();

  slackClient.registerInboundHandler(async (msg) => {
    await miloAgent.handleUserMessage({
      slackUserId: msg.slackUserId,
      slackUserName: msg.slackUserName,
      slackChannelId: msg.slackChannelId,
      threadTs: msg.threadTs,
      text: msg.text,
      uploadedResumeText: msg.uploadedResumeText,
    });
  });

  handlersRegistered = true;

  // Start Slack Socket Mode & ensure #talentloop-onboarding exists if SLACK_BOT_TOKEN & SLACK_APP_TOKEN are present
  if (slackClient.isLiveSlackConfigured()) {
    void slackClient.ensureSocketModeStarted();
    void slackClient.ensureOnboardingChannel();
  }

  return switchCoordinator.ensureInitialized();
}

export { miloAgent, scoutAgent, wallyAgent, inkyAgent, cloverAgent, pipAgent };
