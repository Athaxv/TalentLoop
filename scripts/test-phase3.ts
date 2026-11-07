import assert from 'node:assert/strict';
import { resetDbForTests, dbRepo, getDb } from '../lib/db';
import { switchCoordinator } from '../lib/switch/coordinator';
import { scoutAgent, evaluateCrawlJobScreening } from '../lib/agents/scout';
import { miloAgent } from '../lib/agents/milo';

async function runPhase3Tests(): Promise<void> {
  console.log('=== Phase 3 Scout (Live Opportunity Discovery) Verification Tests ===');
  resetDbForTests(':memory:');
  process.env.SWITCH_SERVER_URL = 'http://127.0.0.1:8413';

  scoutAgent.registerWithSwitch();

  // Onboard candidate
  await miloAgent.handleUserMessage({
    slackUserId: 'U_SCOUT_TEST',
    slackUserName: 'atharv',
    text: '1',
  });
  await miloAgent.handleUserMessage({
    slackUserId: 'U_SCOUT_TEST',
    slackUserName: 'atharv',
    text: 'Resume',
    uploadedResumeText:
      'Atharv Gaur\nEmail: atharv@talentloop.dev\nSkills: TypeScript, React, Next.js, Node.js, PostgreSQL, Redis, Golang, Playwright\nExperience\nSoftware Engineer Intern at FinStack Labs (2025)\n- Built backend services in TypeScript and Node.js',
  });
  await miloAgent.handleUserMessage({
    slackUserId: 'U_SCOUT_TEST',
    slackUserName: 'atharv',
    text: 'Roles: Full Stack Developer, Software Developer, Backend Engineer, Web Development | Locations: Bangalore, Remote | Types: both | Work mode: remote | Min salary: INR 40,000/month',
  });
  const onboarded = await miloAgent.handleUserMessage({
    slackUserId: 'U_SCOUT_TEST',
    slackUserName: 'atharv',
    text: 'confirm',
  });

  assert.equal(onboarded.user.onboardingCompleted, true);

  // Trigger live job discovery via Milo
  const workflowTurn = await miloAgent.handleUserMessage({
    slackUserId: 'U_SCOUT_TEST',
    slackUserName: 'atharv',
    text: 'Only jobs: find matching jobs and internships',
  });

  assert.ok(workflowTurn.workflow, 'Workflow created');

  const deadline = Date.now() + 20000;
  let scoutTask = dbRepo.listAgentTasks({
    workflowId: workflowTurn.workflow.id,
    assignedAgent: 'scout',
  })[0];

  while (
    Date.now() < deadline &&
    scoutTask?.status !== 'COMPLETED' &&
    scoutTask?.status !== 'FAILED'
  ) {
    await new Promise((r) => setTimeout(r, 300));
    scoutTask = dbRepo.listAgentTasks({
      workflowId: workflowTurn.workflow.id,
      assignedAgent: 'scout',
    })[0];
  }

  assert.equal(
    scoutTask?.status,
    'COMPLETED',
    `Scout task must complete (got ${scoutTask?.status}: ${scoutTask?.errorText})`,
  );
  const result = JSON.parse(scoutTask!.resultJson!);
  assert.ok(
    result.totalFound >= 5,
    `Expected at least 5 live opportunities found, got ${result.totalFound}`,
  );
  assert.ok(
    result.shortlistedCount >= 1,
    `Expected at least 1 shortlisted, got ${result.shortlistedCount}`,
  );
  console.log(
    `✓ Scout discovered ${result.totalFound} live opportunities, shortlisted ${result.shortlistedCount}, removed ${result.duplicatesRemoved} duplicate(s)`,
  );

  // Verify crawlJob screening blocks Senior Principal 8+ yrs roles for entry-level candidate
  const screenSenior = evaluateCrawlJobScreening(
    'Senior Principal Software Engineer',
    'Requires minimum 8+ years of relevant experience in distributed systems.',
    JSON.parse(scoutTask!.candidateContextJson),
    'full-time',
    'Remote',
  );
  assert.equal(screenSenior.eligible, false);
  console.log('✓ crawlJob screening filter verified:', screenSenior.reason);

  const jobsInDb = (
    getDb().prepare('SELECT COUNT(*) as c FROM jobs').get() as { c: number }
  ).c;
  assert.ok(jobsInDb >= result.totalFound, 'All discovered jobs persisted in SQLite');

  await switchCoordinator.shutdown();
  console.log('=== All Phase 3 Tests Passed! ===');
}

runPhase3Tests().catch((err) => {
  console.error('Phase 3 test failed:', err);
  process.exit(1);
});
