import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resetDbForTests, dbRepo } from '../lib/db';
import { miloAgent, MILO_WELCOME_MESSAGE } from '../lib/agents/milo';
import { switchCoordinator } from '../lib/switch/coordinator';
import { extractTextFromResumeBuffer } from '../lib/onboarding/resume-parser';

async function runPhase2Tests(): Promise<void> {
  console.log('=== Phase 2 Milo & Onboarding Verification Tests ===');
  resetDbForTests(':memory:');
  process.env.SWITCH_SERVER_URL = 'http://127.0.0.1:8412';

  // 1. First interaction in Slack -> Welcome message
  const turn1 = await miloAgent.handleUserMessage({
    slackUserId: 'U_CANDIDATE_01',
    slackUserName: 'atharv',
    text: 'hi @milo',
  });
  assert.equal(turn1.replyText, MILO_WELCOME_MESSAGE);
  assert.equal(turn1.user.onboardingStage, 'ROLE_SELECTION');
  console.log('✓ Step 1: Milo greeted new Slack user with Job Seeker / Hiring choice');

  // 2. Test Hiring selection branch
  const turnHiring = await miloAgent.handleUserMessage({
    slackUserId: 'U_EMPLOYER_01',
    slackUserName: 'founder_bob',
    text: "2. I'm hiring candidates",
  });
  assert.equal(turnHiring.user.roleSelection, 'HIRING');
  assert.equal(turnHiring.user.onboardingStage, 'HIRING_WAITLIST');
  assert.ok(turnHiring.replyText.includes('coming soon'));
  console.log('✓ Step 2: Hiring selection persisted & explained as coming soon');

  // 3. Candidate selects Job Seeker ("1")
  const turn2 = await miloAgent.handleUserMessage({
    slackUserId: 'U_CANDIDATE_01',
    slackUserName: 'atharv',
    text: '1',
  });
  assert.equal(turn2.user.roleSelection, 'JOB_SEEKER');
  assert.equal(turn2.user.onboardingStage, 'COLLECT_RESUME');
  console.log('✓ Step 3: Job Seeker selection advanced user to COLLECT_RESUME');

  // 3b. Test real PDF binary buffer text extraction via unpdf
  const minimalPdf = Buffer.from(
    `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 126 >> stream
BT /F1 12 Tf 72 720 Td (Atharv Gaur - Full Stack Engineer) Tj 0 -20 Td (Skills: TypeScript, React, Node.js, PostgreSQL) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000418 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
486
%%EOF`,
    'ascii',
  );
  const pdfExtracted = await extractTextFromResumeBuffer(
    minimalPdf,
    'resume.pdf',
    'application/pdf',
  );
  assert.ok(
    pdfExtracted.text.includes('Atharv Gaur') &&
      pdfExtracted.text.includes('TypeScript'),
    'PDF binary text extraction must extract text from PDF stream',
  );
  console.log('✓ Step 3b: Real .pdf binary text extraction verified via unpdf:', pdfExtracted.text.replace(/\s+/g, ' '));

  // 4. Candidate uploads / pastes Resume
  const sampleResume = `
Atharv Gaur
Location: Bangalore, India
Email: atharv@talentloop.dev | Phone: +91 9876543210
GitHub: https://github.com/Athaxv | LinkedIn: https://www.linkedin.com/in/atharv-gaur | https://atharv.dev

Summary
Full-stack & backend developer experienced in TypeScript, Node.js, Next.js, and browser automation.

Skills: TypeScript, JavaScript, Node.js, React, Next.js, PostgreSQL, Redis, Docker, Playwright, Golang

Experience
Software Engineering Intern at FinStack Labs (May 2025 - Aug 2025)
- Built event-driven payment webhooks in TypeScript, Node.js, and PostgreSQL reducing latency by 35%.

Education
B.Tech in Computer Science — Indian Institute of Information Technology, 2023 - 2027

Projects
crawlJob — Local Bun + Playwright job auto-apply automation for Wellfound and Internshala (https://github.com/Athaxv/crawlJob)
SwitchMesh — Multi-agent workflow coordinator using WebSockets and SQLite
`;

  const turn3 = await miloAgent.handleUserMessage({
    slackUserId: 'U_CANDIDATE_01',
    slackUserName: 'atharv',
    text: 'Uploaded my resume',
    uploadedResumeText: sampleResume,
    attachments: [
      {
        filename: 'Atharv_Gaur_Resume.pdf',
        mimetype: 'application/pdf',
        size: 48200,
        mxc: 'mxc://talentloop.local/res001',
        msgtype: 'm.file',
      },
    ],
  });

  assert.equal(turn3.user.onboardingStage, 'COLLECT_PREFERENCES');
  const bundleAfterResume = dbRepo.getCandidateFullBundle(turn3.user.id);
  assert.equal(bundleAfterResume.profile?.fullName, 'Atharv Gaur');
  assert.equal(bundleAfterResume.profile?.email, 'atharv@talentloop.dev');
  assert.ok(bundleAfterResume.skills.some((s) => s.name === 'TypeScript'));
  assert.ok(bundleAfterResume.skills.some((s) => s.name === 'Playwright'));
  assert.equal(bundleAfterResume.experiences.length, 1);
  assert.equal(bundleAfterResume.educations.length, 1);
  assert.equal(bundleAfterResume.projects.length, 2);
  console.log('✓ Step 4: Resume parsed factually into Profile, Skills, Experience, Education & Projects');

  // 5. Candidate provides Job Search Preferences
  const turn4 = await miloAgent.handleUserMessage({
    slackUserId: 'U_CANDIDATE_01',
    slackUserName: 'atharv',
    text: 'Roles: Full Stack Developer, Backend Engineer, Software Engineer Intern | Locations: Bangalore, Remote | Types: both | Work mode: remote | Min salary: INR 45,000/month',
  });
  assert.equal(turn4.user.onboardingStage, 'REVIEW_PROFILE');
  console.log('✓ Step 5: Job search preferences parsed and moved to REVIEW_PROFILE');

  // 6. Candidate edits a field before confirming
  const turn5 = await miloAgent.handleUserMessage({
    slackUserId: 'U_CANDIDATE_01',
    slackUserName: 'atharv',
    text: 'edit roles: Full Stack Developer, Backend Engineer, SDE Intern, AI Engineer Intern',
  });
  assert.ok(turn5.replyText.includes('Updated **roles**'));
  const updatedProfile = dbRepo.getCandidateProfile(turn5.user.id);
  assert.equal(updatedProfile?.preferredRoles.length, 4);
  console.log('✓ Step 6: Candidate profile review & correction verified');

  // 7. Candidate confirms profile -> completes onboarding and syncs `.crawljob/profile.json`
  const tempCrawlJobProfile = './.talentloop/test-crawljob-profile.json';
  process.env.CRAWLJOB_PROFILE_PATH = tempCrawlJobProfile;

  const turn6 = await miloAgent.handleUserMessage({
    slackUserId: 'U_CANDIDATE_01',
    slackUserName: 'atharv',
    text: 'confirm',
  });
  assert.equal(turn6.user.onboardingCompleted, true);
  assert.equal(turn6.user.onboardingStage, 'COMPLETED');
  assert.ok(fs.existsSync(tempCrawlJobProfile), 'crawlJob profile.json must be written on disk');

  const syncedJson = JSON.parse(fs.readFileSync(tempCrawlJobProfile, 'utf8'));
  assert.equal(syncedJson.name, 'Atharv Gaur');
  assert.equal(syncedJson.email, 'atharv@talentloop.dev');
  assert.equal(syncedJson.expectedSalary, 'INR 45,000/month');
  assert.deepEqual(syncedJson.jobPreferences.roles, [
    'Full Stack Developer',
    'Backend Engineer',
    'SDE Intern',
    'AI Engineer Intern',
  ]);
  console.log('✓ Step 7: Onboarding completed and synced to crawlJob profile.json format');

  await switchCoordinator.shutdown();
  console.log('=== All Phase 2 Tests Passed! ===');
}

runPhase2Tests().catch((err) => {
  console.error('Phase 2 test failed:', err);
  process.exit(1);
});
