import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resetDbForTests, dbRepo, getDb } from '../lib/db';
import { switchCoordinator } from '../lib/switch/coordinator';
import { miloAgent } from '../lib/agents/milo';
import { scoutAgent } from '../lib/agents/scout';
import { wallyAgent } from '../lib/agents/wally';
import { inkyAgent } from '../lib/agents/inky';
import { localCompanionService } from '../lib/companion/service';

async function runPhase4Tests(): Promise<void> {
  console.log('=== Phase 4 Wally, Inky & Local Companion Verification Tests ===');
  resetDbForTests(':memory:');
  process.env.SWITCH_SERVER_URL = 'http://127.0.0.1:8414';
  process.env.CRAWLJOB_PROFILE_PATH = './.talentloop/phase4-crawljob-profile.json';
  process.env.TALENTLOOP_TEST_MOCK_BROWSER = '1';

  scoutAgent.registerWithSwitch();
  wallyAgent.registerWithSwitch();
  inkyAgent.registerWithSwitch();

  // 1. Onboard candidate
  await miloAgent.handleUserMessage({
    slackUserId: 'U_APPLY_USER',
    slackUserName: 'atharv',
    text: '1',
  });
  await miloAgent.handleUserMessage({
    slackUserId: 'U_APPLY_USER',
    slackUserName: 'atharv',
    text: 'Resume',
    uploadedResumeText:
      'Atharv Gaur\nEmail: atharv@talentloop.dev\nSkills: TypeScript, React, Next.js, Node.js, PostgreSQL, Redis, Golang, Playwright\nExperience\nSoftware Engineer Intern at FinStack Labs (2025)\n- Built backend services in TypeScript and Node.js',
  });
  await miloAgent.handleUserMessage({
    slackUserId: 'U_APPLY_USER',
    slackUserName: 'atharv',
    text: 'Roles: Full Stack Developer, Software Developer, Web Development, Backend Engineer | Locations: Bangalore, Remote | Types: both | Work mode: remote | Min salary: INR 40,000/month',
  });
  const onboarded = await miloAgent.handleUserMessage({
    slackUserId: 'U_APPLY_USER',
    slackUserName: 'atharv',
    text: 'confirm',
  });

  // 2. Test Device Registration, Auth & Pause/Resume
  const regDevice = localCompanionService.registerDevice({
    userId: onboarded.user.id,
    deviceName: 'Atharv Laptop Companion',
  });
  assert.ok(regDevice.rawDeviceToken.startsWith('tl_dev_'));
  const authed = localCompanionService.authenticateDevice(regDevice.rawDeviceToken);
  assert.equal(authed?.id, regDevice.device.id);
  console.log('✓ Local Companion device registered & authenticated:', regDevice.device.id);

  // 3. Run Scout to shortlist live Internshala opportunities
  const wfTurn = await miloAgent.handleUserMessage({
    slackUserId: 'U_APPLY_USER',
    slackUserName: 'atharv',
    text: 'Only jobs: find matching jobs on Internshala',
  });
  const workflowId = wfTurn.workflow!.id;

  for (let i = 0; i < 50; i++) {
    const t = dbRepo.listAgentTasks({ workflowId, assignedAgent: 'scout' })[0];
    if (t?.status === 'COMPLETED') break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const pendingApprovals = dbRepo.listApprovals({ workflowId, status: 'PENDING' });
  assert.ok(pendingApprovals.length >= 1, 'Should have pending batch approval');
  console.log(
    '✓ Pending batch approvals ready:',
    pendingApprovals.map((a) => `${a.id} (@${a.targetAgent})`).join(', '),
  );

  // 4. Approve batches in Slack -> Milo delegates to @inky / @wally over Switch
  const approveTurn = await miloAgent.handleUserMessage({
    slackUserId: 'U_APPLY_USER',
    slackUserName: 'atharv',
    text: 'approve all',
  });
  assert.ok(approveTurn.replyText.includes('APPROVED'));

  for (let i = 0; i < 40; i++) {
    const inkyTask = dbRepo.listAgentTasks({ workflowId, assignedAgent: 'inky' })[0];
    if (inkyTask?.status === 'COMPLETED') break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const inkyTask = dbRepo.listAgentTasks({ workflowId, assignedAgent: 'inky' })[0];
  assert.equal(
    inkyTask?.status,
    'COMPLETED',
    `Inky task must complete (${inkyTask?.errorText})`,
  );

  const inkyOut = JSON.parse(inkyTask!.resultJson!);
  assert.ok(
    inkyOut.verifiedApplied >= 1,
    `Expected >= 1 Internshala verified applications, got ${inkyOut.verifiedApplied}`,
  );
  console.log(`✓ @inky verified ${inkyOut.verifiedApplied} Internshala applications`);

  // 5. Test duplicate protection: re-running executeInternshalaBatch on the same listings returns ALREADY_APPLIED
  const inkyApproval = pendingApprovals.find((a) => a.targetAgent === 'inky')!;
  const inkyPayload = JSON.parse(inkyApproval.payloadJson);
  const rerunOutcomes = await localCompanionService.executeInternshalaBatch({
    userId: onboarded.user.id,
    taskId: 'tsk_rerun_dedup_test',
    candidateContext: JSON.parse(inkyTask!.candidateContextJson),
    mode: 'both',
    listings: inkyPayload.listings,
  });
  assert.ok(
    rerunOutcomes.every((o) => o.status === 'ALREADY_APPLIED'),
    'Re-running on already applied listings must detect ALREADY_APPLIED',
  );
  console.log('✓ Duplicate application protection verified (all returned ALREADY_APPLIED)');

  // 6. Test Pause protection on Local Companion
  localCompanionService.setDeviceStatus(regDevice.device.id, 'PAUSED');
  await assert.rejects(
    () =>
      localCompanionService.executeInternshalaBatch({
        userId: onboarded.user.id,
        taskId: 'tsk_paused_test',
        candidateContext: JSON.parse(inkyTask!.candidateContextJson),
        mode: 'both',
        listings: inkyPayload.listings,
      }),
    /PAUSED/,
    'Paused device must refuse execution',
  );
  localCompanionService.setDeviceStatus(regDevice.device.id, 'ONLINE');
  console.log('✓ Local Companion Pause/Resume safeguard verified');

  await switchCoordinator.shutdown();
  console.log('=== All Phase 4 Tests Passed! ===');
}

runPhase4Tests().catch((err) => {
  console.error('Phase 4 test failed:', err);
  process.exit(1);
});
