import assert from 'node:assert/strict';
import { resetDbForTests, dbRepo, getDb } from '../lib/db';
import { switchCoordinator } from '../lib/switch/coordinator';
import { ensureTalentLoopRuntime, miloAgent } from '../lib/orchestration/runtime';
import { isVerifiedPublicBusinessEmail } from '../lib/agents/clover';

async function runPhase5And6Tests(): Promise<void> {
  console.log('=== Phase 5 (Clover Live YC) & Phase 6 (Pip OAuth Gate) Verification Tests ===');
  resetDbForTests(':memory:');
  process.env.SWITCH_SERVER_URL = 'http://127.0.0.1:8415';

  await ensureTalentLoopRuntime();

  // 1. Verify Clover's email privacy & anti-guessing guardrails
  assert.equal(
    isVerifiedPublicBusinessEmail('founder@gmail.com', 'spurtest.com', 'https://spurtest.com'),
    false,
    'Private personal @gmail.com email must be rejected',
  );
  assert.equal(
    isVerifiedPublicBusinessEmail('contact@spurtest.com', 'spurtest.com', null),
    false,
    'Email without public source URL must be rejected as unverified/guessed',
  );
  assert.equal(
    isVerifiedPublicBusinessEmail(
      'contact@spurtest.com',
      'spurtest.com',
      'https://www.spurtest.com',
    ),
    true,
    'Publicly sourced domain-matching business email must be accepted',
  );
  console.log('✓ Clover email verification & anti-private-harvesting guardrails verified');

  // 2. Onboard candidate
  await miloAgent.handleUserMessage({
    slackUserId: 'U_OUTREACH_USER',
    slackUserName: 'atharv',
    text: '1',
  });
  await miloAgent.handleUserMessage({
    slackUserId: 'U_OUTREACH_USER',
    slackUserName: 'atharv',
    text: 'Resume',
    uploadedResumeText:
      'Atharv Gaur\nEmail: atharv@talentloop.dev\nGitHub: https://github.com/Athaxv | LinkedIn: https://www.linkedin.com/in/atharv-gaur\nSkills: TypeScript, React, Next.js, Node.js, PostgreSQL, Redis, Golang, Playwright\nExperience\nSoftware Engineering Intern at FinStack Labs (2025)\n- Built backend services in TypeScript and Node.js\nProjects\ncrawlJob — Local Playwright job automation for Wellfound and Internshala (https://github.com/Athaxv/crawlJob)',
  });
  await miloAgent.handleUserMessage({
    slackUserId: 'U_OUTREACH_USER',
    slackUserName: 'atharv',
    text: 'Roles: Full Stack Developer, Backend Engineer | Locations: Bangalore, Remote | Types: both | Work mode: remote | Min salary: INR 45,000/month',
  });
  await miloAgent.handleUserMessage({
    slackUserId: 'U_OUTREACH_USER',
    slackUserName: 'atharv',
    text: 'confirm',
  });

  // 3. Request Live Founder Research & Cold Email Drafting
  const wfTurn = await miloAgent.handleUserMessage({
    slackUserId: 'U_OUTREACH_USER',
    slackUserName: 'atharv',
    text: 'Only founder research: find recently funded startups and draft personalized cold emails',
  });
  const workflowId = wfTurn.workflow!.id;

  // Wait for Clover -> Pip draft pipeline over Switch WebSockets
  for (let i = 0; i < 60; i++) {
    const cloverTask = dbRepo.listAgentTasks({ workflowId, assignedAgent: 'clover' })[0];
    const pipDraftTask = dbRepo
      .listAgentTasks({ workflowId, assignedAgent: 'pip' })
      .find((t) => t.taskType === 'DRAFT_OUTREACH_EMAILS');
    if (cloverTask?.status === 'COMPLETED' && pipDraftTask?.status === 'COMPLETED') {
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const cloverTask = dbRepo.listAgentTasks({ workflowId, assignedAgent: 'clover' })[0];
  const pipDraftTask = dbRepo
    .listAgentTasks({ workflowId, assignedAgent: 'pip' })
    .find((t) => t.taskType === 'DRAFT_OUTREACH_EMAILS');

  assert.equal(cloverTask?.status, 'COMPLETED', 'Clover task must complete');
  assert.equal(pipDraftTask?.status, 'COMPLETED', 'Pip draft task must complete');

  const cloverOut = JSON.parse(cloverTask!.resultJson!);
  const pipDraftOut = JSON.parse(pipDraftTask!.resultJson!);

  assert.ok(cloverOut.foundersResearched >= 3, 'Live YC founders researched');
  assert.ok(cloverOut.verifiedEmailsFound >= 1, 'Verified public business emails found on live websites');
  console.log(
    `✓ @clover researched ${cloverOut.foundersResearched} live YC founders, verified ${cloverOut.verifiedEmailsFound} public business emails, marked ${cloverOut.unavailableEmailsMarked} unavailable`,
  );

  assert.equal(
    pipDraftOut.draftsCreated,
    cloverOut.verifiedEmailsFound,
    'Pip created personalized drafts for all verified contacts',
  );

  // 4. Verify that approving SEND_EMAIL without Google OAuth2 authentication blocks sending and keeps sentCount = 0!
  const emailApproval = dbRepo
    .listApprovals({ workflowId, status: 'PENDING' })
    .find((a) => a.actionType === 'SEND_EMAIL')!;
  assert.ok(emailApproval, 'Pending SEND_EMAIL approval exists');

  await miloAgent.handleUserMessage({
    slackUserId: 'U_OUTREACH_USER',
    slackUserName: 'atharv',
    text: `approve ${emailApproval.id}`,
  });

  for (let i = 0; i < 30; i++) {
    const pipSendTask = dbRepo
      .listAgentTasks({ workflowId, assignedAgent: 'pip' })
      .find((t) => t.taskType === 'SEND_APPROVED_EMAILS');
    if (pipSendTask?.status === 'REQUIRES_APPROVAL') break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const sentWithoutOAuth = (
    getDb().prepare('SELECT COUNT(*) as c FROM email_messages').get() as { c: number }
  ).c;
  assert.equal(
    sentWithoutOAuth,
    0,
    'Zero emails may be sent when user has not authenticated Gmail OAuth2',
  );
  console.log('✓ @pip blocked sending without Gmail OAuth2 authentication (0 emails sent)');

  await switchCoordinator.shutdown();
  console.log('=== All Phase 5 & Phase 6 Tests Passed! ===');
}

runPhase5And6Tests().catch((err) => {
  console.error('Phase 5 & 6 test failed:', err);
  process.exit(1);
});
