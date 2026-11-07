process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';

import WebSocket from 'ws';
import type { AgentId } from '../db/schema';
import { AGENT_TEAM_REGISTRY } from '../agents/registry';
import { ensureEnvLoaded } from '../gmail/service';
import { extractTextFromResumeBuffer } from '../onboarding/resume-parser';

export interface SlackMessageOutboxItem {
  id: string;
  channel: string;
  threadTs: string | null;
  agentId: AgentId;
  agentDisplayName: string;
  text: string;
  blocks?: unknown[];
  slackMessageTs: string;
  sentViaSlackApi: boolean;
  timestamp: string;
}

const AGENT_AVATAR_EMOJI: Record<AgentId, string> = {
  milo: ':compass:',
  wally: ':rocket:',
  inky: ':graduation_cap:',
  scout: ':mag:',
  clover: ':four_leaf_clover:',
  pip: ':envelope_with_arrow:',
};

const globalForSlack = globalThis as unknown as {
  __talentLoopSlackClient?: SlackClient;
  __talentLoopSlackWs?: WebSocket | null;
  __talentLoopProcessedSlackMsgs?: Set<string>;
  __talentLoopPollerTimer?: ReturnType<typeof setInterval>;
  __talentLoopPollerWatermarkTs?: number;
};

const processedSlackMsgKeys =
  globalForSlack.__talentLoopProcessedSlackMsgs ??
  (globalForSlack.__talentLoopProcessedSlackMsgs = new Set<string>());

const slackOutboxHistory: SlackMessageOutboxItem[] = [];

/**
 * Slack Integration Client & Native Socket Mode Bridge
 * Supports:
 * 1. Real-Time Slack Socket Mode (`apps.connections.open` over `xapp-...` token) — works from localhost with NO public URL or ngrok needed!
 * 2. Posting each agent's message under its own name and icon (`chat:write.customize`) via `chat.postMessage`.
 * 3. Downloading and parsing PDF/TXT resumes uploaded directly in Slack (`files:read` -> `url_private_download`).
 * 4. Automatic 👀 reaction on messages while agents are working (`reactions:write`).
 */
/**
 * Converts GitHub-flavored Markdown (`**bold**`, `[label](url)`) to clean Slack `mrkdwn` (`*bold*`, `<url|label>`).
 */
export function toSlackMrkdwn(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>');
}

export class SlackClient {
  private socketModeWs: WebSocket | null = null;
  private socketModeConnected = false;
  private socketModeStarting = false;
  private lastActiveChannelId: string | null = null;
  private onboardingChannelId: string | null = null;
  private userNameCache = new Map<string, string>();
  private processedEventIds = new Set<string>();
  private inboundHandler:
    | ((params: {
        slackUserId: string;
        slackUserName: string;
        slackChannelId: string;
        threadTs: string | null;
        text: string;
        uploadedResumeText: string | null;
      }) => Promise<void>)
    | null = null;

  private getBotToken(): string | null {
    ensureEnvLoaded();
    const token = process.env.SLACK_BOT_TOKEN?.trim();
    return token &&
      token.startsWith('xoxb-') &&
      !token.includes('your-slack-bot-token')
      ? token
      : null;
  }

  private getAppToken(): string | null {
    ensureEnvLoaded();
    const token = process.env.SLACK_APP_TOKEN?.trim();
    return token &&
      token.startsWith('xapp-') &&
      !token.includes('your-slack-app-level-token')
      ? token
      : null;
  }

  private getDefaultChannel(): string {
    if (this.lastActiveChannelId) {
      return this.lastActiveChannelId;
    }
    ensureEnvLoaded();
    const envChan = process.env.SLACK_DEFAULT_CHANNEL_ID?.trim();
    if (envChan && envChan !== 'C0000000000') {
      return envChan;
    }
    return 'C_TALENTLOOP_JOB_SEARCH';
  }

  public isLiveSlackConfigured(): boolean {
    return Boolean(this.getBotToken());
  }

  public getOnboardingChannelId(): string | null {
    ensureEnvLoaded();
    return (
      this.onboardingChannelId ||
      process.env.SLACK_ONBOARDING_CHANNEL_ID?.trim() ||
      null
    );
  }

  /**
   * Ensures the shared `#talentloop-onboarding` channel exists in Slack,
   * joins the bot, sets the topic, and invites workspace members.
   */
  public async ensureOnboardingChannel(): Promise<{
    channelId: string | null;
    channelName: string;
  }> {
    const botToken = this.getBotToken();
    if (!botToken) {
      return { channelId: null, channelName: 'talentloop-onboarding' };
    }

    if (this.onboardingChannelId) {
      return {
        channelId: this.onboardingChannelId,
        channelName: 'talentloop-onboarding',
      };
    }

    try {
      const listRes = (await fetch(
        'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200',
        { headers: { Authorization: `Bearer ${botToken}` } },
      ).then((r) => r.json())) as {
        ok?: boolean;
        channels?: Array<{ id: string; name: string }>;
      };

      let channel = (listRes.channels ?? []).find(
        (c) => c.name === 'talentloop-onboarding',
      );

      if (!channel) {
        const createRes = (await fetch(
          'https://slack.com/api/conversations.create',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({
              name: 'talentloop-onboarding',
              is_private: false,
            }),
          },
        ).then((r) => r.json())) as {
          ok?: boolean;
          channel?: { id: string; name: string };
        };
        if (createRes.ok && createRes.channel) {
          channel = createRes.channel;
        }
      }

      if (channel?.id) {
        this.onboardingChannelId = channel.id;
        process.env.SLACK_ONBOARDING_CHANNEL_ID = channel.id;

        await fetch('https://slack.com/api/conversations.join', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ channel: channel.id }),
        }).catch(() => undefined);

        await fetch('https://slack.com/api/conversations.setTopic', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel: channel.id,
            topic:
              '👋 Welcome to TalentLoop! Complete your onboarding with @milo here (Resume PDF + Portfolio + Preferences + Gmail OAuth) to unlock your personal #talentloop-job-search channel.',
          }),
        }).catch(() => undefined);

        // Invite human workspace members to #talentloop-onboarding
        const usersRes = (await fetch('https://slack.com/api/users.list', {
          headers: { Authorization: `Bearer ${botToken}` },
        }).then((r) => r.json())) as {
          members?: Array<{ id: string; is_bot?: boolean; deleted?: boolean }>;
        };
        const humanIds = (usersRes.members ?? [])
          .filter((m) => !m.is_bot && m.id !== 'USLACKBOT' && !m.deleted)
          .map((m) => m.id);

        if (humanIds.length > 0) {
          await fetch('https://slack.com/api/conversations.invite', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({
              channel: channel.id,
              users: humanIds.join(','),
            }),
          }).catch(() => undefined);
        }

        return { channelId: channel.id, channelName: channel.name };
      }
    } catch {
      // ignore error
    }

    return { channelId: null, channelName: 'talentloop-onboarding' };
  }

  /**
   * Provisions a dedicated per-user `#talentloop-job-search-<username>` Slack channel
   * once the user completes onboarding in `#talentloop-onboarding`, invites ONLY that user
   * and the TalentLoop Switch bot, and sets their personalized channel topic.
   */
  public async provisionUserJobSearchChannel(params: {
    slackUserId: string;
    fullName: string;
    preferredRoles: string[];
    skills: string[];
  }): Promise<{ channelId: string; channelName: string }> {
    const botToken = this.getBotToken();
    const rawSlug = params.fullName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 18);
    const userSlug =
      rawSlug || params.slackUserId.toLowerCase().slice(-6);
    const desiredName = `talentloop-job-search-${userSlug}`;

    if (!botToken) {
      return {
        channelId: `C_PERSONAL_${params.slackUserId}`,
        channelName: desiredName,
      };
    }

    try {
      const listRes = (await fetch(
        'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200',
        { headers: { Authorization: `Bearer ${botToken}` } },
      ).then((r) => r.json())) as {
        ok?: boolean;
        channels?: Array<{ id: string; name: string }>;
      };

      let channel = (listRes.channels ?? []).find(
        (c) => c.name === desiredName,
      );

      if (!channel) {
        const createRes = (await fetch(
          'https://slack.com/api/conversations.create',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({
              name: desiredName,
              is_private: false,
            }),
          },
        ).then((r) => r.json())) as {
          ok?: boolean;
          channel?: { id: string; name: string };
        };
        if (createRes.ok && createRes.channel) {
          channel = createRes.channel;
        }
      }

      if (!channel) {
        // Fallback to main talentloop-job-search channel if creation failed
        channel = (listRes.channels ?? []).find(
          (c) => c.name === 'talentloop-job-search',
        );
      }

      if (channel?.id) {
        await fetch('https://slack.com/api/conversations.join', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ channel: channel.id }),
        }).catch(() => undefined);

        if (params.slackUserId.startsWith('U')) {
          await fetch('https://slack.com/api/conversations.invite', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({
              channel: channel.id,
              users: params.slackUserId,
            }),
          }).catch(() => undefined);
        }

        const topicText = `🚀 Personal AI Job Search Room for ${params.fullName} | Target Roles: ${params.preferredRoles.slice(0, 3).join(', ')} | Skills: ${params.skills.slice(0, 5).join(', ')} | Agents: @milo @scout @wally @inky @clover @pip`;
        await fetch('https://slack.com/api/conversations.setTopic', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel: channel.id,
            topic: topicText.slice(0, 245),
          }),
        }).catch(() => undefined);

        return { channelId: channel.id, channelName: channel.name };
      }
    } catch {
      // fallback
    }

    return {
      channelId: this.getDefaultChannel(),
      channelName: desiredName,
    };
  }

  public getStatus(): {
    botTokenConfigured: boolean;
    appTokenConfigured: boolean;
    socketModeConnected: boolean;
    activeChannelId: string | null;
    onboardingChannelId: string | null;
  } {
    return {
      botTokenConfigured: Boolean(this.getBotToken()),
      appTokenConfigured: Boolean(this.getAppToken()),
      socketModeConnected: this.socketModeConnected,
      activeChannelId: this.lastActiveChannelId || this.getDefaultChannel(),
      onboardingChannelId: this.getOnboardingChannelId(),
    };
  }

  public registerInboundHandler(
    handler: NonNullable<SlackClient['inboundHandler']>,
  ): void {
    this.inboundHandler = handler;
    this.startHistoryCatchUpPoller();
  }

  /**
   * Starts a lightweight 3-second channel history catch-up poller alongside Socket Mode
   * so that even if a Socket Mode WebSocket drops or reconnects during a Next.js hot-reload,
   * zero Slack user messages are ever missed!
   */
  private startHistoryCatchUpPoller(): void {
    if (globalForSlack.__talentLoopPollerTimer) return;
    if (!globalForSlack.__talentLoopPollerWatermarkTs) {
      globalForSlack.__talentLoopPollerWatermarkTs = Date.now() / 1000 - 5;
    }

    const timer = setInterval(() => {
      void this.pollRecentChannelMessages();
    }, 3000);
    timer.unref?.();
    globalForSlack.__talentLoopPollerTimer = timer;
  }

  private async pollRecentChannelMessages(): Promise<void> {
    const botToken = this.getBotToken();
    if (!botToken || !this.inboundHandler) return;

    const channelsToWatch = [
      ...new Set(
        [
          this.lastActiveChannelId,
          'C0CFPRBLH46',
          process.env.SLACK_DEFAULT_CHANNEL_ID?.trim(),
          process.env.SLACK_ONBOARDING_CHANNEL_ID?.trim(),
        ].filter((c): c is string => Boolean(c && c.startsWith('C'))),
      ),
    ];

    const oldestTs = String(
      (globalForSlack.__talentLoopPollerWatermarkTs ?? Date.now() / 1000 - 10).toFixed(6),
    );

    for (const channelId of channelsToWatch) {
      try {
        const res = await fetch(
          `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
            channelId,
          )}&oldest=${oldestTs}&limit=5`,
          {
            headers: { Authorization: `Bearer ${botToken}` },
            signal: AbortSignal.timeout(2500),
          },
        );
        const data = (await res.json()) as {
          ok?: boolean;
          messages?: Array<{
            type?: string;
            subtype?: string;
            bot_id?: string;
            app_id?: string;
            user?: string;
            text?: string;
            ts?: string;
            thread_ts?: string;
            client_msg_id?: string;
          }>;
        };
        if (!data.ok || !Array.isArray(data.messages)) continue;

        for (const msg of [...data.messages].reverse()) {
          if (
            msg.bot_id ||
            msg.app_id ||
            msg.user === 'U0CF9S27XSB' ||
            msg.subtype ||
            !msg.user ||
            !msg.ts
          ) {
            continue;
          }

          const tsNum = Number(msg.ts);
          if (tsNum > (globalForSlack.__talentLoopPollerWatermarkTs ?? 0)) {
            globalForSlack.__talentLoopPollerWatermarkTs = tsNum;
          }

          const dedupKey = `${channelId}:${msg.client_msg_id || msg.ts}`;
          const tsKey = `${channelId}:${msg.ts}`;
          if (
            processedSlackMsgKeys.has(dedupKey) ||
            processedSlackMsgKeys.has(tsKey)
          ) {
            continue;
          }
          processedSlackMsgKeys.add(dedupKey);
          processedSlackMsgKeys.add(tsKey);

          await this.handleSocketModeFrame(
            this.socketModeWs as WebSocket,
            JSON.stringify({
              type: 'events_api',
              payload: {
                event: {
                  type: 'message',
                  user: msg.user,
                  text: msg.text || '',
                  channel: channelId,
                  ts: msg.ts,
                  thread_ts: msg.thread_ts,
                  client_msg_id: msg.client_msg_id,
                },
              },
            }),
          );
        }
      } catch {
        // ignore transient poll error
      }
    }
  }

  /**
   * Starts the Slack Socket Mode WebSocket connection (`POST https://slack.com/api/apps.connections.open`)
   * so real Slack messages reach TalentLoop on localhost without ngrok or a public webhook URL.
   */
  public async ensureSocketModeStarted(): Promise<{
    connected: boolean;
    error?: string;
  }> {
    const appToken = this.getAppToken();
    const botToken = this.getBotToken();
    if (!appToken || !botToken) {
      return {
        connected: false,
        error: 'SLACK_BOT_TOKEN (xoxb-...) and SLACK_APP_TOKEN (xapp-...) are required for Socket Mode.',
      };
    }

    if (
      this.socketModeConnected &&
      this.socketModeWs &&
      this.socketModeWs.readyState === WebSocket.OPEN
    ) {
      return { connected: true };
    }

    if (this.socketModeStarting) {
      return { connected: this.socketModeConnected };
    }

    this.socketModeStarting = true;
    try {
      const res = await fetch('https://slack.com/api/apps.connections.open', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      const data = (await res.json()) as {
        ok?: boolean;
        url?: string;
        error?: string;
      };

      if (!data.ok || !data.url) {
        this.socketModeStarting = false;
        return {
          connected: false,
          error: `Slack apps.connections.open failed: ${data.error || 'unknown_error'}`,
        };
      }

      // Close any stale Socket Mode WebSocket left over from a previous Next.js hot-reload
      if (globalForSlack.__talentLoopSlackWs && globalForSlack.__talentLoopSlackWs !== this.socketModeWs) {
        try {
          globalForSlack.__talentLoopSlackWs.removeAllListeners();
          globalForSlack.__talentLoopSlackWs.terminate();
        } catch {
          // ignore
        }
        globalForSlack.__talentLoopSlackWs = null;
      }

      if (this.socketModeWs) {
        try {
          this.socketModeWs.removeAllListeners();
          this.socketModeWs.terminate();
        } catch {
          // ignore
        }
      }

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(data.url!);
        this.socketModeWs = ws;
        globalForSlack.__talentLoopSlackWs = ws;

        ws.once('open', () => {
          this.socketModeConnected = true;
          this.socketModeStarting = false;
          resolve();
        });

        ws.once('error', (err) => {
          this.socketModeConnected = false;
          this.socketModeStarting = false;
          reject(err);
        });

        ws.on('message', (raw) => {
          void this.handleSocketModeFrame(ws, raw.toString());
        });

        ws.on('close', () => {
          this.socketModeConnected = false;
          this.socketModeStarting = false;
          // Auto-reconnect after 5s if tokens are still configured
          setTimeout(() => {
            if (this.getAppToken() && this.getBotToken()) {
              void this.ensureSocketModeStarted();
            }
          }, 5000).unref?.();
        });
      });

      return { connected: true };
    } catch (err) {
      this.socketModeStarting = false;
      this.socketModeConnected = false;
      return { connected: false, error: (err as Error).message };
    }
  }

  private async handleSocketModeFrame(
    ws: WebSocket,
    rawText: string,
  ): Promise<void> {
    try {
      const frame = JSON.parse(rawText) as {
        envelope_id?: string;
        type?: string;
        payload?: {
          event_id?: string;
          event?: {
            type?: string;
            subtype?: string;
            bot_id?: string;
            user?: string;
            text?: string;
            channel?: string;
            ts?: string;
            thread_ts?: string;
            files?: Array<{
              id: string;
              name: string;
              mimetype: string;
              size: number;
              url_private_download?: string;
              url_private?: string;
            }>;
          };
          // Slash commands support
          command?: string;
          user_id?: string;
          user_name?: string;
          channel_id?: string;
          text?: string;
        };
      };

      // 1. Always ACK the envelope_id immediately to Slack
      if (frame.envelope_id && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
      }

      if (frame.type === 'disconnect') {
        ws.close();
        return;
      }

      // Handle Interactive Block Kit Button Clicks (`✅ Approve & Send via Gmail` / `❌ Reject Draft`)
      if (frame.type === 'interactive' && frame.payload) {
        const interactivePayload = frame.payload as unknown as {
          type?: string;
          user?: { id?: string; username?: string; name?: string };
          channel?: { id?: string };
          message?: { ts?: string };
          actions?: Array<{ action_id?: string; value?: string }>;
        };

        if (
          interactivePayload.type === 'block_actions' &&
          Array.isArray(interactivePayload.actions) &&
          interactivePayload.actions.length > 0
        ) {
          const action = interactivePayload.actions[0];
          const actionId = action.action_id || '';
          const draftId = action.value || actionId.split(':')[1] || '';
          const clickUserId = interactivePayload.user?.id || 'U_SLACK_USER';
          const channelId =
            interactivePayload.channel?.id || this.getDefaultChannel();
          const messageTs = interactivePayload.message?.ts;

          if (actionId.startsWith('tl_approve_draft:') && draftId) {
            if (messageTs) {
              await this.updateAgentMessage({
                channel: channelId,
                ts: messageTs,
                text: `⏳ *Sending email draft \`${draftId}\` via Google Gmail API...*`,
                blocks: [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `⏳ *Sending email draft \`${draftId}\` via Google Gmail API...*`,
                    },
                  },
                ],
              });
            }

            const { pipAgent } = await import('../agents/pip');
            const sendOutcome = await pipAgent.approveAndSendSingleDraft({
              draftId,
              decidedBySlackUserId: clickUserId,
            });

            if (messageTs) {
              if (sendOutcome.ok) {
                await this.updateAgentMessage({
                  channel: channelId,
                  ts: messageTs,
                  text: `✅ *Sent via Gmail!* — *To:* ${sendOutcome.recipientName} <${sendOutcome.recipientEmail}> (*${sendOutcome.companyName}*)\n*Subject:* \`${sendOutcome.subject}\` · *Gmail ID:* \`${sendOutcome.gmailMessageId}\` · Approved by <@${clickUserId}>`,
                  blocks: [
                    {
                      type: 'section',
                      text: {
                        type: 'mrkdwn',
                        text: `✅ *Email Sent via Gmail!* (\`${draftId}\`)\n*To:* *${sendOutcome.recipientName}* <${sendOutcome.recipientEmail}> · *${sendOutcome.companyName}*\n*Subject:* \`${sendOutcome.subject}\`\n*Gmail Message ID:* \`${sendOutcome.gmailMessageId}\` · Approved by <@${clickUserId}>`,
                      },
                    },
                  ],
                });
              } else {
                await this.updateAgentMessage({
                  channel: channelId,
                  ts: messageTs,
                  text: `⚠️ *Could not send draft \`${draftId}\`:* ${sendOutcome.error}`,
                });
              }
            }
            return;
          }

          if (actionId.startsWith('tl_reject_draft:') && draftId) {
            const { pipAgent } = await import('../agents/pip');
            const rejOutcome = pipAgent.rejectSingleDraft({
              draftId,
              decidedBySlackUserId: clickUserId,
            });

            if (messageTs) {
              await this.updateAgentMessage({
                channel: channelId,
                ts: messageTs,
                text: `🚫 *Draft Rejected / Skipped* — *To:* ${rejOutcome.recipientName} <${rejOutcome.recipientEmail}> (*${rejOutcome.companyName}*) · Rejected by <@${clickUserId}>`,
                blocks: [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `🚫 *Draft Rejected / Skipped* (\`${draftId}\`)\n*To:* ${rejOutcome.recipientName} <${rejOutcome.recipientEmail}> (*${rejOutcome.companyName}*)\n*Subject:* \`${rejOutcome.subject}\` · Skipped by <@${clickUserId}>`,
                    },
                  },
                ],
              });
            }
            return;
          }
        }
      }

      const eventId = frame.payload?.event_id || frame.envelope_id;
      if (eventId) {
        if (this.processedEventIds.has(eventId)) return;
        this.processedEventIds.add(eventId);
        if (this.processedEventIds.size > 500) {
          const first = this.processedEventIds.values().next().value;
          if (first) this.processedEventIds.delete(first);
        }
      }

      // 2. Handle Event API messages (`message.channels`, `message.groups`, `message.im`)
      const ev = frame.payload?.event;
      if (ev && ev.type === 'message') {
        // Ignore bot's own messages (including chat:write.customize messages from our own bot user ID) to prevent loops
        if (
          ev.bot_id ||
          (ev as { app_id?: string }).app_id ||
          ev.user === 'U0CF9S27XSB' ||
          ev.subtype === 'bot_message' ||
          ev.subtype === 'message_changed' ||
          ev.subtype === 'message_deleted' ||
          ev.subtype === 'channel_join'
        ) {
          return;
        }

        if (!ev.user || !ev.channel) return;

        const msgDedupKey = `${ev.channel}:${(ev as { client_msg_id?: string }).client_msg_id || ev.ts || ''}`;
        const tsDedupKey = `${ev.channel}:${ev.ts || ''}`;
        if (
          processedSlackMsgKeys.has(msgDedupKey) ||
          (ev.ts && processedSlackMsgKeys.has(tsDedupKey))
        ) {
          return;
        }
        processedSlackMsgKeys.add(msgDedupKey);
        if (ev.ts) processedSlackMsgKeys.add(tsDedupKey);

        this.lastActiveChannelId = ev.channel;

        const botToken = this.getBotToken();

        // Add 👀 reaction while working (per Switch Slack spec)
        if (botToken && ev.ts) {
          void fetch('https://slack.com/api/reactions.add', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({
              channel: ev.channel,
              timestamp: ev.ts,
              name: 'eyes',
            }),
          }).catch(() => undefined);
        }

        // Check if user uploaded a PDF / TXT resume in Slack
        let uploadedResumeText: string | null = null;
        if (botToken && Array.isArray(ev.files) && ev.files.length > 0) {
          const file = ev.files[0];
          const downloadUrl = file.url_private_download || file.url_private;
          if (downloadUrl) {
            try {
              const fileRes = await fetch(downloadUrl, {
                headers: { Authorization: `Bearer ${botToken}` },
              });
              if (fileRes.ok) {
                const buf = Buffer.from(await fileRes.arrayBuffer());
                const extracted = await extractTextFromResumeBuffer(
                  buf,
                  file.name || 'resume.pdf',
                  file.mimetype,
                );
                uploadedResumeText = extracted.text;
              }
            } catch {
              // ignore file download failure
            }
          }
        }

        // Resolve user display name from memory cache first (0ms latency)
        let userName = this.userNameCache.get(ev.user) || ev.user;
        if (!this.userNameCache.has(ev.user) && botToken) {
          void fetch(
            `https://slack.com/api/users.info?user=${encodeURIComponent(ev.user)}`,
            { headers: { Authorization: `Bearer ${botToken}` } },
          )
            .then((r) => r.json())
            .then((uData: { ok?: boolean; user?: { real_name?: string; name?: string } }) => {
              if (uData.ok && uData.user) {
                this.userNameCache.set(
                  ev.user!,
                  uData.user.real_name || uData.user.name || ev.user!,
                );
              }
            })
            .catch(() => undefined);
        }

        // Clean Slack <@U...> bot mention prefixes while keeping @scout, @wally, @inky, @clover, @pip
        const cleanText = (ev.text || '')
          .replace(/^<@[A-Z0-9]+>\s*/i, '')
          .trim();

        if (this.inboundHandler) {
          await this.inboundHandler({
            slackUserId: ev.user,
            slackUserName: userName,
            slackChannelId: ev.channel,
            threadTs: ev.thread_ts || null,
            text: cleanText || (uploadedResumeText ? 'Uploaded resume' : 'hi'),
            uploadedResumeText,
          });
        }
      }
    } catch {
      // ignore malformed frame
    }
  }

  public async postAgentMessage(params: {
    agentId: AgentId;
    text: string;
    channel?: string | null;
    threadTs?: string | null;
    blocks?: unknown[];
  }): Promise<SlackMessageOutboxItem> {
    const agentDef = AGENT_TEAM_REGISTRY[params.agentId];
    const botToken = this.getBotToken();
    const channel =
      params.channel && params.channel !== 'C_TALENTLOOP_JOB_SEARCH'
        ? params.channel
        : this.getDefaultChannel();

    const now = new Date().toISOString();
    let slackMessageTs = `${Math.floor(Date.now() / 1000)}.${String(
      slackOutboxHistory.length + 100,
    ).padStart(6, '0')}`;
    let sentViaSlackApi = false;

    if (botToken && channel !== 'C_TALENTLOOP_JOB_SEARCH') {
      try {
        const formattedText = toSlackMrkdwn(params.text);
        const res = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel,
            text: formattedText,
            username: agentDef.displayName,
            icon_emoji: AGENT_AVATAR_EMOJI[params.agentId],
            unfurl_links: false,
            unfurl_media: false,
            ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
            ...(params.blocks ? { blocks: params.blocks } : {}),
          }),
        });
        const data = (await res.json()) as { ok?: boolean; ts?: string };
        if (data.ok && data.ts) {
          slackMessageTs = data.ts;
          sentViaSlackApi = true;
        }
      } catch {
        // Fallback to local outbox record
      }
    }

    const item: SlackMessageOutboxItem = {
      id: `slk_${Date.now()}_${slackOutboxHistory.length + 1}`,
      channel,
      threadTs: params.threadTs ?? null,
      agentId: params.agentId,
      agentDisplayName: agentDef.displayName,
      text: params.text,
      blocks: params.blocks,
      slackMessageTs,
      sentViaSlackApi,
      timestamp: now,
    };

    slackOutboxHistory.push(item);
    if (slackOutboxHistory.length > 500) {
      slackOutboxHistory.shift();
    }

    return item;
  }

  /**
   * Updates an existing Slack message in-place (`chat.update`) for live loading/progress indicators.
   */
  public async updateAgentMessage(params: {
    channel?: string | null;
    ts: string;
    text: string;
    blocks?: unknown[];
  }): Promise<void> {
    const botToken = this.getBotToken();
    const channel =
      params.channel && params.channel !== 'C_TALENTLOOP_JOB_SEARCH'
        ? params.channel
        : this.getDefaultChannel();

    const existing = slackOutboxHistory.find((m) => m.slackMessageTs === params.ts);
    if (existing) {
      existing.text = params.text;
      if (params.blocks) existing.blocks = params.blocks;
    }

    if (botToken && channel !== 'C_TALENTLOOP_JOB_SEARCH') {
      try {
        await fetch('https://slack.com/api/chat.update', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel,
            ts: params.ts,
            text: toSlackMrkdwn(params.text),
            unfurl_links: false,
            unfurl_media: false,
            ...(params.blocks ? { blocks: params.blocks } : {}),
          }),
        });
      } catch {
        // ignore update error
      }
    }
  }

  public getOutboxMessages(limit = 100): SlackMessageOutboxItem[] {
    return slackOutboxHistory.slice(-limit);
  }

  public clearOutbox(): void {
    slackOutboxHistory.length = 0;
  }
}

if (globalForSlack.__talentLoopSlackClient) {
  Object.setPrototypeOf(
    globalForSlack.__talentLoopSlackClient,
    SlackClient.prototype,
  );
}

export const slackClient =
  globalForSlack.__talentLoopSlackClient ??
  (globalForSlack.__talentLoopSlackClient = new SlackClient());
