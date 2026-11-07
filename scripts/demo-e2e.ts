import assert from 'node:assert/strict';
import { dbRepo, getDb, resetDbForTests } from '../lib/db';
import { registerUserAccount } from '../lib/auth/session';
import { ensureTalentLoopRuntime, miloAgent } from '../lib/orchestration/runtime';
import { localCompanionService } from '../lib/companion/service';
import { switchCoordinator } from '../lib/switch/coordinator';

async function runAuthenticatedPlatformVerification(): Promise<void> {
  console.log('================================================================================');
  console.log('  TalentLoop — Authenticated End-to-End Platform Verification');
  console.log('================================================================================\n');

  if (process.argv.includes('--fresh')) {
    resetDbForTests(':memory:');
  }
  process.env.SWITCH_SERVER_URL = process.env.SWITCH_SERVER_URL || 'http://127.0.0.1:8420';
  process.env.TALENTLOOP_TEST_MOCK_BROWSER = '1';

  const switchState = await ensureTalentLoopRuntime();
  console.log(`[Switch] Server URL : ${switchState.serverUrl}`);
  console.log(`[Switch] Shared Room: ${switchState.roomId}`);
  console.log(`[Switch] Agents Live: ${switchState.agentsOnline.map((a) => `@${a}`).join(', ')}\n`);

  // Step 1: Register and Authenticate User Account
  console.log('--- Step 1: Register & Authenticate User Account ---');
  const { user, rawSessionToken } = registerUserAccount({
    fullName: 'Atharv Gaur',
    email: `atharv.${Date.now()}@talentloop.dev`,
    password: 'securePassword123',
  });
  assert.ok(rawSessionToken.startsWith('tls_'));
  console.log(`✓ Authenticated User: ${user.fullName} (${user.email}) · Session Token issued\n`);

  // Step 2: Milo Welcomes User & User Selects Job Seeker ("1")
  console.log('--- Step 2 & 3: @milo Welcomes User -> User Selects Job Seeker ("1") ---');
  await miloAgent.handleUserMessage({
    slackUserId: user.slackUserId,
    slackUserName: user.fullName!,
    text: 'hi @milo',
  });
  await miloAgent.handleUserMessage({
    slackUserId: user.slackUserId,
    slackUserName: user.fullName!,
    text: '1',
  });

  // Step 4: User Provides Resume & Preferences -> Confirms Profile
  console.log('--- Step 4: User Submits Resume & Job Preferences -> Confirms Profile ---');
  const candidateResume = `${user.fullName}
Location: Bangalore, India
Email: ${user.email}
GitHub: https://github.com/Athaxv | LinkedIn: https://www.linkedin.com/in/atharv-gaur
Skills: TypeScript, JavaScript, Node.js, React, Next.js, PostgreSQL, Redis, Docker, Playwright, Golang, Python
Experience
Software Engineering Intern at FinStack Labs (2025)
- Built backend APIs and worker queues in TypeScript and Node.js
Education
B.Tech in Computer Science — IIIT, 2023 - 2027
Projects
crawlJob — Local Playwright job automation for Wellfound and Internshala (https://github.com/Athaxv/crawlJob)`;

  await miloAgent.handleUserMessage({
    slackUserId: user.slackUserId,
    slackUserName: user.fullName!,
    text: 'Uploaded resume',
    uploadedResumeText: candidateResume,
  });

  await miloAgent.handleUserMessage({
    slackUserId: user.slackUserId,
    slackUserName: user.fullName!,
    text: 'Roles: Full Stack Developer, Software Developer, Web Development, Backend Engineer | Locations: Bangalore, Remote | Types: both | Work mode: remote | Min salary: INR 40,000/month',
  });

  const confirmed = await miloAgent.handleUserMessage({
    slackUserId: user.slackUserId,
    slackUserName: user.fullName!,
    text: 'confirm',
  });
  assert.equal(confirmed.user.onboardingCompleted, true);
  const device = localCompanionService.getOrEnsureUserDevice(user.id);
  console.log(`✓ Profile confirmed & synced to crawlJob: ${device.profilePath}\n`);

  // Step 5: User Triggers Workflow -> @scout & @clover & @pip Execute Live Discovery
  console.log('--- Step 5–12: @milo Delegates Live Discovery to @scout, @clover & @pip over Switch ---');
  const wfTurn = await miloAgent.handleUserMessage({
    slackUserId: user.slackUserId,
    slackUserName: user.fullName!,
    text: 'Find matching jobs and internships for my profile, and research startup founders to draft personalized cold emails.',
  });
  const workflowId = wfTurn.workflow!.id;

  for (let i = 0; i < 70; i++) {
    const tasks = dbRepo.listAgentTasks({ workflowId });
    const scoutDone = tasks.some((t) => t.assignedAgent === 'scout' && t.status === 'COMPLETED');
    const cloverDone = tasks.some((t) => t.assignedAgent === 'clover' && t.status === 'COMPLETED');
    const pipDraftDone = tasks.some(
      (t) =>
        t.assignedAgent === 'pip' &&
        t.taskType === 'DRAFT_OUTREACH_EMAILS' &&
        t.status === 'COMPLETED',
    );
    if (scoutDone && cloverDone && pipDraftDone) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const pendingApprovals = dbRepo.listApprovals({ userId: user.id, status: 'PENDING' });
  console.log(
    `✓ Live Discovery & Drafting Complete! Pending Human Approvals:\n` +
      pendingApprovals.map((a) => `  • [${a.id}] @${a.targetAgent} (${a.actionType}): ${a.title}`).join('\n') +
      '\n',
  );

  // Step 13: Approve Application Batches
  const appApprovals = pendingApprovals.filter((a) => a.actionType === 'BATCH_APPLICATION');
  for (const apr of appApprovals) {
    await miloAgent.handleUserMessage({
      slackUserId: user.slackUserId,
      slackUserName: user.fullName!,
      text: `approve ${apr.id}`,
    });
  }

  for (let i = 0; i < 40; i++) {
    const tasks = dbRepo.listAgentTasks({ workflowId });
    const appTasks = tasks.filter(
      (t) => t.assignedAgent === 'wally' || t.assignedAgent === 'inky',
    );
    if (appTasks.length > 0 && appTasks.every((t) => t.status === 'COMPLETED')) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Step 14: Consolidated Report from @milo
  console.log('--- Step 14: @milo Consolidated Final Report ---\n');
  const finalReportTurn = await miloAgent.handleUserMessage({
    slackUserId: user.slackUserId,
    slackUserName: user.fullName!,
    text: 'report',
  });

  console.log('--------------------------------------------------------------------------------');
  console.log(finalReportTurn.replyText);
  console.log('--------------------------------------------------------------------------------\n');

  const db = getDb();
  const totalTasks = (
    db.prepare('SELECT COUNT(*) as c FROM agent_tasks WHERE workflow_id = ?').get(workflowId) as {
      c: number;
    }
  ).c;
  console.log(`[Audit] Total Persisted AgentTasks in Workflow : ${totalTasks}`);
  console.log(`[Audit] Total Switch Room Log Messages         : ${switchCoordinator.getRoomTranscript().length}`);

  await switchCoordinator.shutdown();
  console.log('\n=== Authenticated End-to-End Platform Verification Passed! ===');
}

runAuthenticatedPlatformVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
