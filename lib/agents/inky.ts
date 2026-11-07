import crypto from 'node:crypto';
import { dbRepo, getDb } from '../db';
import {
  InkyTaskInputSchema,
  InkyTaskOutputSchema,
  type DelegatedTaskEnvelope,
} from './contracts';
import { switchCoordinator } from '../switch/coordinator';
import { localCompanionService } from '../companion/service';
import { slackClient } from '../slack/client';
import {
  buildDedupFingerprint,
  evaluateCrawlJobScreening,
  fetchPublicJobSources,
} from './scout';
import {
  analyzeTurnWithTeammateBrain,
  resolveActiveUserFromSwitchSender,
} from './teammate-brain';
import { buildCandidateContext } from '../onboarding/profile-sync';

function friendlyInternshalaSkipMessage(
  code: string,
  rawReason: string | null,
): string {
  if (code === 'skippedQuestions') {
    return 'Requires answering a custom subjective question on the form';
  }
  if (code === 'skippedCaptcha') {
    return 'CAPTCHA verification required on the page';
  }
  if (code === 'skippedExternal') {
    return 'Redirects to an external company application page';
  }
  if (rawReason && /login required/i.test(rawReason)) {
    return 'Please sign in to Internshala once in the local browser profile';
  }
  return 'Requires manual review or custom form confirmation on Internshala';
}

/**
 * Agent 3: Inky — Internshala Application Specialist
 * 1. Searches live Internshala listings matching the user's resume (if none were pre-supplied).
 * 2. Excludes all jobs the user has already applied to in the database (`APPLIED` / `ALREADY_APPLIED`).
 * 3. Shows a live loading indicator in Slack while searching and applying.
 * 4. Posts a clean, readable Slack summary with direct manual-apply links for any skipped listings.
 */
export class InkyAgent {
  public registerWithSwitch(): void {
    switchCoordinator.registerAgentHandler(
      'inky',
      async ({ parsedTaskEnvelope, message }) => {
        if (
          parsedTaskEnvelope &&
          parsedTaskEnvelope.taskType === 'APPLY_INTERNSHALA_BATCH'
        ) {
          await this.executeInternshalaTask(parsedTaskEnvelope, message.thread_id);
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

    const appliedCount = (
      getDb()
        .prepare(
          "SELECT COUNT(*) as c FROM applications WHERE user_id = ? AND status IN ('APPLIED', 'ALREADY_APPLIED')",
        )
        .get(user.id) as { c: number }
    ).c;

    const brain = await analyzeTurnWithTeammateBrain({
      agentId: 'inky',
      senderName: message.sender_name,
      messageText: message.body,
      candidateContext,
      recentRoomMessages,
      dbStats: { appliedCount },
    });

    if (brain.intent === 'CHAT_CONVERSATION' || !candidateContext) {
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'inky',
        content: brain.conversationalReply,
        slackChannelId: channelId,
        threadId: message.thread_id,
      });
      return;
    }

    const wf = dbRepo.createWorkflow({
      userId: user.id,
      title: `Inky Internshala Run`,
      naturalLanguageRequest: message.body,
      switchRoomId: switchCoordinator.getRoomId(),
      slackChannelId: channelId ?? null,
      slackThreadTs: message.thread_id,
    });

    const taskRec = dbRepo.createAgentTask({
      workflowId: wf.id,
      requestingAgent: 'inky',
      assignedAgent: 'inky',
      userId: user.id,
      taskType: 'APPLY_INTERNSHALA_BATCH',
      input: { mode: 'both', listings: [], applicationAgentMode: 'auto-submit' },
      candidateContext,
      expectedOutput: 'InkyTaskOutputSchema',
    });

    const approval = dbRepo.createApproval({
      workflowId: wf.id,
      taskId: taskRec.taskId,
      userId: user.id,
      actionType: 'BATCH_APPLICATION',
      requestedByAgent: 'milo',
      targetAgent: 'inky',
      title: 'Direct Internshala Run (@inky)',
      summaryText: message.body,
      payload: { mode: 'both', listings: [], applicationAgentMode: 'auto-submit' },
    });

    dbRepo.decideApproval({
      approvalId: approval.id,
      status: 'APPROVED',
      decidedBySlackUserId: user.slackUserId,
      decisionNote: 'Direct @inky command in Switch room',
    });

    await this.executeInternshalaTask(
      {
        taskId: taskRec.taskId,
        workflowId: wf.id,
        requestingAgent: 'inky',
        assignedAgent: 'inky',
        userId: user.id,
        taskType: 'APPLY_INTERNSHALA_BATCH',
        input: {
          approvalId: approval.id,
          mode: 'both',
          listings: [],
          applicationAgentMode: 'auto-submit',
        },
        candidateContext,
        expectedOutput: 'InkyTaskOutputSchema',
        status: 'IN_PROGRESS',
        createdAt: taskRec.createdAt,
        updatedAt: taskRec.updatedAt,
      },
      message.thread_id,
    );
  }

  public async executeInternshalaTask(
    envelope: DelegatedTaskEnvelope,
    threadId?: string | null,
  ): Promise<void> {
    const { taskId, workflowId, userId, candidateContext } = envelope;

    const wf = dbRepo.getWorkflow(workflowId);
    const targetSlackChannel = wf?.slackChannelId || undefined;

    // Post live loading indicator in Slack that updates in-place as Inky works
    const loadingMsg = await slackClient.postAgentMessage({
      agentId: 'inky',
      channel: targetSlackChannel,
      threadTs: threadId,
      text: `⏳ *Inky is searching Internshala for unapplied roles matching ${candidateContext.fullName}'s resume (${candidateContext.preferredRoles.slice(0, 3).join(', ')})...*`,
    });

    try {
      const input = InkyTaskInputSchema.parse(envelope.input);

      const approval = dbRepo.getApproval(input.approvalId);
      if (
        !approval ||
        (approval.status !== 'APPROVED' && approval.status !== 'EDITED')
      ) {
        await slackClient.updateAgentMessage({
          ts: loadingMsg.slackMessageTs,
          text: `⏸️ *Waiting for approval (\`${input.approvalId}\`) before running Internshala automation.*`,
        });
        return;
      }

      const db = getDb();
      const now = new Date().toISOString();

      // 1. Load all job IDs and URLs the user has ALREADY applied to so we never re-apply
      const appliedRows = db
        .prepare(
          "SELECT j.id, LOWER(j.application_url) as url FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ? AND a.status IN ('APPLIED', 'ALREADY_APPLIED')",
        )
        .all(userId) as Array<{ id: string; url: string }>;

      const alreadyAppliedIds = new Set(appliedRows.map((r) => r.id));
      const alreadyAppliedUrls = new Set(appliedRows.map((r) => r.url));

      let listingsToApply = input.listings.filter(
        (l) =>
          !alreadyAppliedIds.has(l.jobId) &&
          !alreadyAppliedUrls.has(l.applicationUrl.toLowerCase()),
      );

      // 2. If Inky was invoked directly (or pre-supplied listings were already applied), search fresh Internshala matches based on the user's resume!
      if (listingsToApply.length === 0) {
        const rawSources = await fetchPublicJobSources(
          candidateContext.preferredRoles,
        );
        const internshalaSources = rawSources.filter(
          (s) => s.platform === 'internshala',
        );

        for (const item of internshalaSources) {
          const cleanUrl = item.applicationUrl.split('?')[0];
          if (alreadyAppliedUrls.has(cleanUrl.toLowerCase())) {
            continue;
          }

          const screening = evaluateCrawlJobScreening(
            item.title,
            item.description,
            candidateContext,
            item.employmentType,
            `${item.location} ${item.workMode}`,
          );
          if (!screening.eligible) {
            continue;
          }

          const fingerprint = buildDedupFingerprint(
            item.company,
            item.title,
            cleanUrl,
          );
          let existingJob = db
            .prepare(
              'SELECT id FROM jobs WHERE application_url = ? OR dedup_fingerprint = ?',
            )
            .get(cleanUrl, fingerprint) as { id: string } | undefined;

          const jobId = existingJob?.id ?? `job_${crypto.randomUUID().slice(0, 10)}`;
          if (!existingJob) {
            db.prepare(`
              INSERT OR IGNORE INTO jobs (
                id, company_name, title, location, work_mode, employment_type,
                required_skills_json, description, application_url, source_url,
                platform, is_verified_current, dedup_fingerprint, discovered_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'internshala', 1, ?, ?)
            `).run(
              jobId,
              item.company,
              item.title,
              item.location,
              item.workMode,
              item.employmentType,
              JSON.stringify(item.skillsRequired),
              item.description,
              cleanUrl,
              item.sourceUrl,
              fingerprint,
              now,
            );
          }

          if (alreadyAppliedIds.has(jobId)) continue;

          listingsToApply.push({
            jobId,
            title: item.title,
            company: item.company,
            applicationUrl: cleanUrl,
            category: item.employmentType === 'internship' ? 'internship' : 'job',
          });

          if (listingsToApply.length >= 6) break;
        }
      }

      if (listingsToApply.length === 0) {
        const doneMsg = `✅ *All matching Internshala roles for your resume have already been applied to!* No new unapplied listings found right now.`;
        await slackClient.updateAgentMessage({
          ts: loadingMsg.slackMessageTs,
          text: doneMsg,
        });
        dbRepo.updateAgentTaskStatus(taskId, 'COMPLETED', {
          result: {
            totalProcessed: 0,
            verifiedApplied: 0,
            alreadyApplied: appliedRows.length,
            skippedCount: 0,
            failedCount: 0,
            requiresManualReview: 0,
            outcomes: [],
          },
        });
        return;
      }

      // Update live loading indicator in Slack before launching browser
      await slackClient.updateAgentMessage({
        ts: loadingMsg.slackMessageTs,
        text: `⏳ *Inky found ${listingsToApply.length} unapplied Internshala role(s) matching your resume. Launching local browser and applying now...*\n${listingsToApply
          .map((l, i) => `${i + 1}. *${l.title}* at *${l.company}*`)
          .join('\n')}`,
      });

      const outcomes = await localCompanionService.executeInternshalaBatch({
        userId,
        taskId,
        candidateContext,
        mode: input.mode,
        listings: listingsToApply,
      });

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
          outcome.crawlJobResult === 'skippedQuestions' ||
          outcome.crawlJobResult === 'skippedCaptcha'
        ) {
          requiresManualReview += 1;
        }

        const jobExists = db
          .prepare('SELECT id FROM jobs WHERE id = ?')
          .get(outcome.jobId);
        if (!jobExists) continue;

        db.prepare(`
          INSERT INTO applications (
            id, user_id, job_id, workflow_id, task_id, approval_id,
            agent_id, platform, status, verified_submission,
            crawljob_result_code, skip_or_failure_reason, screenshot_path,
            submitted_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'inky', 'internshala', ?, ?, ?, ?, ?, ?, ?, ?)
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

      const validatedOutput = InkyTaskOutputSchema.parse({
        totalProcessed: outcomes.length,
        verifiedApplied,
        alreadyApplied,
        skippedCount,
        failedCount,
        requiresManualReview,
        outcomes,
      });

      // Build a clean, highly readable Slack summary
      const appliedItems = outcomes.filter((o) => o.status === 'APPLIED');
      const alreadyItems = outcomes.filter((o) => o.status === 'ALREADY_APPLIED');
      const skippedItems = outcomes.filter(
        (o) => o.status === 'SKIPPED' || o.status === 'FAILED',
      );

      const sections: string[] = [
        `🎓 *Internshala Application Summary (@inky)*`,
        `Processed *${outcomes.length}* role(s) matching your resume · *${verifiedApplied}* Applied ✓ · *${alreadyApplied}* Already Applied · *${skippedItems.length}* Need Quick Manual Review`,
      ];

      if (appliedItems.length > 0) {
        sections.push(
          `\n*✅ Successfully Applied (${appliedItems.length}):*\n` +
            appliedItems
              .map((o) => `• *${o.role}* at *${o.company}* — \`Verified ✓\``)
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

      if (skippedItems.length > 0) {
        sections.push(
          `\n*⚠️ Needs Quick Manual Apply (${skippedItems.length}):*\n_These roles matched your resume but required a custom question or manual step on Internshala. Click below to finish them directly:_\n` +
            skippedItems
              .map(
                (o) =>
                  `• *${o.role}* at *${o.company}* — _${friendlyInternshalaSkipMessage(
                    o.crawlJobResult,
                    o.reason,
                  )}_ → <${o.applicationUrl}|Apply Manually on Internshala ↗>`,
              )
              .join('\n'),
        );
      }

      const finalSlackText = sections.join('\n');

      // Replace the loading message in Slack with the finished summary!
      await slackClient.updateAgentMessage({
        channel: targetSlackChannel,
        ts: loadingMsg.slackMessageTs,
        text: finalSlackText,
      });

      dbRepo.updateAgentTaskStatus(taskId, 'COMPLETED', {
        result: validatedOutput,
      });
      dbRepo.updateAgentSwitchRegistration('inky', {
        status: 'IDLE',
        currentTaskId: null,
      });
    } catch (err) {
      const errMsg = `❌ *Internshala Run Paused:* ${(err as Error).message}`;
      await slackClient.updateAgentMessage({
        ts: loadingMsg.slackMessageTs,
        text: errMsg,
      });
      dbRepo.updateAgentTaskStatus(taskId, 'FAILED', {
        errorText: (err as Error).message,
      });
    }
  }
}

export const inkyAgent = new InkyAgent();
