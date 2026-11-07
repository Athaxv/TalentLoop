import crypto from 'node:crypto';
import { dbRepo, getDb } from '../db';
import {
  PipDraftTaskInputSchema,
  PipDraftTaskOutputSchema,
  PipSendTaskInputSchema,
  PipSendTaskOutputSchema,
  type CandidateContext,
  type DelegatedTaskEnvelope,
} from './contracts';
import { switchCoordinator } from '../switch/coordinator';
import { gmailOutreachService } from '../gmail/service';
import { slackClient } from '../slack/client';
import {
  analyzeTurnWithTeammateBrain,
  resolveActiveUserFromSwitchSender,
} from './teammate-brain';
import { buildCandidateContext } from '../onboarding/profile-sync';

/**
 * Extracts the clean startup one-liner and open roles from Clover's evidence string
 * so cold emails never repeat robotic metadata strings like `Company (YC S24): "..." Actively hiring on YC (...)`.
 */
function parseCloverEvidence(
  company: string,
  rawEvidence: string,
): { oneLiner: string; openRoles: string | null } {
  const quoteMatch = rawEvidence.match(/"([^"]+)"/);
  let oneLiner = quoteMatch ? quoteMatch[1].trim().replace(/\.$/, '') : '';
  if (!oneLiner) {
    oneLiner = rawEvidence
      .replace(/^[^:]+:\s*/, '')
      .replace(/Actively hiring.*$/i, '')
      .trim()
      .replace(/\.$/, '');
  }
  const rolesMatch = rawEvidence.match(/Actively hiring on YC\s*\(([^)]+)\)/i);
  const openRoles = rolesMatch ? rolesMatch[1].trim() : null;
  return {
    oneLiner: oneLiner || `what you're building at ${company}`,
    openRoles,
  };
}

/**
 * Generates a sharp, pattern-interrupt, anti-AI-slop founder cold email grounded strictly in:
 * - The founder's real company, product focus, and open role from @clover
 * - The candidate's real work experience, projects, and GitHub/LinkedIn links from @milo
 * Rotates across distinct subject hooks and body structures so no two emails in a campaign look templated.
 */
export function generatePersonalizedColdEmail(params: {
  candidate: CandidateContext;
  founderName: string;
  founderRole: string;
  company: string;
  fundingOrHiringEvidence: string;
  relevanceToCandidate: string;
  variantIndex?: number;
}): {
  subject: string;
  bodyText: string;
  whyCompanyExplanation: string;
  highlightedSkills: string[];
  highlightedProjects: string[];
} {
  const { candidate, founderName, company, fundingOrHiringEvidence } = params;
  const firstName = founderName.split(' ')[0];
  const { oneLiner, openRoles } = parseCloverEvidence(
    company,
    fundingOrHiringEvidence,
  );

  const specificRole =
    openRoles?.split(',')[0]?.trim() ||
    candidate.preferredRoles[0] ||
    'Software Engineer';

  // Pick factual skills
  const evidenceLower = `${company} ${fundingOrHiringEvidence} ${params.relevanceToCandidate}`.toLowerCase();
  const matchedSkills = candidate.skills.filter((s) =>
    evidenceLower.includes(s.toLowerCase()),
  );
  const highlightedSkills =
    matchedSkills.length >= 2
      ? matchedSkills.slice(0, 5)
      : candidate.skills.slice(0, 5);

  const topProject1 = candidate.projects[0];
  const topProject2 = candidate.projects[1];
  const highlightedProjects = candidate.projects.slice(0, 2).map((p) => p.name);

  const topExp = candidate.experiences[0];
  const secondExp = candidate.experiences[1];

  // Build concise, high-signal proof bullets from real candidate facts (split on `. ` so `Node.js` / `Express.js` are never truncated)
  const firstSentences = (text: string, count = 1): string => {
    const parts = text
      .split(/\.\s+/)
      .map((s) => s.trim().replace(/\.$/, ''))
      .filter(Boolean);
    return parts.slice(0, count).join('. ');
  };

  const proofBullets: string[] = [];
  if (secondExp) {
    proofBullets.push(
      `• **${secondExp.role} @ ${secondExp.company.split('(')[0].trim()}**: ${firstSentences(secondExp.description, 1)}.`,
    );
  } else if (topExp) {
    proofBullets.push(
      `• **${topExp.role} @ ${topExp.company.split('(')[0].trim()}**: ${firstSentences(topExp.description, 1)}.`,
    );
  }

  if (topProject1) {
    proofBullets.push(
      `• **${topProject1.name}**: ${firstSentences(topProject1.description, 2)}.`,
    );
  }
  if (topProject2) {
    proofBullets.push(
      `• **${topProject2.name}**: ${firstSentences(topProject2.description, 2)}.`,
    );
  }

  const linkParts: string[] = [];
  if (candidate.links.github) linkParts.push(`GitHub: ${candidate.links.github}`);
  if (candidate.links.linkedin) linkParts.push(`LinkedIn: ${candidate.links.linkedin}`);
  if (candidate.links.portfolio) linkParts.push(`Portfolio: ${candidate.links.portfolio}`);

  // Deterministic variant selector based on company + founder name so every email in the batch gets a unique hook & subject
  const hashNum =
    params.variantIndex ??
    crypto
      .createHash('md5')
      .update(`${company}:${founderName}`)
      .digest()[0];

  const subjectHooks = [
    `Legal notice: ${company}'s engineering backlog is missing me`,
    `unsolicited engineering tape for ${firstName} (${company})`,
    `don't open this unless ${company} needs a cracked ${specificRole}`,
    `built ${topProject1?.name || 'an agent engine'} + ${topProject2?.name || 'distributed queues'} — ${company}?`,
    `${firstName} — 45-second pitch re: ${company}'s ${specificRole} role`,
    `shipping ${company}'s hardest ${ highlightedSkills.slice(0, 2).join('/') } tickets this week`,
  ];

  const openingHooks = [
    `Saw what you're shipping at ${company} (${oneLiner.toLowerCase()}) and noticed you're looking for a ${specificRole}. Skipping the generic cover letter—here's what I actually ship:`,
    `Been following ${company}'s work on ${oneLiner.toLowerCase()}. I love building fast, production-grade systems and wanted to throw my hat in the ring for ${specificRole}:`,
    `Quick cold note—saw ${company} is scaling up engineering around ${oneLiner.toLowerCase()}. I spend most of my time building low-latency backends and agentic workflows in ${highlightedSkills.slice(0, 3).join(', ')}:`,
    `No AI fluff—saw ${company} is hiring a ${specificRole} to push ${oneLiner.toLowerCase()} forward. Here is the most relevant stuff I've built recently:`,
  ];

  const closingHooks = [
    `If you want someone who can jump into the repo on day one and ship without hand-holding, are you open to a 10-minute chat this week?`,
    `Happy to build a quick weekend spike or take a tough ticket to prove my speed. Worth a quick 10-min call this week?`,
    `Would love to jam on how I can help ${company} ship faster. Open to a quick chat this week?`,
  ];

  const subject = subjectHooks[hashNum % subjectHooks.length];
  const opener = openingHooks[hashNum % openingHooks.length];
  const closer = closingHooks[hashNum % closingHooks.length];

  const bodyText = `Hi ${firstName},

${opener}

${proofBullets.join('\n\n')}

${linkParts.length > 0 ? `Code & proof of work: ${linkParts.join('  |  ')}\n\n` : ''}${closer}

Best,
${candidate.fullName}
${candidate.email}${candidate.phone ? ` · ${candidate.phone}` : ''}`;

  return {
    subject,
    bodyText,
    whyCompanyExplanation: `Tailored to ${company}'s focus (${oneLiner}) and open ${specificRole} role.`,
    highlightedSkills,
    highlightedProjects,
  };
}

export function buildDraftInteractiveBlocks(params: {
  draftId: string;
  index: number;
  total: number;
  recipientName: string;
  recipientEmail: string;
  company: string;
  subject: string;
  bodyText: string;
}): unknown[] {
  const quotedBody = params.bodyText
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
    .slice(0, 2800);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✉️ *Cold Email Draft ${params.index} of ${params.total}* (\`${params.draftId}\`)\n*To:* *${params.recipientName}* <${params.recipientEmail}> · *${params.company}*\n*Subject:* \`${params.subject}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: quotedBody,
      },
    },
    {
      type: 'actions',
      block_id: `draft_actions_${params.draftId}`,
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '✅ Approve & Send via Gmail',
            emoji: true,
          },
          style: 'primary',
          action_id: `tl_approve_draft:${params.draftId}`,
          value: params.draftId,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '❌ Reject Draft',
            emoji: true,
          },
          style: 'danger',
          action_id: `tl_reject_draft:${params.draftId}`,
          value: params.draftId,
        },
      ],
    },
    {
      type: 'divider',
    },
  ];
}

/**
 * Agent 6: Pip — Gmail Outreach Agent Runtime
 */
export class PipAgent {
  public registerWithSwitch(): void {
    switchCoordinator.registerAgentHandler(
      'pip',
      async ({ parsedTaskEnvelope, message }) => {
        if (parsedTaskEnvelope) {
          if (parsedTaskEnvelope.taskType === 'DRAFT_OUTREACH_EMAILS') {
            await this.executeDraftTask(parsedTaskEnvelope, message.thread_id);
          } else if (parsedTaskEnvelope.taskType === 'SEND_APPROVED_EMAILS') {
            await this.executeSendTask(parsedTaskEnvelope, message.thread_id);
          }
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
      agentId: 'pip',
      senderName: message.sender_name,
      messageText: message.body,
      candidateContext,
      recentRoomMessages,
    });

    if (brain.intent === 'CHAT_CONVERSATION' || !candidateContext) {
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'pip',
        content: brain.conversationalReply,
        slackChannelId: channelId,
        threadId: message.thread_id,
      });
      return;
    }

    const wf = dbRepo.createWorkflow({
      userId: user.id,
      title: `Pip Gmail Outreach`,
      naturalLanguageRequest: message.body,
      switchRoomId: switchCoordinator.getRoomId(),
      slackChannelId: channelId ?? null,
      slackThreadTs: message.thread_id,
    });

    if (brain.intent === 'SEND_EMAILS') {
      const pendingEmailApproval = dbRepo
        .listApprovals({ status: 'PENDING' })
        .find((a) => a.targetAgent === 'pip' && a.actionType === 'SEND_EMAIL');

      if (!pendingEmailApproval) {
        await switchCoordinator.postAgentRoomMessage({
          fromAgent: 'pip',
          content: `ℹ️ No pending email drafts awaiting approval right now. Say \`@pip draft emails\` first so I can draft personalized emails for your researched founders!`,
          slackChannelId: channelId,
          threadId: message.thread_id,
        });
        return;
      }

      const approved = dbRepo.decideApproval({
        approvalId: pendingEmailApproval.id,
        status: 'APPROVED',
        decidedBySlackUserId: user.slackUserId,
        decisionNote: 'Direct @pip send command in Switch room',
      });
      const payloadData = JSON.parse(approved.payloadJson);
      const taskRec = dbRepo.createAgentTask({
        workflowId: wf.id,
        requestingAgent: 'pip',
        assignedAgent: 'pip',
        userId: user.id,
        taskType: 'SEND_APPROVED_EMAILS',
        input: {
          approvalId: approved.id,
          draftIds: payloadData.draftIds ?? [],
        },
        candidateContext,
        expectedOutput: 'PipSendTaskOutputSchema',
      });

      await this.executeSendTask(
        {
          taskId: taskRec.taskId,
          workflowId: wf.id,
          requestingAgent: 'pip',
          assignedAgent: 'pip',
          userId: user.id,
          taskType: 'SEND_APPROVED_EMAILS',
          input: JSON.parse(taskRec.inputJson),
          candidateContext,
          expectedOutput: 'PipSendTaskOutputSchema',
          status: 'IN_PROGRESS',
          createdAt: taskRec.createdAt,
          updatedAt: taskRec.updatedAt,
        },
        message.thread_id,
      );
      return;
    }

    // Otherwise: DRAFT_EMAILS
    const db = getDb();
    const verifiedFounderRows = db
      .prepare(
        'SELECT * FROM founder_contacts WHERE email_verified_public = 1 AND public_email IS NOT NULL ORDER BY confidence_score DESC LIMIT 10',
      )
      .all() as Array<Record<string, unknown>>;

    if (verifiedFounderRows.length === 0) {
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'pip',
        content: `ℹ️ I don't have any verified founder emails to draft for yet! Ask *@clover* (\`@clover research startup founders\`) to pull verified founders first, then ping me!`,
        slackChannelId: channelId,
        threadId: message.thread_id,
      });
      return;
    }

    const campaignId = `cmpgn_${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO outreach_campaigns (
        id, user_id, workflow_id, name, target_role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(
      campaignId,
      user.id,
      wf.id,
      `Founder Outreach — ${candidateContext.preferredRoles[0] ?? 'Engineering'}`,
      candidateContext.preferredRoles[0] ?? 'Software Engineer',
      now,
      now,
    );

    const contactsPayload = verifiedFounderRows.map((r) => ({
      contactId: String(r.id),
      founderName: String(r.founder_name),
      role: String(r.role),
      company: String(r.company_name),
      companyWebsite: r.company_website ? String(r.company_website) : null,
      fundingOrHiringEvidence: String(r.funding_or_hiring_evidence),
      evidenceSourceUrl: String(r.evidence_source_url),
      sourceDate: r.source_date ? String(r.source_date) : null,
      publicProfessionalEmail: String(r.public_email),
      emailSourceUrl: r.email_source_url ? String(r.email_source_url) : null,
      emailVerifiedPublic: true,
      linkedinUrl: r.linkedin_url ? String(r.linkedin_url) : null,
      relevanceToCandidate: String(r.relevance_to_candidate),
      confidenceScore: Number(r.confidence_score),
    }));

    const taskRec = dbRepo.createAgentTask({
      workflowId: wf.id,
      requestingAgent: 'pip',
      assignedAgent: 'pip',
      userId: user.id,
      taskType: 'DRAFT_OUTREACH_EMAILS',
      input: { campaignId, contacts: contactsPayload },
      candidateContext,
      expectedOutput: 'PipDraftTaskOutputSchema',
    });

    await this.executeDraftTask(
      {
        taskId: taskRec.taskId,
        workflowId: wf.id,
        requestingAgent: 'pip',
        assignedAgent: 'pip',
        userId: user.id,
        taskType: 'DRAFT_OUTREACH_EMAILS',
        input: JSON.parse(taskRec.inputJson),
        candidateContext,
        expectedOutput: 'PipDraftTaskOutputSchema',
        status: 'IN_PROGRESS',
        createdAt: taskRec.createdAt,
        updatedAt: taskRec.updatedAt,
      },
      message.thread_id,
    );
  }

  public async executeDraftTask(
    envelope: DelegatedTaskEnvelope,
    threadId?: string | null,
  ): Promise<void> {
    const { taskId, workflowId, userId, candidateContext } = envelope;

    try {
      const input = PipDraftTaskInputSchema.parse(envelope.input);

      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'pip',
        status: 'IN_PROGRESS',
        summaryMessage: `Drafting personalized cold outreach emails for **${input.contacts.length}** verified founder contact(s)...`,
        threadId,
      });

      const db = getDb();
      const now = new Date().toISOString();

      let draftsCreated = 0;
      let awaitingApproval = 0;
      let skippedDuplicateOrOptOut = 0;
      const drafts: Array<{
        draftId: string;
        contactId: string;
        recipientName: string;
        recipientEmail: string | null;
        company: string;
        subject: string;
        bodyText: string;
        whyCompanyExplanation: string;
        highlightedSkills: string[];
        highlightedProjects: string[];
        gmailDraftId: string | null;
        status: 'DRAFTED' | 'PENDING_APPROVAL' | 'SKIPPED';
      }> = [];

      for (let idx = 0; idx < input.contacts.length; idx++) {
        const contact = input.contacts[idx];
        if (!contact.publicProfessionalEmail || !contact.emailVerifiedPublic) {
          skippedDuplicateOrOptOut += 1;
          continue;
        }

        // Global + Campaign Duplicate Protection: never draft or email a recipient already emailed by this user!
        if (
          gmailOutreachService.isRecipientOptedOut(contact.publicProfessionalEmail) ||
          gmailOutreachService.hasAlreadySentInCampaign(
            input.campaignId,
            contact.publicProfessionalEmail,
            userId,
          )
        ) {
          skippedDuplicateOrOptOut += 1;
          continue;
        }

        // Also skip if there is already an active PENDING_APPROVAL draft for this recipient email for this user
        const existingDraft = db
          .prepare(
            "SELECT id FROM email_drafts WHERE user_id = ? AND (founder_contact_id = ? OR LOWER(recipient_email) = LOWER(?)) AND status IN ('PENDING_APPROVAL', 'SENT') LIMIT 1",
          )
          .get(userId, contact.contactId, contact.publicProfessionalEmail) as
          | { id: string }
          | undefined;

        if (existingDraft) {
          skippedDuplicateOrOptOut += 1;
          continue;
        }

        const contactRow = db
          .prepare('SELECT company_id FROM founder_contacts WHERE id = ?')
          .get(contact.contactId) as { company_id: string } | undefined;
        const companyId = contactRow?.company_id;
        if (!companyId) {
          skippedDuplicateOrOptOut += 1;
          continue;
        }

        const generated = generatePersonalizedColdEmail({
          candidate: candidateContext,
          founderName: contact.founderName,
          founderRole: contact.role,
          company: contact.company,
          fundingOrHiringEvidence: contact.fundingOrHiringEvidence,
          relevanceToCandidate: contact.relevanceToCandidate,
          variantIndex: idx,
        });

        const gmailDraft = await gmailOutreachService.createGmailDraft({
          userId,
          recipientEmail: contact.publicProfessionalEmail,
          subject: generated.subject,
          bodyText: generated.bodyText,
        });

        const draftId = `drf_${crypto.randomUUID().slice(0, 10)}`;
        db.prepare(`
          INSERT INTO email_drafts (
            id, user_id, campaign_id, workflow_id, task_id,
            founder_contact_id, company_id, recipient_email,
            recipient_name, company_name, subject, body_text,
            gmail_draft_id, why_company_explanation,
            highlighted_skills_json, highlighted_projects_json,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', ?, ?)
        `).run(
          draftId,
          userId,
          input.campaignId,
          workflowId,
          taskId,
          contact.contactId,
          companyId,
          contact.publicProfessionalEmail,
          contact.founderName,
          contact.company,
          generated.subject,
          generated.bodyText,
          gmailDraft.gmailDraftId,
          generated.whyCompanyExplanation,
          JSON.stringify(generated.highlightedSkills),
          JSON.stringify(generated.highlightedProjects),
          now,
          now,
        );

        db.prepare(
          "UPDATE founder_contacts SET status = 'PENDING_APPROVAL', updated_at = ? WHERE id = ?",
        ).run(now, contact.contactId);

        draftsCreated += 1;
        awaitingApproval += 1;

        drafts.push({
          draftId,
          contactId: contact.contactId,
          recipientName: contact.founderName,
          recipientEmail: contact.publicProfessionalEmail,
          company: contact.company,
          subject: generated.subject,
          bodyText: generated.bodyText,
          whyCompanyExplanation: generated.whyCompanyExplanation,
          highlightedSkills: generated.highlightedSkills,
          highlightedProjects: generated.highlightedProjects,
          gmailDraftId: gmailDraft.gmailDraftId,
          status: 'PENDING_APPROVAL',
        });
      }

      if (drafts.length > 0) {
        const approval = dbRepo.createApproval({
          workflowId,
          taskId,
          userId,
          actionType: 'SEND_EMAIL',
          requestedByAgent: 'milo',
          targetAgent: 'pip',
          title: `Approve Sending ${drafts.length} Personalized Founder Email(s) via Gmail (@pip)`,
          summaryText: drafts
            .map(
              (d) =>
                `• To: ${d.recipientName} <${d.recipientEmail}> (${d.company}) — Subject: "${d.subject}"`,
            )
            .join('\n'),
          payload: {
            campaignId: input.campaignId,
            draftIds: drafts.map((d) => d.draftId),
          },
        });

        for (const d of drafts) {
          db.prepare('UPDATE email_drafts SET approval_id = ? WHERE id = ?').run(
            approval.id,
            d.draftId,
          );
        }

        const wf = dbRepo.getWorkflow(workflowId);
        const targetSlackChannel = wf?.slackChannelId || undefined;

        // Post an interactive Slack Block Kit card with Approve / Reject buttons for EACH cold email draft!
        for (let i = 0; i < drafts.length; i++) {
          const d = drafts[i];
          const cardText = `✉️ *Cold Email Draft ${i + 1} of ${drafts.length}* (\`${d.draftId}\`)\n*To:* ${d.recipientName} <${d.recipientEmail}> (*${d.company}*)\n*Subject:* \`${d.subject}\`\n\n${d.bodyText}`;

          const blocks = buildDraftInteractiveBlocks({
            draftId: d.draftId,
            index: i + 1,
            total: drafts.length,
            recipientName: d.recipientName,
            recipientEmail: d.recipientEmail || '',
            company: d.company,
            subject: d.subject,
            bodyText: d.bodyText,
          });

          await slackClient.postAgentMessage({
            agentId: 'pip',
            channel: targetSlackChannel,
            threadTs: threadId,
            text: cardText,
            blocks,
          });
        }
      }

      const validatedOutput = PipDraftTaskOutputSchema.parse({
        draftsCreated,
        awaitingApproval,
        skippedDuplicateOrOptOut,
        drafts,
      });

      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'pip',
        status: 'COMPLETED',
        summaryMessage: `Created **${draftsCreated}** personalized Gmail draft(s); **${awaitingApproval}** awaiting human approval (${skippedDuplicateOrOptOut} duplicates/opt-outs skipped).`,
        result: validatedOutput,
        threadId,
      });
    } catch (err) {
      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'pip',
        status: 'FAILED',
        summaryMessage: `Gmail drafting failed: ${(err as Error).message}`,
        errorText: (err as Error).message,
        threadId,
      });
    }
  }

  public async executeSendTask(
    envelope: DelegatedTaskEnvelope,
    threadId?: string | null,
  ): Promise<void> {
    const { taskId, workflowId, userId } = envelope;

    try {
      const input = PipSendTaskInputSchema.parse(envelope.input);

      const approval = dbRepo.getApproval(input.approvalId);
      if (
        !approval ||
        (approval.status !== 'APPROVED' && approval.status !== 'EDITED')
      ) {
        await switchCoordinator.reportTaskStatusOverSwitch({
          taskId,
          agentId: 'pip',
          status: 'REQUIRES_APPROVAL',
          summaryMessage: `Refusing to send emails: Approval \`${input.approvalId}\` is not approved (status: ${approval?.status ?? 'MISSING'}).`,
          threadId,
        });
        return;
      }

      const oauthStatus = gmailOutreachService.getOAuthConfigStatus(userId);
      if (!oauthStatus.userConnected) {
        getDb()
          .prepare("UPDATE approvals SET status = 'PENDING', decision_note = ? WHERE id = ?")
          .run('Awaiting real Google OAuth2 authentication before sending', input.approvalId);

        await switchCoordinator.reportTaskStatusOverSwitch({
          taskId,
          agentId: 'pip',
          status: 'REQUIRES_APPROVAL',
          summaryMessage: `⚠️ **Google OAuth 2.0 Authorization Required:** Click **"Authorize with Google OAuth 2.0 →"** at the top of the dashboard to connect your real Gmail account, then click Approve again.`,
          threadId,
        });
        return;
      }

      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'pip',
        status: 'IN_PROGRESS',
        summaryMessage: `Sending **${input.draftIds.length}** human-approved Gmail draft(s) via Google Gmail API...`,
        threadId,
      });

      const db = getDb();
      const now = new Date().toISOString();

      let sentCount = 0;
      let failedCount = 0;
      let bouncedCount = 0;
      const results: Array<{
        draftId: string;
        recipientEmail: string;
        gmailMessageId: string | null;
        status: 'SENT' | 'FAILED' | 'BOUNCED' | 'OPTED_OUT';
        error: string | null;
      }> = [];

      for (const draftId of input.draftIds) {
        const draftRow = db
          .prepare('SELECT * FROM email_drafts WHERE id = ? AND user_id = ?')
          .get(draftId, userId) as Record<string, unknown> | undefined;

        if (!draftRow) continue;

        const recipientEmail = String(draftRow.recipient_email ?? '');
        const campaignId = String(draftRow.campaign_id);
        const founderContactId = String(draftRow.founder_contact_id);
        const subject = String(draftRow.subject);
        const bodyText = String(draftRow.body_text);

        // Cross-campaign duplicate send protection
        if (
          gmailOutreachService.hasAlreadySentInCampaign(
            campaignId,
            recipientEmail,
            userId,
          )
        ) {
          results.push({
            draftId,
            recipientEmail,
            gmailMessageId: null,
            status: 'FAILED',
            error: 'Duplicate outreach prevented: already sent to this recipient.',
          });
          failedCount += 1;
          continue;
        }

        if (gmailOutreachService.isRecipientOptedOut(recipientEmail)) {
          db.prepare(
            "UPDATE email_drafts SET status = 'OPTED_OUT', updated_at = ? WHERE id = ?",
          ).run(now, draftId);
          results.push({
            draftId,
            recipientEmail,
            gmailMessageId: null,
            status: 'OPTED_OUT',
            error: 'Recipient has opted out.',
          });
          failedCount += 1;
          continue;
        }

        try {
          const sendRes = await gmailOutreachService.sendApprovedGmailDraft({
            userId,
            recipientEmail,
            subject,
            bodyText,
            gmailDraftId: draftRow.gmail_draft_id
              ? String(draftRow.gmail_draft_id)
              : null,
          });

          const msgRecordId = `emsg_${crypto.randomUUID().slice(0, 10)}`;
          db.prepare(`
            INSERT INTO email_messages (
              id, draft_id, user_id, campaign_id, founder_contact_id,
              recipient_email, subject, body_text,
              gmail_message_id, gmail_thread_id, status, sent_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?)
          `).run(
            msgRecordId,
            draftId,
            userId,
            campaignId,
            founderContactId,
            recipientEmail,
            subject,
            bodyText,
            sendRes.gmailMessageId,
            sendRes.gmailThreadId,
            sendRes.sentAt,
            now,
          );

          db.prepare(
            "UPDATE email_drafts SET status = 'SENT', updated_at = ? WHERE id = ?",
          ).run(now, draftId);
          db.prepare(
            "UPDATE founder_contacts SET status = 'SENT', updated_at = ? WHERE id = ?",
          ).run(now, founderContactId);

          sentCount += 1;
          results.push({
            draftId,
            recipientEmail,
            gmailMessageId: sendRes.gmailMessageId,
            status: 'SENT',
            error: null,
          });
        } catch (sendErr) {
          const isBounce = (sendErr as { code?: string }).code === 'BOUNCED';
          const status = isBounce ? 'BOUNCED' : 'FAILED';
          if (isBounce) bouncedCount += 1;
          else failedCount += 1;

          results.push({
            draftId,
            recipientEmail,
            gmailMessageId: null,
            status,
            error: (sendErr as Error).message,
          });
        }
      }

      const validatedOutput = PipSendTaskOutputSchema.parse({
        sentCount,
        failedCount,
        bouncedCount,
        results,
      });

      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'pip',
        status: 'COMPLETED',
        summaryMessage: `Gmail outreach send complete: **${sentCount}** sent via Google Gmail API, **${bouncedCount}** bounced, **${failedCount}** failed/skipped.`,
        result: validatedOutput,
        threadId,
      });
    } catch (err) {
      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'pip',
        status: 'FAILED',
        summaryMessage: `Gmail send task failed: ${(err as Error).message}`,
        errorText: (err as Error).message,
        threadId,
      });
    }
  }

  /**
   * Handles 1-click Slack interactive button approval (`✅ Approve & Send via Gmail`) for an individual cold email draft.
   */
  public async approveAndSendSingleDraft(params: {
    draftId: string;
    decidedBySlackUserId: string;
  }): Promise<{
    ok: boolean;
    recipientName: string;
    recipientEmail: string;
    companyName: string;
    subject: string;
    bodyText: string;
    gmailMessageId?: string;
    error?: string;
  }> {
    const db = getDb();
    const draftRow = db
      .prepare('SELECT * FROM email_drafts WHERE id = ?')
      .get(params.draftId) as Record<string, unknown> | undefined;

    if (!draftRow) {
      return {
        ok: false,
        recipientName: '',
        recipientEmail: '',
        companyName: '',
        subject: '',
        bodyText: '',
        error: `Draft ${params.draftId} not found.`,
      };
    }

    const userId = String(draftRow.user_id);
    const campaignId = String(draftRow.campaign_id);
    const founderContactId = String(draftRow.founder_contact_id);
    const recipientName = String(draftRow.recipient_name);
    const recipientEmail = String(draftRow.recipient_email ?? '');
    const companyName = String(draftRow.company_name);
    const subject = String(draftRow.subject);
    const bodyText = String(draftRow.body_text);
    const approvalId = draftRow.approval_id ? String(draftRow.approval_id) : null;

    if (String(draftRow.status) === 'SENT') {
      return {
        ok: true,
        recipientName,
        recipientEmail,
        companyName,
        subject,
        bodyText,
        gmailMessageId: 'already_sent',
      };
    }

    const oauthStatus = gmailOutreachService.getOAuthConfigStatus(userId);
    if (!oauthStatus.userConnected) {
      return {
        ok: false,
        recipientName,
        recipientEmail,
        companyName,
        subject,
        bodyText,
        error:
          'Google OAuth 2.0 Authorization Required: Please authorize your Gmail account first.',
      };
    }

    if (
      gmailOutreachService.hasAlreadySentInCampaign(
        campaignId,
        recipientEmail,
        userId,
      )
    ) {
      return {
        ok: false,
        recipientName,
        recipientEmail,
        companyName,
        subject,
        bodyText,
        error: `Duplicate outreach prevented: already sent an email to ${recipientEmail}.`,
      };
    }

    try {
      const sendRes = await gmailOutreachService.sendApprovedGmailDraft({
        userId,
        recipientEmail,
        subject,
        bodyText,
        gmailDraftId: draftRow.gmail_draft_id
          ? String(draftRow.gmail_draft_id)
          : null,
      });

      const now = new Date().toISOString();
      const msgRecordId = `emsg_${crypto.randomUUID().slice(0, 10)}`;
      db.prepare(`
        INSERT INTO email_messages (
          id, draft_id, user_id, campaign_id, founder_contact_id,
          recipient_email, subject, body_text,
          gmail_message_id, gmail_thread_id, status, sent_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?)
      `).run(
        msgRecordId,
        params.draftId,
        userId,
        campaignId,
        founderContactId,
        recipientEmail,
        subject,
        bodyText,
        sendRes.gmailMessageId,
        sendRes.gmailThreadId,
        sendRes.sentAt,
        now,
      );

      db.prepare(
        "UPDATE email_drafts SET status = 'SENT', updated_at = ? WHERE id = ?",
      ).run(now, params.draftId);
      db.prepare(
        "UPDATE founder_contacts SET status = 'SENT', updated_at = ? WHERE id = ?",
      ).run(now, founderContactId);

      // If all drafts in the parent approval are now decided (SENT or SKIPPED), mark the parent approval APPROVED
      if (approvalId) {
        const remaining = db
          .prepare(
            "SELECT COUNT(*) as c FROM email_drafts WHERE approval_id = ? AND status = 'PENDING_APPROVAL'",
          )
          .get(approvalId) as { c: number };
        if (remaining.c === 0) {
          dbRepo.decideApproval({
            approvalId,
            status: 'APPROVED',
            decidedBySlackUserId: params.decidedBySlackUserId,
            decisionNote: 'All individual drafts decided via Slack buttons',
          });
        }
      }

      return {
        ok: true,
        recipientName,
        recipientEmail,
        companyName,
        subject,
        bodyText,
        gmailMessageId: sendRes.gmailMessageId,
      };
    } catch (err) {
      return {
        ok: false,
        recipientName,
        recipientEmail,
        companyName,
        subject,
        bodyText,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Handles 1-click Slack interactive button rejection (`❌ Reject Draft`) for an individual cold email draft.
   */
  public rejectSingleDraft(params: {
    draftId: string;
    decidedBySlackUserId: string;
  }): {
    ok: boolean;
    recipientName: string;
    recipientEmail: string;
    companyName: string;
    subject: string;
  } {
    const db = getDb();
    const draftRow = db
      .prepare('SELECT * FROM email_drafts WHERE id = ?')
      .get(params.draftId) as Record<string, unknown> | undefined;

    if (!draftRow) {
      return {
        ok: false,
        recipientName: '',
        recipientEmail: '',
        companyName: '',
        subject: '',
      };
    }

    const now = new Date().toISOString();
    const approvalId = draftRow.approval_id ? String(draftRow.approval_id) : null;

    db.prepare(
      "UPDATE email_drafts SET status = 'SKIPPED', updated_at = ? WHERE id = ?",
    ).run(now, params.draftId);

    if (approvalId) {
      const remaining = db
        .prepare(
          "SELECT COUNT(*) as c FROM email_drafts WHERE approval_id = ? AND status = 'PENDING_APPROVAL'",
        )
        .get(approvalId) as { c: number };
      if (remaining.c === 0) {
        dbRepo.decideApproval({
          approvalId,
          status: 'REJECTED',
          decidedBySlackUserId: params.decidedBySlackUserId,
          decisionNote: 'Draft rejected via Slack interactive button',
        });
      }
    }

    return {
      ok: true,
      recipientName: String(draftRow.recipient_name),
      recipientEmail: String(draftRow.recipient_email ?? ''),
      companyName: String(draftRow.company_name),
      subject: String(draftRow.subject),
    };
  }
}

export const pipAgent = new PipAgent();
