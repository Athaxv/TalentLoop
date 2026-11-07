import crypto from 'node:crypto';
import { dbRepo, getDb } from '../db';
import {
  WallyTaskInputSchema,
  WallyTaskOutputSchema,
  type DelegatedTaskEnvelope,
} from './contracts';
import { switchCoordinator } from '../switch/coordinator';
import { localCompanionService } from '../companion/service';
import { slackClient } from '../slack/client';
import {
  analyzeTurnWithTeammateBrain,
  resolveActiveUserFromSwitchSender,
} from './teammate-brain';
import { buildCandidateContext } from '../onboarding/profile-sync';

function friendlyWellfoundSkipMessage(
  code: string,
  rawReason: string | null,
): string {
  if (code === 'skipped_ineligible') {
    return rawReason?.replace(/^Profile filter:\s*/i, '') || 'Did not match target role filter';
  }
  if (code === 'skipped_mandatory_fields') {
    return 'Requires answering a custom founder question on Wellfound';
  }
  if (code === 'skipped_captcha') {
    return 'CAPTCHA verification required on Wellfound';
  }
  if (code === 'skipped_external') {
    return 'Redirects to an external company career site';
  }
  if (code === 'skipped_rate_limited') {
    return 'Wellfound active application limit reached';
  }
  return rawReason || 'Requires manual review on Wellfound';
}

/**
 * Agent 2: Wally — Wellfound Application Specialist
 * Shows a live loading indicator in Slack while running crawlJob's Wellfound adapter
 * and replaces it with a clean, readable summary including manual-apply links for skipped jobs.
 */
export class WallyAgent {
  public registerWithSwitch(): void {
    switchCoordinator.registerAgentHandler(
      'wally',
      async ({ parsedTaskEnvelope, message }) => {
        if (
          parsedTaskEnvelope &&
          parsedTaskEnvelope.taskType === 'APPLY_WELLFOUND_BATCH'
        ) {
          await this.executeWellfoundTask(parsedTaskEnvelope, message.thread_id);
          return;
        }

        if (!parsedTaskEnvelope && message.sender.startsWith('@switch-user-')) {
          await this.handleDirectSwitchConversation(message);
        }
      },
    );
  }

  private async handleDirectSwitchConversation(message: {
    sender: string;
    sender_name: string;
    body: string;
    thread_id: string | null;
  }): Promise<void> {
    const user = resolveActiveUserFromSwitchSender(message.sender);
    if (!user) return;

    const candidateContext = buildCandidateContext(user.id);
    const channelId = user.dedicatedSlackChannelId || undefined;
    const recentRoomMessages = switchCoordinator
      .getRoomTranscript()
      .slice(-8)
      .map((m) => ({ senderName: m.senderName, body: m.body }));

    const brain = await analyzeTurnWithTeammateBrain({
      agentId: 'wally',
      senderName: message.sender_name,
      messageText: message.body,
      candidateContext,
      recentRoomMessages,
    });

    if (brain.intent === 'CHAT_CONVERSATION' || !candidateContext) {
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'wally',
        content: brain.conversationalReply,
        slackChannelId: channelId,
        threadId: message.thread_id,
      });
      return;
    }

    const wf = dbRepo.createWorkflow({
      userId: user.id,
      title: `Wally Wellfound Run`,
      naturalLanguageRequest: message.body,
      switchRoomId: switchCoordinator.getRoomId(),
      slackChannelId: channelId ?? null,
      slackThreadTs: message.thread_id,
    });

    const taskRec = dbRepo.createAgentTask({
      workflowId: wf.id,
      requestingAgent: 'wally',
      assignedAgent: 'wally',
      userId: user.id,
      taskType: 'APPLY_WELLFOUND_BATCH',
      input: { jobs: [], applicationAgentMode: 'auto-submit' },
      candidateContext,
      expectedOutput: 'WallyTaskOutputSchema',
    });

    const approval = dbRepo.createApproval({
      workflowId: wf.id,
      taskId: taskRec.taskId,
      userId: user.id,
      actionType: 'BATCH_APPLICATION',
      requestedByAgent: 'milo',
      targetAgent: 'wally',
      title: 'Direct Wellfound Run (@wally)',
      summaryText: message.body,
      payload: { jobs: [], applicationAgentMode: 'auto-submit' },
    });

    dbRepo.decideApproval({
      approvalId: approval.id,
      status: 'APPROVED',
      decidedBySlackUserId: user.slackUserId,
      decisionNote: 'Direct @wally command in Switch room',
    });

    await this.executeWellfoundTask(
      {
        taskId: taskRec.taskId,
        workflowId: wf.id,
        requestingAgent: 'wally',
        assignedAgent: 'wally',
        userId: user.id,
        taskType: 'APPLY_WELLFOUND_BATCH',
        input: {
          approvalId: approval.id,
          jobs: [],
          applicationAgentMode: 'auto-submit',
        },
        candidateContext,
        expectedOutput: 'WallyTaskOutputSchema',
        status: 'IN_PROGRESS',
        createdAt: taskRec.createdAt,
        updatedAt: taskRec.updatedAt,
      },
      message.thread_id,
    );
  }

  public async executeWellfoundTask(
    envelope: DelegatedTaskEnvelope,
    threadId?: string | null,
  ): Promise<void> {
    const { taskId, workflowId, userId, candidateContext } = envelope;

    const wf = dbRepo.getWorkflow(workflowId);
    const targetSlackChannel = wf?.slackChannelId || undefined;

    const loadingMsg = await slackClient.postAgentMessage({
      agentId: 'wally',
      channel: targetSlackChannel,
      threadTs: threadId,
      text: `⏳ *Wally is launching your local browser on Wellfound and screening unapplied roles for ${candidateContext.fullName} (${candidateContext.preferredRoles.slice(0, 3).join(', ')})...*`,
    });

    try {
      const input = WallyTaskInputSchema.parse(envelope.input);

      const approval = dbRepo.getApproval(input.approvalId);
      if (
        !approval ||
        (approval.status !== 'APPROVED' && approval.status !== 'EDITED')
      ) {
        await slackClient.updateAgentMessage({
          ts: loadingMsg.slackMessageTs,
          text: `⏸️ *Waiting for approval (\`${input.approvalId}\`) before running Wellfound automation.*`,
        });
        return;
      }

      const outcomes = await localCompanionService.executeWellfoundBatch({
        userId,
        taskId,
        candidateContext,
        jobs: input.jobs,
      });

      const db = getDb();
      const now = new Date().toISOString();

      let verifiedApplied = 0;
      let alreadyApplied = 0;
      let skippedCount = 0;
      let failedCount = 0;
      let requiresManualReview = 0;

      for (const outcome of outcomes) {
        const finalStatus =
          outcome.status === 'APPLIED' && outcome.verified
            ? 'APPLIED'
            : outcome.status === 'ALREADY_APPLIED'
              ? 'ALREADY_APPLIED'
              : outcome.status === 'FAILED'
                ? 'FAILED'
                : 'SKIPPED';

        if (finalStatus === 'APPLIED') verifiedApplied += 1;
        else if (finalStatus === 'ALREADY_APPLIED') alreadyApplied += 1;
        else if (finalStatus === 'FAILED') failedCount += 1;
        else skippedCount += 1;

        if (
          outcome.crawlJobResult === 'skipped_mandatory_fields' ||
          outcome.crawlJobResult === 'skipped_captcha'
        ) {
          requiresManualReview += 1;
        }

        const jobExists = db
          .prepare('SELECT id FROM jobs WHERE id = ?')
          .get(outcome.jobId);
        if (!jobExists) {
          continue;
        }

        db.prepare(`
          INSERT INTO applications (
            id, user_id, job_id, workflow_id, task_id, approval_id,
            agent_id, platform, status, verified_submission,
            crawljob_result_code, skip_or_failure_reason, screenshot_path,
            submitted_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'wally', 'wellfound', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, job_id) DO UPDATE SET
            workflow_id = excluded.workflow_id,
            task_id = excluded.task_id,
            approval_id = excluded.approval_id,
            status = excluded.status,
            verified_submission = excluded.verified_submission,
            crawljob_result_code = excluded.crawljob_result_code,
            skip_or_failure_reason = excluded.skip_or_failure_reason,
            screenshot_path = excluded.screenshot_path,
            submitted_at = excluded.submitted_at,
            updated_at = excluded.updated_at
        `).run(
          `app_${crypto.randomUUID().slice(0, 10)}`,
          userId,
          outcome.jobId,
          workflowId,
          taskId,
          input.approvalId,
          finalStatus,
          finalStatus === 'APPLIED' && outcome.verified ? 1 : 0,
          outcome.crawlJobResult,
          outcome.reason,
          outcome.screenshotPath ?? null,
          finalStatus === 'APPLIED' ? now : null,
          now,
          now,
        );

        db.prepare(
          'UPDATE job_matches SET status = ? WHERE user_id = ? AND job_id = ?',
        ).run(finalStatus, userId, outcome.jobId);
      }

      const validatedOutput = WallyTaskOutputSchema.parse({
        totalProcessed: outcomes.length,
        verifiedApplied,
        alreadyApplied,
        skippedCount,
        failedCount,
        requiresManualReview,
        outcomes,
      });

      const appliedItems = outcomes.filter((o) => o.status === 'APPLIED');
      const alreadyItems = outcomes.filter((o) => o.status === 'ALREADY_APPLIED');
      const manualReviewItems = outcomes.filter(
        (o) =>
          (o.status === 'SKIPPED' || o.status === 'FAILED') &&
          o.crawlJobResult !== 'skipped_ineligible',
      );
      const filteredOutCount = outcomes.filter(
        (o) => o.crawlJobResult === 'skipped_ineligible',
      ).length;

      const sections: string[] = [
        `🚀 *Wellfound Application Summary (@wally)*`,
        `Scanned *${outcomes.length}* listing(s) · *${verifiedApplied}* Applied ✓ · *${alreadyApplied}* Already Applied · *${filteredOutCount}* Filtered Out by Resume Screen`,
      ];

      if (appliedItems.length > 0) {
        sections.push(
          `\n*✅ Successfully Applied (${appliedItems.length}):*\n` +
            appliedItems
              .map((o) => `• *${o.role}* at *${o.company}* — \`Applied ✓\``)
              .join('\n'),
        );
      }

      if (alreadyItems.length > 0) {
        sections.push(
          `\n*☑️ Already Applied Previously (${alreadyItems.length}):*\n` +
            alreadyItems
              .map((o) => `• *${o.role}* at *${o.company}*`)
              .join('\n'),
        );
      }

      if (manualReviewItems.length > 0) {
        sections.push(
          `\n*⚠️ Needs Quick Manual Apply (${manualReviewItems.length}):*\n_These roles matched your profile but need manual completion on Wellfound:_\n` +
            manualReviewItems
              .map(
                (o) =>
                  `• *${o.role}* at *${o.company}* — _${friendlyWellfoundSkipMessage(
                    o.crawlJobResult,
                    o.reason,
                  )}_ → <${o.applicationUrl}|Open on Wellfound ↗>`,
              )
              .join('\n'),
        );
      }

      await slackClient.updateAgentMessage({
        channel: targetSlackChannel,
        ts: loadingMsg.slackMessageTs,
        text: sections.join('\n'),
      });

      dbRepo.updateAgentTaskStatus(taskId, 'COMPLETED', {
        result: validatedOutput,
      });
      dbRepo.updateAgentSwitchRegistration('wally', {
        status: 'IDLE',
        currentTaskId: null,
      });
    } catch (err) {
      await slackClient.updateAgentMessage({
        ts: loadingMsg.slackMessageTs,
        text: `❌ *Wellfound Run Paused:* ${(err as Error).message}`,
      });
      dbRepo.updateAgentTaskStatus(taskId, 'FAILED', {
        errorText: (err as Error).message,
      });
    }
  }
}

export const wallyAgent = new WallyAgent();
