import { NextRequest, NextResponse } from 'next/server';
import { dbRepo, getDb } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/session';
import { ensureTalentLoopRuntime } from '@/lib/orchestration/runtime';
import { switchCoordinator } from '@/lib/switch/coordinator';
import { slackClient } from '@/lib/slack/client';
import { localCompanionService } from '@/lib/companion/service';
import { serializeToCrawlJobProfile } from '@/lib/onboarding/profile-sync';
import { gmailOutreachService } from '@/lib/gmail/service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    // Always keep Switch agent handlers & Slack Socket Mode active even before web login
    const switchState = await ensureTalentLoopRuntime();

    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      return NextResponse.json({
        ok: true,
        authenticated: false,
      });
    }

    const db = getDb();

    const candidateBundle = dbRepo.getCandidateFullBundle(authUser.id);
    const crawlJobProfilePreview = serializeToCrawlJobProfile(authUser.id);

    // 1. Discover Jobs + Job Matches scoped strictly to the authenticated user
    const jobsWithMatches = db
      .prepare(`
        SELECT
          j.*,
          jm.match_score,
          jm.eligible_by_crawljob_screen,
          jm.screening_reason,
          jm.matched_skills_json,
          jm.missing_skills_json,
          jm.rank_order,
          jm.status AS match_status
        FROM job_matches jm
        JOIN jobs j ON j.id = jm.job_id
        WHERE jm.user_id = ?
        ORDER BY jm.eligible_by_crawljob_screen DESC, jm.match_score DESC, j.discovered_at DESC
      `)
      .all(authUser.id) as Array<Record<string, unknown>>;

    const seenJobIds = new Set<string>();
    const jobs = jobsWithMatches
      .filter((r) => {
        const id = String(r.id);
        if (seenJobIds.has(id)) return false;
        seenJobIds.add(id);
        return true;
      })
      .map((r) => ({
        id: String(r.id),
        companyId: r.company_id ? String(r.company_id) : null,
        companyName: String(r.company_name),
        title: String(r.title),
        location: String(r.location),
        workMode: String(r.work_mode),
        employmentType: String(r.employment_type),
        salaryText: r.salary_text ? String(r.salary_text) : null,
        experienceRequirements: r.experience_requirements
          ? String(r.experience_requirements)
          : null,
        requiredSkills: JSON.parse(String(r.required_skills_json || '[]')),
        description: String(r.description),
        postedAt: r.posted_at ? String(r.posted_at) : null,
        applicationUrl: String(r.application_url),
        sourceUrl: String(r.source_url),
        platform: String(r.platform),
        isVerifiedCurrent: Boolean(r.is_verified_current),
        matchScore: r.match_score != null ? Number(r.match_score) : null,
        eligibleByCrawlJobScreen:
          r.eligible_by_crawljob_screen != null
            ? Boolean(r.eligible_by_crawljob_screen)
            : true,
        screeningReason: r.screening_reason ? String(r.screening_reason) : null,
        matchedSkills: JSON.parse(String(r.matched_skills_json || '[]')),
        missingSkills: JSON.parse(String(r.missing_skills_json || '[]')),
        matchStatus: r.match_status ? String(r.match_status) : 'DISCOVERED',
        discoveredAt: String(r.discovered_at),
      }));

    // 2. Applications scoped strictly to the authenticated user
    const applicationRows = db
      .prepare(`
        SELECT
          a.*,
          j.title AS job_title,
          j.company_name,
          j.location AS job_location,
          j.application_url,
          j.employment_type
        FROM applications a
        JOIN jobs j ON j.id = a.job_id
        WHERE a.user_id = ?
        ORDER BY a.updated_at DESC
      `)
      .all(authUser.id) as Array<Record<string, unknown>>;

    const applications = applicationRows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      jobId: String(r.job_id),
      jobTitle: String(r.job_title),
      companyName: String(r.company_name),
      jobLocation: String(r.job_location),
      applicationUrl: String(r.application_url),
      employmentType: String(r.employment_type),
      workflowId: r.workflow_id ? String(r.workflow_id) : null,
      taskId: r.task_id ? String(r.task_id) : null,
      approvalId: r.approval_id ? String(r.approval_id) : null,
      agentId: String(r.agent_id),
      platform: String(r.platform),
      status: String(r.status),
      verifiedSubmission: Boolean(r.verified_submission),
      crawlJobResultCode: r.crawljob_result_code ? String(r.crawljob_result_code) : null,
      skipOrFailureReason: r.skip_or_failure_reason ? String(r.skip_or_failure_reason) : null,
      submittedAt: r.submitted_at ? String(r.submitted_at) : null,
      updatedAt: String(r.updated_at),
    }));

    // 3. Startup & Founder Contacts (only shown once the user has run a founder research task)
    const userHasCloverTask = db
      .prepare(
        "SELECT 1 FROM agent_tasks WHERE user_id = ? AND assigned_agent = 'clover' AND status = 'COMPLETED' LIMIT 1",
      )
      .get(authUser.id);

    const founderRows = userHasCloverTask
      ? (db
          .prepare(`
            SELECT
              fc.*,
              c.funding_stage,
              c.funding_amount,
              c.yc_batch
            FROM founder_contacts fc
            LEFT JOIN companies c ON c.id = fc.company_id
            ORDER BY fc.confidence_score DESC, fc.created_at DESC
          `)
          .all() as Array<Record<string, unknown>>)
      : [];

    const founderContacts = founderRows.map((r) => ({
      id: String(r.id),
      companyId: String(r.company_id),
      companyName: String(r.company_name),
      companyWebsite: r.company_website ? String(r.company_website) : null,
      founderName: String(r.founder_name),
      role: String(r.role),
      fundingStage: r.funding_stage ? String(r.funding_stage) : null,
      fundingAmount: r.funding_amount ? String(r.funding_amount) : null,
      ycBatch: r.yc_batch ? String(r.yc_batch) : null,
      fundingOrHiringEvidence: String(r.funding_or_hiring_evidence),
      evidenceSourceUrl: String(r.evidence_source_url),
      sourceDate: r.source_date ? String(r.source_date) : null,
      publicEmail: r.public_email ? String(r.public_email) : null,
      emailVerifiedPublic: Boolean(r.email_verified_public),
      emailSourceUrl: r.email_source_url ? String(r.email_source_url) : null,
      linkedinUrl: r.linkedin_url ? String(r.linkedin_url) : null,
      relevanceToCandidate: String(r.relevance_to_candidate),
      confidenceScore: Number(r.confidence_score),
      status: String(r.status),
      updatedAt: String(r.updated_at),
    }));

    // 4. Email Drafts & Sent Messages scoped strictly to the authenticated user
    const draftRows = db
      .prepare('SELECT * FROM email_drafts WHERE user_id = ? ORDER BY created_at DESC')
      .all(authUser.id) as Array<Record<string, unknown>>;

    const emailDrafts = draftRows.map((r) => ({
      id: String(r.id),
      campaignId: String(r.campaign_id),
      workflowId: r.workflow_id ? String(r.workflow_id) : null,
      approvalId: r.approval_id ? String(r.approval_id) : null,
      founderContactId: String(r.founder_contact_id),
      recipientEmail: r.recipient_email ? String(r.recipient_email) : null,
      recipientName: String(r.recipient_name),
      companyName: String(r.company_name),
      subject: String(r.subject),
      bodyText: String(r.body_text),
      gmailDraftId: r.gmail_draft_id ? String(r.gmail_draft_id) : null,
      whyCompanyExplanation: String(r.why_company_explanation),
      highlightedSkills: JSON.parse(String(r.highlighted_skills_json || '[]')),
      highlightedProjects: JSON.parse(String(r.highlighted_projects_json || '[]')),
      status: String(r.status),
      updatedAt: String(r.updated_at),
    }));

    const messageRows = db
      .prepare('SELECT * FROM email_messages WHERE user_id = ? ORDER BY created_at DESC')
      .all(authUser.id) as Array<Record<string, unknown>>;

    const emailMessages = messageRows.map((r) => ({
      id: String(r.id),
      draftId: String(r.draft_id),
      recipientEmail: String(r.recipient_email),
      subject: String(r.subject),
      gmailMessageId: r.gmail_message_id ? String(r.gmail_message_id) : null,
      gmailThreadId: r.gmail_thread_id ? String(r.gmail_thread_id) : null,
      status: String(r.status),
      sentAt: r.sent_at ? String(r.sent_at) : null,
      deliveredAt: r.delivered_at ? String(r.delivered_at) : null,
      bouncedAt: r.bounced_at ? String(r.bounced_at) : null,
      repliedAt: r.replied_at ? String(r.replied_at) : null,
      optedOutAt: r.opted_out_at ? String(r.opted_out_at) : null,
      errorDetails: r.error_details ? String(r.error_details) : null,
    }));

    // 5. Agents, Tasks, Events, Approvals, Workflows, Devices, Notifications scoped to user
    const agents = dbRepo.listAgents();
    const workflows = dbRepo.listWorkflows(authUser.id);
    const workflowIds = new Set(workflows.map((w) => w.id));
    const tasks = dbRepo
      .listAgentTasks()
      .filter((t) => t.userId === authUser.id || workflowIds.has(t.workflowId));
    const events = dbRepo
      .listAgentEvents(100)
      .filter(
        (e) =>
          !e.workflowId ||
          workflowIds.has(e.workflowId) ||
          e.eventType === 'SWITCH_CONNECTED',
      );
    const approvals = dbRepo.listApprovals({ userId: authUser.id });
    const devices = localCompanionService.listDevices(authUser.id);
    const notifications = dbRepo.listNotifications(authUser.id, 30);

    // 6. Overview Metrics (100% computed from real persisted records for this user)
    const overviewMetrics = {
      jobsDiscovered: jobs.length,
      jobsShortlisted: jobs.filter(
        (j) =>
          j.matchStatus === 'SHORTLISTED' ||
          j.matchStatus === 'APPLIED' ||
          j.matchStatus === 'PENDING_APPROVAL',
      ).length,
      applicationsSubmittedVerified: applications.filter(
        (a) => a.status === 'APPLIED' && a.verifiedSubmission,
      ).length,
      applicationsPendingApproval: applications.filter(
        (a) => a.status === 'PENDING_APPROVAL',
      ).length,
      foundersResearched: founderContacts.length,
      verifiedFounderEmails: founderContacts.filter((f) => f.emailVerifiedPublic).length,
      emailsDrafted: emailDrafts.length,
      emailsPendingApproval: emailDrafts.filter((d) => d.status === 'PENDING_APPROVAL')
        .length,
      emailsSentVerified: emailMessages.filter(
        (m) => m.status === 'SENT' && Boolean(m.gmailMessageId),
      ).length,
      repliesReceived: emailMessages.filter(
        (m) => m.status === 'REPLIED' || Boolean(m.repliedAt),
      ).length,
      pendingApprovalsCount: approvals.filter((a) => a.status === 'PENDING').length,
    };

    return NextResponse.json({
      ok: true,
      authenticated: true,
      switchState: {
        ...switchState,
        transcript: switchCoordinator.getRoomTranscript().slice(-60),
      },
      slackState: {
        liveConfigured: slackClient.isLiveSlackConfigured(),
        outbox: slackClient.getOutboxMessages(60),
      },
      gmailOAuthStatus: gmailOutreachService.getOAuthConfigStatus(authUser.id),
      overviewMetrics,
      candidateBundle,
      crawlJobProfilePreview,
      jobs,
      applications,
      founderContacts,
      emailDrafts,
      emailMessages,
      agents,
      tasks,
      events,
      approvals,
      workflows,
      devices,
      notifications,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
