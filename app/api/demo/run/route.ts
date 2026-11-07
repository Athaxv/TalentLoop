import { NextRequest, NextResponse } from 'next/server';
import { dbRepo, getDb } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/session';
import { ensureTalentLoopRuntime, miloAgent } from '@/lib/orchestration/runtime';
import { localCompanionService } from '@/lib/companion/service';
import { slackClient } from '@/lib/slack/client';

export const dynamic = 'force-dynamic';

/**
 * Authenticated Workflow Orchestration Endpoint
 * All actions strictly require an authenticated user session (`tl_session`)
 * and operate exclusively on that user's real onboarded profile.
 * Zero hardcoded resumes or fake user identities.
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Authentication Required: Please sign in before triggering any agent workflows.',
        },
        { status: 401 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      step?:
        | 'reset_my_data'
        | 'discover_jobs'
        | 'research_founders'
        | 'start_workflow'
        | 'approve_applications'
        | 'approve_emails'
        | 'final_report';
      customPrompt?: string;
    };

    const step = body.step || 'start_workflow';
    const slackUserId = authUser.slackUserId;
    const slackUserName = authUser.fullName || authUser.email || 'Candidate';

    await ensureTalentLoopRuntime();

    // Option 1: Reset current user's workflows, jobs matches, applications, and outreach
    if (step === 'reset_my_data') {
      const db = getDb();
      db.prepare('DELETE FROM email_messages WHERE user_id = ?').run(authUser.id);
      db.prepare('DELETE FROM email_drafts WHERE user_id = ?').run(authUser.id);
      db.prepare('DELETE FROM outreach_campaigns WHERE user_id = ?').run(authUser.id);
      db.prepare('DELETE FROM applications WHERE user_id = ?').run(authUser.id);
      db.prepare('DELETE FROM job_matches WHERE user_id = ?').run(authUser.id);
      db.prepare('DELETE FROM approvals WHERE user_id = ?').run(authUser.id);
      db.prepare('DELETE FROM agent_tasks WHERE user_id = ?').run(authUser.id);
      db.prepare('DELETE FROM workflows WHERE user_id = ?').run(authUser.id);
      db.prepare('DELETE FROM notifications WHERE user_id = ?').run(authUser.id);
      slackClient.clearOutbox();
      return NextResponse.json({ ok: true, step: 'reset_my_data' });
    }

    // All agent workflows require the authenticated user to have completed Job Seeker onboarding
    if (!authUser.onboardingCompleted) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Onboarding Incomplete: Please complete your Job Seeker onboarding (resume + preferences confirmation) with @milo before running specialist agents.',
        },
        { status: 400 },
      );
    }

    localCompanionService.getOrEnsureUserDevice(authUser.id);

    if (
      step === 'discover_jobs' ||
      step === 'research_founders' ||
      step === 'start_workflow'
    ) {
      const promptText =
        body.customPrompt?.trim() ||
        (step === 'discover_jobs'
          ? 'Only jobs: discover and shortlist matching jobs and internships for my profile'
          : step === 'research_founders'
            ? 'Only founder outreach: research actively hiring startups and founders and draft personalized cold emails'
            : 'Find matching jobs and internships for my profile, and research startup founders to draft personalized cold emails.');

      const wfTurn = await miloAgent.handleUserMessage({
        slackUserId,
        slackUserName,
        text: promptText,
      });
      const workflowId = wfTurn.workflow?.id;

      // Wait for delegated discovery/research tasks to complete over Switch WebSockets
      for (let i = 0; i < 60; i++) {
        const tasks = dbRepo.listAgentTasks({ workflowId });
        const allSettled =
          tasks.length > 0 &&
          tasks.every(
            (t) =>
              t.status === 'COMPLETED' ||
              t.status === 'FAILED' ||
              t.status === 'REQUIRES_APPROVAL',
          );
        if (allSettled) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      return NextResponse.json({ ok: true, step, workflowId });
    }

    const latestWorkflow = dbRepo.listWorkflows(authUser.id)[0];
    const workflowId = latestWorkflow?.id;

    if (step === 'approve_applications') {
      const appApprovals = dbRepo
        .listApprovals({ userId: authUser.id, status: 'PENDING' })
        .filter((a) => a.actionType === 'BATCH_APPLICATION');

      if (appApprovals.length === 0) {
        return NextResponse.json(
          {
            ok: false,
            error: 'No pending application batch approvals found. Run Job Discovery (@scout) first.',
          },
          { status: 400 },
        );
      }

      for (const apr of appApprovals) {
        await miloAgent.handleUserMessage({
          slackUserId,
          slackUserName,
          text: `approve ${apr.id}`,
        });
      }

      return NextResponse.json({
        ok: true,
        step: 'approve_applications',
        workflowId,
        approvedIds: appApprovals.map((a) => a.id),
      });
    }

    if (step === 'approve_emails') {
      const emailApprovals = dbRepo
        .listApprovals({ userId: authUser.id, status: 'PENDING' })
        .filter((a) => a.actionType === 'SEND_EMAIL');

      if (emailApprovals.length === 0) {
        return NextResponse.json(
          {
            ok: false,
            error: 'No pending email outreach approvals found. Run Founder Research (@clover & @pip) first.',
          },
          { status: 400 },
        );
      }

      for (const apr of emailApprovals) {
        await miloAgent.handleUserMessage({
          slackUserId,
          slackUserName,
          text: `approve ${apr.id}`,
        });
      }

      return NextResponse.json({
        ok: true,
        step: 'approve_emails',
        workflowId,
        approvedIds: emailApprovals.map((a) => a.id),
      });
    }

    if (step === 'final_report') {
      const finalReportTurn = await miloAgent.handleUserMessage({
        slackUserId,
        slackUserName,
        text: 'report',
      });

      return NextResponse.json({
        ok: true,
        step: 'final_report',
        workflowId,
        finalReport: finalReportTurn.replyText,
      });
    }

    return NextResponse.json({ ok: false, error: 'Unknown workflow step' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
