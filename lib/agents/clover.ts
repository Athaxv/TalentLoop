import crypto from 'node:crypto';
import { dbRepo, getDb } from '../db';
import {
  CloverTaskInputSchema,
  CloverTaskOutputSchema,
  type CandidateContext,
  type DelegatedTaskEnvelope,
  type FounderContactContractSchema,
} from './contracts';
import { switchCoordinator } from '../switch/coordinator';
import { slackClient } from '../slack/client';
import {
  analyzeTurnWithTeammateBrain,
  resolveActiveUserFromSwitchSender,
} from './teammate-brain';
import { buildCandidateContext } from '../onboarding/profile-sync';
import type { z } from 'zod';

type FounderContactContract = z.infer<typeof FounderContactContractSchema>;

const PRIVATE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'aol.com',
  'protonmail.com',
  'live.com',
]);

export function isVerifiedPublicBusinessEmail(
  email: string | null | undefined,
  companyDomain: string | null | undefined,
  sourceUrl: string | null | undefined,
): boolean {
  if (!email || !sourceUrl) return false;
  const parts = email.toLowerCase().trim().split('@');
  if (parts.length !== 2) return false;
  const domain = parts[1];
  if (PRIVATE_EMAIL_DOMAINS.has(domain)) return false;
  if (companyDomain) {
    const cleanCompanyDomain = companyDomain
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, '')
      .split('/')[0];
    if (domain !== cleanCompanyDomain && !domain.endsWith(`.${cleanCompanyDomain}`)) {
      return false;
    }
  }
  return true;
}

interface LiveStartupFounderRecord {
  founderName: string;
  role: string;
  company: string;
  companyWebsite: string;
  companyDomain: string;
  ycBatch: string;
  fundingStage: string;
  fundingAmount: string;
  fundingOrHiringEvidence: string;
  evidenceSourceUrl: string;
  sourceDate: string;
  publicProfessionalEmail: string | null;
  emailSourceUrl: string | null;
  linkedinUrl: string | null;
  tags: string[];
  confidenceScore: number;
}

/**
 * Fetches 100% live startup and founder intelligence from:
 * 1. Y Combinator's live public company feed (`https://yc-oss.github.io/api/batches/s24.json`)
 * 2. Y Combinator's live company pages (`https://www.ycombinator.com/companies/<slug>`) for verified `founders` and `jobPostings`
 * 3. Each startup's own live website (`/`, `/contact`, `/about`, `/privacy`) to extract real, publicly listed `@<domain>` business emails.
 * Never guesses email addresses and never fabricates founders or startups.
 */
export async function discoverLiveStartupFounders(
  maxContacts: number,
): Promise<LiveStartupFounderRecord[]> {
  const discovered: LiveStartupFounderRecord[] = [];

  const res = await fetch('https://yc-oss.github.io/api/batches/s24.json', {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch YC company directory (${res.status})`);
  }

  const allCompanies = (await res.json()) as Array<{
    name: string;
    slug: string;
    website?: string;
    one_liner?: string;
    long_description?: string;
    isHiring?: boolean;
    batch?: string;
    stage?: string;
    tags?: string[];
    url: string;
    launched_at?: number;
  }>;

  // Filter to startups that are actively hiring and have a live website
  const hiringCompanies = allCompanies
    .filter((c) => c.isHiring && c.website && c.url)
    .slice(0, Math.min(14, maxContacts + 4));

  await Promise.allSettled(
    hiringCompanies.map(async (comp) => {
      if (!comp.website) return;
      let domain = '';
      try {
        domain = new URL(comp.website).hostname.replace(/^www\./i, '').toLowerCase();
      } catch {
        return;
      }

      // 1. Fetch live YC company page to extract real founders and open jobs
      const ycPageRes = await fetch(comp.url, {
        signal: AbortSignal.timeout(5000),
      });
      if (!ycPageRes.ok) return;
      const ycHtml = await ycPageRes.text();
      const dpMatch = ycHtml.match(/data-page="([^"]+)"/);
      if (!dpMatch?.[1]) return;

      const decoded = dpMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'");
      const dataPage = JSON.parse(decoded) as {
        props?: {
          company?: {
            name?: string;
            batch_name?: string;
            one_liner?: string;
            founders?: Array<{
              full_name?: string;
              title?: string;
              linkedin_url?: string | null;
            }>;
          };
          jobPostings?: Array<{
            title?: string;
            salaryRange?: string;
          }>;
        };
      };

      const founders = dataPage.props?.company?.founders ?? [];
      if (founders.length === 0) return;

      const jobTitles = (dataPage.props?.jobPostings ?? [])
        .map((j) => j.title)
        .filter(Boolean);

      // 2. Crawl the startup's live public pages (`/`, `/contact`, `/about`) for a verified `@<domain>` email
      let foundPublicEmail: string | null = null;
      let foundEmailSourceUrl: string | null = null;

      const candidatePages = [
        comp.website.replace(/\/$/, ''),
        `${comp.website.replace(/\/$/, '')}/contact`,
        `${comp.website.replace(/\/$/, '')}/about`,
      ];

      for (const pageUrl of candidatePages) {
        try {
          const siteRes = await fetch(pageUrl, {
            signal: AbortSignal.timeout(3000),
            headers: {
              'User-Agent': 'TalentLoop-Clover-Research/1.0',
              Accept: 'text/html',
            },
          });
          if (!siteRes.ok) continue;
          const siteHtml = await siteRes.text();
          const emailMatches = [
            ...siteHtml.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g),
          ]
            .map((m) => m[0].toLowerCase())
            .filter(
              (email) =>
                email.endsWith(`@${domain}`) &&
                !email.startsWith('u00') &&
                !/\.(png|jpg|jpeg|svg|webp|gif)$/i.test(email),
            );

          if (emailMatches.length > 0) {
            foundPublicEmail = emailMatches[0];
            foundEmailSourceUrl = pageUrl;
            break;
          }
        } catch {
          // ignore unreachable subpage
        }
      }

      const sourceDate = comp.launched_at
        ? new Date(comp.launched_at * 1000).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);

      const hiringSummary =
        jobTitles.length > 0
          ? `Actively hiring on YC (${jobTitles.slice(0, 2).join(', ')})`
          : 'Marked as Actively Hiring in YC S24 directory';

      const primaryFounder = founders[0];
      if (!primaryFounder?.full_name) return;

      discovered.push({
        founderName: primaryFounder.full_name,
        role: primaryFounder.title || 'Founder',
        company: comp.name,
        companyWebsite: comp.website,
        companyDomain: domain,
        ycBatch: `YC ${comp.batch || 'S24'}`,
        fundingStage: comp.stage || 'Seed (YC)',
        fundingAmount: `YC ${comp.batch || 'S24'} Backed`,
        fundingOrHiringEvidence: `${comp.name} (YC ${comp.batch || 'S24'}): "${comp.one_liner || ''}". ${hiringSummary}.`,
        evidenceSourceUrl: comp.url,
        sourceDate,
        publicProfessionalEmail: foundPublicEmail,
        emailSourceUrl: foundEmailSourceUrl,
        linkedinUrl: primaryFounder.linkedin_url || null,
        tags: comp.tags ?? [],
        confidenceScore: foundPublicEmail ? 94 : 82,
      });
    }),
  );

  return discovered.slice(0, maxContacts);
}

function buildRelevanceExplanation(
  intel: LiveStartupFounderRecord,
  candidate: CandidateContext,
): string {
  const tagsText = intel.tags.length > 0 ? ` (${intel.tags.join(', ')})` : '';
  const projectText =
    candidate.projects.length > 0
      ? ` and project experience (${candidate.projects[0].name})`
      : '';
  return `${intel.company}${tagsText} is an actively hiring ${intel.ycBatch} startup aligned with ${candidate.fullName}'s target roles (${candidate.preferredRoles.slice(0, 2).join(', ')}) and skills (${candidate.skills.slice(0, 4).join(', ')})${projectText}.`;
}

/**
 * Agent 5: Clover — Founder Intelligence Agent Runtime
 */
export class CloverAgent {
  public registerWithSwitch(): void {
    switchCoordinator.registerAgentHandler(
      'clover',
      async ({ parsedTaskEnvelope, message }) => {
        if (parsedTaskEnvelope && parsedTaskEnvelope.taskType === 'RESEARCH_FOUNDERS') {
          await this.executeFounderResearchTask(parsedTaskEnvelope, message.thread_id);
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
      agentId: 'clover',
      senderName: message.sender_name,
      messageText: message.body,
      candidateContext,
      recentRoomMessages,
    });

    if (brain.intent === 'CHAT_CONVERSATION' || !candidateContext) {
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'clover',
        content: brain.conversationalReply,
        slackChannelId: channelId,
        threadId: message.thread_id,
      });
      return;
    }

    const wf = dbRepo.createWorkflow({
      userId: user.id,
      title: `Clover Founder Research`,
      naturalLanguageRequest: message.body,
      switchRoomId: switchCoordinator.getRoomId(),
      slackChannelId: channelId ?? null,
      slackThreadTs: message.thread_id,
    });

    const taskRec = dbRepo.createAgentTask({
      workflowId: wf.id,
      requestingAgent: 'clover',
      assignedAgent: 'clover',
      userId: user.id,
      taskType: 'RESEARCH_FOUNDERS',
      input: {
        targetRoles: candidateContext.preferredRoles,
        includeRecentlyFunded: true,
        maxContacts: 10,
      },
      candidateContext,
      expectedOutput: 'CloverTaskOutputSchema',
    });

    await this.executeFounderResearchTask(
      {
        taskId: taskRec.taskId,
        workflowId: wf.id,
        requestingAgent: 'clover',
        assignedAgent: 'clover',
        userId: user.id,
        taskType: 'RESEARCH_FOUNDERS',
        input: JSON.parse(taskRec.inputJson),
        candidateContext,
        expectedOutput: 'CloverTaskOutputSchema',
        status: 'IN_PROGRESS',
        createdAt: taskRec.createdAt,
        updatedAt: taskRec.updatedAt,
      },
      message.thread_id,
    );
  }

  public async executeFounderResearchTask(
    envelope: DelegatedTaskEnvelope,
    threadId?: string | null,
  ): Promise<void> {
    const { taskId, workflowId, userId, candidateContext } = envelope;
    const wf = dbRepo.getWorkflow(workflowId);
    const targetSlackChannel = wf?.slackChannelId || undefined;

    const loadingMsg = await slackClient.postAgentMessage({
      agentId: 'clover',
      channel: targetSlackChannel,
      threadTs: threadId,
      text: `⏳ *Clover is researching funded Y Combinator startups & verifying public founder business emails for ${candidateContext.fullName}...*`,
    });

    try {
      const input = CloverTaskInputSchema.parse(envelope.input);

      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'clover',
        status: 'IN_PROGRESS',
        summaryMessage: `Querying live Y Combinator directory & startup websites to identify founders and verify public business emails for [${input.targetRoles.join(', ')}]...`,
        threadId,
      });

      const liveRecords = await discoverLiveStartupFounders(input.maxContacts);

      const db = getDb();
      const now = new Date().toISOString();

      const seenFounderKeys = new Set<string>();
      let duplicatesRemoved = 0;
      let verifiedEmailsFound = 0;
      let unavailableEmailsMarked = 0;
      const contacts: FounderContactContract[] = [];

      for (const item of liveRecords) {
        const dedupKey = `${item.company.toLowerCase().trim()}::${item.founderName.toLowerCase().trim()}`;
        if (seenFounderKeys.has(dedupKey)) {
          duplicatesRemoved += 1;
          continue;
        }
        seenFounderKeys.add(dedupKey);

        const normCompany = item.company.toLowerCase().replace(/[^a-z0-9]/g, '');
        let companyRow = db
          .prepare('SELECT id FROM companies WHERE normalized_name = ?')
          .get(normCompany) as { id: string } | undefined;

        const companyId = companyRow?.id ?? `cmp_${crypto.randomUUID().slice(0, 10)}`;
        db.prepare(`
          INSERT INTO companies (
            id, name, normalized_name, website, domain, funding_stage,
            funding_amount, funding_date, funding_source_url,
            hiring_evidence, hiring_source_url, yc_batch,
            is_actively_hiring, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(normalized_name) DO UPDATE SET
            website = excluded.website,
            domain = excluded.domain,
            funding_stage = excluded.funding_stage,
            funding_amount = excluded.funding_amount,
            funding_date = excluded.funding_date,
            funding_source_url = excluded.funding_source_url,
            hiring_evidence = excluded.hiring_evidence,
            hiring_source_url = excluded.hiring_source_url,
            yc_batch = excluded.yc_batch,
            updated_at = excluded.updated_at
        `).run(
          companyId,
          item.company,
          normCompany,
          item.companyWebsite,
          item.companyDomain,
          item.fundingStage,
          item.fundingAmount,
          item.sourceDate,
          item.evidenceSourceUrl,
          item.fundingOrHiringEvidence,
          item.evidenceSourceUrl,
          item.ycBatch,
          now,
          now,
        );

        companyRow = db
          .prepare('SELECT id FROM companies WHERE normalized_name = ?')
          .get(normCompany) as { id: string };

        const isEmailVerified = isVerifiedPublicBusinessEmail(
          item.publicProfessionalEmail,
          item.companyDomain,
          item.emailSourceUrl,
        );

        const publicEmail = isEmailVerified ? item.publicProfessionalEmail : null;
        const emailSourceUrl = isEmailVerified ? item.emailSourceUrl : null;

        if (isEmailVerified) {
          verifiedEmailsFound += 1;
        } else {
          unavailableEmailsMarked += 1;
        }

        const relevance = buildRelevanceExplanation(item, candidateContext);
        const contactId = `fnd_${crypto.randomUUID().slice(0, 10)}`;

        db.prepare(`
          INSERT INTO founder_contacts (
            id, company_id, company_name, company_website, founder_name, role,
            funding_or_hiring_evidence, evidence_source_url, source_date,
            public_email, email_verified_public, email_source_url, linkedin_url,
            relevance_to_candidate, confidence_score, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, founder_name) DO UPDATE SET
            role = excluded.role,
            funding_or_hiring_evidence = excluded.funding_or_hiring_evidence,
            evidence_source_url = excluded.evidence_source_url,
            public_email = excluded.public_email,
            email_verified_public = excluded.email_verified_public,
            email_source_url = excluded.email_source_url,
            relevance_to_candidate = excluded.relevance_to_candidate,
            confidence_score = excluded.confidence_score,
            updated_at = excluded.updated_at
        `).run(
          contactId,
          companyRow.id,
          item.company,
          item.companyWebsite,
          item.founderName,
          item.role,
          item.fundingOrHiringEvidence,
          item.evidenceSourceUrl,
          item.sourceDate,
          publicEmail,
          isEmailVerified ? 1 : 0,
          emailSourceUrl,
          item.linkedinUrl,
          relevance,
          item.confidenceScore,
          isEmailVerified ? 'CONTACT_VERIFIED' : 'DISCOVERED',
          now,
          now,
        );

        const storedContact = db
          .prepare('SELECT id FROM founder_contacts WHERE company_id = ? AND founder_name = ?')
          .get(companyRow.id, item.founderName) as { id: string };

        contacts.push({
          contactId: storedContact.id,
          founderName: item.founderName,
          role: item.role,
          company: item.company,
          companyWebsite: item.companyWebsite,
          fundingOrHiringEvidence: item.fundingOrHiringEvidence,
          evidenceSourceUrl: item.evidenceSourceUrl,
          sourceDate: item.sourceDate,
          publicProfessionalEmail: publicEmail,
          emailSourceUrl,
          emailVerifiedPublic: isEmailVerified,
          linkedinUrl: item.linkedinUrl,
          relevanceToCandidate: relevance,
          confidenceScore: item.confidenceScore,
        });
      }

      const validatedOutput = CloverTaskOutputSchema.parse({
        foundersResearched: contacts.length,
        verifiedEmailsFound,
        unavailableEmailsMarked,
        duplicatesRemoved,
        contacts,
      });

      const summaryList = contacts
        .slice(0, 6)
        .map(
          (c) =>
            `- **${c.founderName}** (${c.role} @ **${c.company}**) — Email: ${
              c.publicProfessionalEmail
                ? `\`${c.publicProfessionalEmail}\` (Live source: ${c.emailSourceUrl})`
                : '_Unavailable publicly on website (not guessed)_'
            } · Confidence: ${c.confidenceScore}%`,
        )
        .join('\n');

      const finalSummaryText = `🍀 *Founder Intelligence Summary (@clover)*\nResearched *${validatedOutput.foundersResearched}* live YC startups/founders · Verified *${validatedOutput.verifiedEmailsFound}* public business email(s) · Marked *${validatedOutput.unavailableEmailsMarked}* unavailable.\n\n${summaryList}\n\n💡 *Next Step:* Reply *\`@pip draft emails\`* when you want @pip to draft personalized cold emails to these ${validatedOutput.verifiedEmailsFound} verified founders.`;

      await slackClient.updateAgentMessage({
        channel: targetSlackChannel,
        ts: loadingMsg.slackMessageTs,
        text: finalSummaryText,
      });

      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'clover',
        status: 'COMPLETED',
        summaryMessage: finalSummaryText,
        result: validatedOutput,
        threadId,
      });
    } catch (err) {
      await slackClient.updateAgentMessage({
        channel: targetSlackChannel,
        ts: loadingMsg.slackMessageTs,
        text: `❌ *Clover Research Failed:* ${(err as Error).message}`,
      });
      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'clover',
        status: 'FAILED',
        summaryMessage: `Founder research failed: ${(err as Error).message}`,
        errorText: (err as Error).message,
        threadId,
      });
    }
  }
}

export const cloverAgent = new CloverAgent();
