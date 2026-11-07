import { dbRepo, getDb } from '../db';
import type { UserRecord, WorkflowRecord } from '../db/schema';
import { parseResumeContent } from '../onboarding/resume-parser';
import {
  buildCandidateContext,
  syncCandidateProfileToCrawlJobDisk,
} from '../onboarding/profile-sync';
import { switchCoordinator } from '../switch/coordinator';
import { slackClient } from '../slack/client';
import { analyzeTurnWithTeammateBrain } from './teammate-brain';
import type { SwitchAttachmentPointer } from '../switch/protocol-client';

export const MILO_WELCOME_MESSAGE = `👋 *Hey! Welcome to TalentLoop Onboarding (\`#talentloop-onboarding\`).*
I'm *Milo*, your Talent Manager. Once we set up your profile here, I'll provision your own dedicated *#talentloop-job-search-<your-name>* channel and bring in your 6-agent AI team over Switch:

• 🧭 *@milo (Talent Manager)* — Coordinates your job search workflows, approvals & consolidated reports
• 🔍 *@scout (Opportunity Discovery)* — Finds, deduplicates & ranks live job and internship openings matching your resume
• 🚀 *@wally (Wellfound Specialist)* — Automates Wellfound applications in your local Playwright browser (\`crawlJob\`)
• 🎓 *@inky (Internshala Specialist)* — Automates Internshala internships & jobs in your local browser (\`crawlJob\`)
• 🍀 *@clover (Founder Intelligence)* — Researches funded YC startups & verifies public founder business emails
• ✉️ *@pip (Gmail Outreach)* — Drafts & sends approved personalized cold emails via your Gmail OAuth2 account

*Before we start, what brings you here?*
1️⃣ *I'm looking for a job / internship* _(Reply \`1\` to begin Job Seeker onboarding)_
2️⃣ *I'm hiring candidates* _(Reply \`2\`)_`;

export interface MiloTurnResult {
  user: UserRecord;
  replyText: string;
  workflow?: WorkflowRecord;
  triggeredTasks?: string[];
  approvalUpdatedId?: string;
}

/**
 * Milo — Talent Manager Agent Runtime
 * Handles Slack user turns, onboarding state machine, human approval commands,
 * natural-language workflow planning, Switch delegation, and consolidated reporting.
 */
export class MiloAgent {
  public async handleUserMessage(params: {
    slackUserId: string;
    slackUserName: string;
    slackTeamId?: string | null;
    slackChannelId?: string | null;
    threadTs?: string | null;
    text: string;
    attachments?: SwitchAttachmentPointer[];
    uploadedResumeText?: string | null;
  }): Promise<MiloTurnResult> {
    await switchCoordinator.ensureInitialized();

    const user = dbRepo.getOrCreateUserBySlack({
      slackUserId: params.slackUserId,
      slackTeamId: params.slackTeamId ?? null,
      slackUsername: params.slackUserName,
      switchParticipantId: `@switch-user-${params.slackUserId.toLowerCase()}:talentloop.local`,
    });

    const trimmed = params.text.trim();
    const onboardingChannelId = slackClient.getOnboardingChannelId();
    const isMessageInOnboardingChannel = Boolean(
      onboardingChannelId && params.slackChannelId === onboardingChannelId,
    );

    if (
      !isMessageInOnboardingChannel &&
      params.slackChannelId &&
      params.slackChannelId !== 'C_TALENTLOOP_JOB_SEARCH' &&
      user.dedicatedSlackChannelId !== params.slackChannelId
    ) {
      dbRepo.setUserDedicatedWorkspace({
        userId: user.id,
        slackChannelId: params.slackChannelId,
        slackChannelName: user.dedicatedSlackChannelName || 'talentloop-job-search',
        switchRoomId: user.dedicatedSwitchRoomId || switchCoordinator.getRoomId(),
      });
    }

    // Relay user message into the Switch room so the shared room log records the user's turn
    // and routes `addressed: true` over Switch WebSockets to whichever agent(s) were mentioned!
    await switchCoordinator.relayInboundSlackMessage({
      slackUserId: params.slackUserId,
      slackUserName: params.slackUserName,
      text: trimmed || '[Uploaded attachment]',
      threadTs: params.threadTs,
      attachments: params.attachments,
    });

    // =========================================================================
    // CHANNEL RULE 1: #talentloop-onboarding is STRICTLY for Onboarding,
    // Agent Explanation, and Profile Updation! Never run job-search workflows here.
    // =========================================================================
    if (isMessageInOnboardingChannel) {
      // Check if user is editing a specific profile field (`edit roles: ...`, `edit portfolio: ...`)
      if (
        /^(edit|update|correct)\s+(name|email|phone|location|roles|skills|locations|types|work\s*mode|salary|github|linkedin|portfolio)\s*:/i.test(
          trimmed,
        )
      ) {
        return this.handleProfileEditCommand(
          user,
          trimmed,
          params.slackChannelId,
          params.threadTs,
        );
      }

      // If user says "hi", "onboard", "update profile", "1", "2", or uploads a resume in #talentloop-onboarding,
      // ensure they enter/continue the onboarding & profile-update state machine!
      const startsOrRestartsOnboarding =
        /^(hi|hello|hey|onboard|start|reset|update\s+profile|1|2|job\s*seeker|hiring)\b/i.test(
          trimmed,
        );

      let activeUser = user;
      if (activeUser.onboardingCompleted && startsOrRestartsOnboarding) {
        activeUser = dbRepo.updateUserOnboarding(user.id, {
          roleSelection: 'UNSELECTED',
          onboardingStage: /^(1|job\s*seeker)/i.test(trimmed)
            ? 'ROLE_SELECTION'
            : 'WELCOME',
          onboardingCompleted: false,
        });
      } else if (activeUser.onboardingCompleted && params.uploadedResumeText) {
        activeUser = dbRepo.updateUserOnboarding(user.id, {
          roleSelection: 'JOB_SEEKER',
          onboardingStage: 'COLLECT_RESUME',
          onboardingCompleted: false,
        });
      }

      if (!activeUser.onboardingCompleted) {
        return this.handleOnboardingTurn({
          user: activeUser,
          text: trimmed,
          uploadedResumeText: params.uploadedResumeText ?? null,
          attachments: params.attachments ?? [],
          slackChannelId: params.slackChannelId,
          threadTs: params.threadTs,
        });
      }

      // Otherwise, user is already onboarded and sent a non-onboarding message inside #talentloop-onboarding:
      // Redirect them to their job-search channel!
      const targetJobChannel =
        activeUser.dedicatedSlackChannelId ||
        process.env.SLACK_DEFAULT_CHANNEL_ID?.trim() ||
        'C0CFKURKNMT';

      const redirectMsg = `ℹ️ *\`#talentloop-onboarding\` is only for profile setup, resume updates, and agent explanation.*
Your profile (*${activeUser.fullName}*) is already set up!

👉 *Head over to <#${targetJobChannel}> — there you can start with:*
• \`@scout find full stack jobs\` — Discover & shortlist matching openings
• \`@inky apply to internshala jobs\` — Search unapplied Internshala matches & apply
• \`@wally apply to wellfound jobs\` — Run Wellfound browser automation
• \`@clover research startup founders\` — Find funded startups & verify founder emails
• \`@pip draft emails\` / \`@pip send emails\` — Draft & send personalized Gmail outreach
• \`report\` — View your consolidated progress report

_(Need to update your resume or profile preferences? Reply *\`1\`* or upload a new *.pdf* resume right here in <#${onboardingChannelId}>.)_`;

      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: redirectMsg,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });
      return { user: activeUser, replyText: redirectMsg };
    }

    // =========================================================================
    // CHANNEL RULE 2: Job Search Channel (#talentloop-job-search-<name>)
    // Requires onboarding in #talentloop-onboarding to be completed first!
    // =========================================================================
    if (!user.onboardingCompleted) {
      const gateMsg = onboardingChannelId
        ? `🔒 *Please Complete Onboarding First*\nHead over to <#${onboardingChannelId}> and reply *\`1\`* to upload your resume, portfolio link, and preferences with me. Once done, I'll unlock your job-search workflows here!`
        : `🔒 *Please Complete Onboarding First*\nReply *\`1\`* to set up your resume, portfolio link, and preferences before running job-search agents.`;
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: gateMsg,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });
      return { user, replyText: gateMsg };
    }

    // 1. Check if this is an Approval Decision command (approve / reject / edit)
    const approvalResult = await this.tryHandleApprovalCommand(
      user,
      trimmed,
      params.slackChannelId,
      params.threadTs,
    );
    if (approvalResult) {
      return approvalResult;
    }

    // 2. Check if user is editing a profile field (`edit roles: ...`, `edit skills: ...`, etc.)
    if (
      /^(edit|update|correct)\s+(name|email|phone|location|roles|skills|locations|types|work\s*mode|salary|github|linkedin|portfolio)\s*:/i.test(
        trimmed,
      )
    ) {
      return this.handleProfileEditCommand(
        user,
        trimmed,
        params.slackChannelId,
        params.threadTs,
      );
    }

    // 3. If the user directly tagged a specialist teammate (@scout, @wally, @inky, @clover, @pip)
    // WITHOUT tagging @milo, let Switch route it directly to that specialist's Switch WebSocket handler!
    // Milo stays quiet so the addressed specialist teammate responds in their own voice!
    const tagsMilo = /@milo\b/i.test(trimmed);
    const taggedSpecialists = (
      ['scout', 'wally', 'inky', 'clover', 'pip'] as const
    ).filter((id) => new RegExp(`@${id}\\b`, 'i').test(trimmed));

    if (taggedSpecialists.length > 0 && !tagsMilo) {
      // Remember the user's active Slack channel so the specialist's reply lands in the exact same channel
      if (params.slackChannelId && user.dedicatedSlackChannelId !== params.slackChannelId) {
        dbRepo.setUserDedicatedWorkspace({
          userId: user.id,
          slackChannelId: params.slackChannelId,
          slackChannelName: user.dedicatedSlackChannelName || 'talentloop-job-search',
          switchRoomId: user.dedicatedSwitchRoomId || switchCoordinator.getRoomId(),
        });
      }
      return {
        user,
        replyText: `[Routed over Switch directly to @${taggedSpecialists.join(', @')}]`,
      };
    }

    // 4. User is talking to @milo (or untagged in the room)!
    if (/^(status|report|summary)$/i.test(trimmed)) {
      const workflows = dbRepo.listWorkflows(user.id);
      if (workflows.length === 0) {
        const msg = `You don't have an active workflow yet. Tell me what roles you're looking for (e.g., *"@scout find backend jobs"* or *"@wally apply to Wellfound jobs"*).`;
        await switchCoordinator.postAgentRoomMessage({
          fromAgent: 'milo',
          content: msg,
          slackChannelId: params.slackChannelId,
          threadId: params.threadTs,
        });
        return { user, replyText: msg };
      }
      const reportText = this.buildConsolidatedReport(workflows[0].id);
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: reportText,
        workflowId: workflows[0].id,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });
      return { user, replyText: reportText, workflow: workflows[0] };
    }

    // Use Milo's Teammate Brain to distinguish casual conversation from workflow delegation!
    const candidateContext = buildCandidateContext(user.id);
    const recentRoomMessages = switchCoordinator
      .getRoomTranscript()
      .slice(-8)
      .map((m) => ({ senderName: m.senderName, body: m.body }));

    const miloBrain = await analyzeTurnWithTeammateBrain({
      agentId: 'milo',
      senderName: user.fullName || params.slackUserName,
      messageText: trimmed,
      candidateContext,
      recentRoomMessages,
    });

    if (miloBrain.intent === 'CHAT_CONVERSATION' && !/^(all|run\s+all)$/i.test(trimmed)) {
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: miloBrain.conversationalReply,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });
      return { user, replyText: miloBrain.conversationalReply };
    }

    // 5. Plan & delegate a multi-agent workflow through Switch
    return this.planAndDelegateWorkflow({
      user,
      naturalLanguageRequest: trimmed,
      slackChannelId: params.slackChannelId,
      threadTs: params.threadTs,
    });
  }

  private async handleOnboardingTurn(params: {
    user: UserRecord;
    text: string;
    uploadedResumeText: string | null;
    attachments: SwitchAttachmentPointer[];
    slackChannelId?: string | null;
    threadTs?: string | null;
  }): Promise<MiloTurnResult> {
    const { user, text, uploadedResumeText, attachments } = params;

    // Stage 1: WELCOME -> send greeting and move to ROLE_SELECTION
    if (user.onboardingStage === 'WELCOME') {
      // Check if their very first message already selects option 1 or 2
      if (/^(1|i'?m looking for a job|job seeker|looking for a job)\b/i.test(text)) {
        const updated = dbRepo.updateUserOnboarding(user.id, {
          roleSelection: 'JOB_SEEKER',
          onboardingStage: 'COLLECT_RESUME',
        });
        const reply = `Awesome! Let's get your **Job Seeker** profile set up so my team (@scout, @wally, @inky, @clover, and @pip) can work for you.\n\nPlease **upload your resume** (or paste your resume text / profile summary here), including your name, email, skills, experience, education, projects, and GitHub/LinkedIn links.`;
        await switchCoordinator.postAgentRoomMessage({
          fromAgent: 'milo',
          content: reply,
          slackChannelId: params.slackChannelId,
          threadId: params.threadTs,
        });
        return { user: updated, replyText: reply };
      }

      if (/^(2|i'?m hiring|hiring|employer)\b/i.test(text)) {
        const updated = dbRepo.updateUserOnboarding(user.id, {
          roleSelection: 'HIRING',
          onboardingStage: 'HIRING_WAITLIST',
        });
        const reply = `Thanks for reaching out! TalentLoop's **Hiring / Employer** experience is coming soon in our next release. For this MVP, we're focused on the **Job Seeker** experience.\n\nIf you'd like to try the Job Seeker experience instead, just reply \`1\` or \`Job Seeker\`!`;
        await switchCoordinator.postAgentRoomMessage({
          fromAgent: 'milo',
          content: reply,
          slackChannelId: params.slackChannelId,
          threadId: params.threadTs,
        });
        return { user: updated, replyText: reply };
      }

      const updated = dbRepo.updateUserOnboarding(user.id, {
        onboardingStage: 'ROLE_SELECTION',
      });
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: MILO_WELCOME_MESSAGE,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });
      return { user: updated, replyText: MILO_WELCOME_MESSAGE };
    }

    // Stage 2: ROLE_SELECTION or HIRING_WAITLIST
    if (
      user.onboardingStage === 'ROLE_SELECTION' ||
      user.onboardingStage === 'HIRING_WAITLIST'
    ) {
      if (
        /^(1|job\s*seeker|looking\s*for\s*a?\s*job|find\s*jobs?|candidate)/i.test(text)
      ) {
        const updated = dbRepo.updateUserOnboarding(user.id, {
          roleSelection: 'JOB_SEEKER',
          onboardingStage: 'COLLECT_RESUME',
        });
        const reply = `Great! Let's set up your *Job Seeker* profile so all 6 agents (@milo, @scout, @wally, @inky, @clover, @pip) are configured for you.

📄 *Step 1 of 3 — Upload Your Resume (.PDF) & Portfolio Link*:
• Attach your *.pdf* resume file (or paste your resume text) right here in this channel.
• In the same message (or after), include your *Portfolio Website URL*, *GitHub URL*, and *LinkedIn URL* if they aren't written in your resume.`;
        await switchCoordinator.postAgentRoomMessage({
          fromAgent: 'milo',
          content: reply,
          slackChannelId: params.slackChannelId,
          threadId: params.threadTs,
        });
        return { user: updated, replyText: reply };
      }

      if (/^(2|hiring|employer|recruiter|i'?m hiring)/i.test(text)) {
        const updated = dbRepo.updateUserOnboarding(user.id, {
          roleSelection: 'HIRING',
          onboardingStage: 'HIRING_WAITLIST',
        });
        const reply = `Thanks for your interest! The **Hiring / Employer** workflow is coming soon in a future update. Right now, TalentLoop supports the **Job Seeker** workflow.\n\nReply \`1\` anytime if you'd like to onboard as a Job Seeker.`;
        await switchCoordinator.postAgentRoomMessage({
          fromAgent: 'milo',
          content: reply,
          slackChannelId: params.slackChannelId,
          threadId: params.threadTs,
        });
        return { user: updated, replyText: reply };
      }

      const nudge = `Please select how you'd like to use TalentLoop:\n1. **I'm looking for a job** (reply \`1\`)\n2. **I'm hiring candidates** (reply \`2\`)`;
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: nudge,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });
      return { user, replyText: nudge };
    }

    // Stage 3: COLLECT_RESUME
    if (user.onboardingStage === 'COLLECT_RESUME') {
      const resumeSourceText = (uploadedResumeText || text).trim();
      if (resumeSourceText.length < 20) {
        const promptMsg = `Please paste your resume text (or upload your resume) with at least your name, email, and key skills so I can parse your profile accurately without guessing.`;
        await switchCoordinator.postAgentRoomMessage({
          fromAgent: 'milo',
          content: promptMsg,
          slackChannelId: params.slackChannelId,
          threadId: params.threadTs,
        });
        return { user, replyText: promptMsg };
      }

      const parsed = parseResumeContent(resumeSourceText);
      const attachmentMeta = attachments[0];

      dbRepo.saveResume({
        userId: user.id,
        filename: attachmentMeta?.filename || 'candidate-resume.txt',
        mimeType: attachmentMeta?.mimetype || 'text/plain',
        fileSize: attachmentMeta?.size || Buffer.byteLength(resumeSourceText, 'utf8'),
        rawText: resumeSourceText,
        parsedJson: JSON.stringify(parsed),
        sourceMxcUrl: attachmentMeta?.mxc ?? null,
      });

      const resolvedName =
        parsed.fullName || user.fullName || user.slackUsername || 'Candidate';
      const resolvedEmail = parsed.email || user.email || `${user.slackUserId.toLowerCase()}@example.com`;

      // Also check if the user typed an explicit Portfolio/GitHub/LinkedIn link in their accompanying Slack message text
      const extraUrls = [...text.matchAll(/https?:\/\/[^\s,;)"<>]+/gi)].map((m) =>
        m[0].replace(/,+$/, ''),
      );
      const extraPortfolio =
        extraUrls.find(
          (u) =>
            !u.toLowerCase().includes('github.com') &&
            !u.toLowerCase().includes('linkedin.com') &&
            !u.toLowerCase().includes('slack.com'),
        ) ?? null;

      const profile = dbRepo.upsertCandidateProfile(user.id, {
        fullName: resolvedName,
        email: resolvedEmail,
        phone: parsed.phone,
        location: parsed.location,
        headline: parsed.headline,
        summary: parsed.summary,
        experienceLevel: parsed.experienceLevel,
        yearsOfExperience: parsed.yearsOfExperience,
        preferredRoles: [],
        preferredLocations: parsed.location ? [parsed.location] : ['any'],
        preferredJobTypes: ['full-time', 'internship'],
        workModePreference: 'any',
        minSalaryText: null,
        minSalaryAmount: null,
        salaryCurrency: null,
        portfolioUrl: extraPortfolio || parsed.links.portfolio,
        githubUrl: parsed.links.github,
        linkedinUrl: parsed.links.linkedin,
      });

      dbRepo.replaceProfileCollections(user.id, profile.id, {
        skills: parsed.skills,
        experiences: parsed.experiences,
        educations: parsed.educations,
        projects: parsed.projects,
      });

      const updatedUser = dbRepo.updateUserOnboarding(user.id, {
        fullName: resolvedName,
        email: resolvedEmail,
        phone: parsed.phone,
        onboardingStage: 'COLLECT_PREFERENCES',
      });

      const skillsList =
        parsed.skills.length > 0
          ? parsed.skills.map((s) => s.name).join(', ')
          : 'None detected (you can add them with `edit skills: ...`)';

      const reply = `✅ *I've parsed your resume!* Here is what I extracted factually:
• *Name:* ${resolvedName}
• *Email:* ${resolvedEmail}
• *Phone:* ${parsed.phone ?? 'Not listed'}
• *Location:* ${parsed.location ?? 'Not listed'}
• *Experience Level:* ${parsed.experienceLevel} (${parsed.yearsOfExperience ?? 0} yrs)
• *Skills (${parsed.skills.length}):* ${skillsList}
• *Work Experience:* ${parsed.experiences.map((e) => `${e.role} @ ${e.company}`).join(' | ') || `${parsed.experiences.length} entries`}
• *Projects:* ${parsed.projects.map((p) => p.name).join(', ') || 'None detected'}
• *Links:* GitHub: ${parsed.links.github ?? '—'} | LinkedIn: ${parsed.links.linkedin ?? '—'} | Portfolio: ${profile.portfolioUrl ?? '—'}

🎯 *Step 2 of 3 — Your Job Search Preferences & Portfolio*:
Reply in one message with:
• *Roles:* (e.g. \`Full Stack Developer, Backend Engineer, SDE Intern\`)
• *Locations:* (e.g. \`Bangalore, Remote, India\`)
• *Types:* (\`internship\`, \`full-time\`, or \`both\`)
• *Work mode:* (\`remote\`, \`hybrid\`, \`onsite\`, or \`any\`)
• *Min salary/stipend:* (e.g. \`INR 40,000/month\` or \`INR 12 LPA\`)
• *Portfolio:* (optional, e.g. \`https://yourportfolio.dev\`)`;

      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: reply,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });

      return { user: updatedUser, replyText: reply };
    }

    // Stage 4: COLLECT_PREFERENCES
    if (user.onboardingStage === 'COLLECT_PREFERENCES') {
      const currentProfile = dbRepo.getCandidateProfile(user.id);
      if (!currentProfile) {
        throw new Error('Candidate profile missing during COLLECT_PREFERENCES');
      }

      const prefs = parsePreferencesText(text);

      const updatedProfile = dbRepo.upsertCandidateProfile(user.id, {
        ...currentProfile,
        preferredRoles:
          prefs.roles.length > 0
            ? prefs.roles
            : ['Software Engineer', 'Full Stack Developer'],
        preferredLocations:
          prefs.locations.length > 0
            ? prefs.locations
            : currentProfile.preferredLocations,
        preferredJobTypes: prefs.jobTypes,
        workModePreference: prefs.workMode,
        minSalaryText: prefs.minSalaryText ?? currentProfile.minSalaryText,
        minSalaryAmount: prefs.minSalaryAmount ?? currentProfile.minSalaryAmount,
        salaryCurrency: prefs.salaryCurrency ?? currentProfile.salaryCurrency,
        portfolioUrl: prefs.portfolioUrl ?? currentProfile.portfolioUrl,
      });

      const updatedUser = dbRepo.updateUserOnboarding(user.id, {
        onboardingStage: 'REVIEW_PROFILE',
      });

      const bundle = dbRepo.getCandidateFullBundle(user.id);
      const baseUrl =
        process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3000';
      const gmailOAuthUrl = `${baseUrl}/api/auth/gmail?userId=${encodeURIComponent(
        user.id,
      )}`;

      const reply = `🔍 *Step 3 of 3 — Review Profile & Connect Gmail OAuth2 (@pip)*:

• *Full Name:* ${updatedProfile.fullName}
• *Email:* ${updatedProfile.email}
• *Phone:* ${updatedProfile.phone ?? '—'}
• *Skills:* ${bundle.skills.map((s) => s.name).join(', ') || '—'}
• *Target Roles:* ${updatedProfile.preferredRoles.join(', ')}
• *Preferred Locations:* ${updatedProfile.preferredLocations.join(', ')}
• *Job Types:* ${updatedProfile.preferredJobTypes.join(', ')}
• *Work Mode:* ${updatedProfile.workModePreference}
• *Minimum Salary/Stipend:* ${updatedProfile.minSalaryText ?? 'Not specified'}
• *Links:* GitHub: ${updatedProfile.githubUrl ?? '—'} | LinkedIn: ${updatedProfile.linkedinUrl ?? '—'} | Portfolio: ${updatedProfile.portfolioUrl ?? '—'}
• *Gmail OAuth (@pip):* ${
        updatedUser.gmailConnected
          ? `✅ Connected (${updatedUser.gmailEmail})`
          : `<${gmailOAuthUrl}|🔐 Click Here to Authorize Gmail Access (Google OAuth 2.0) ↗>`
      }

You can edit any field right now (e.g. \`edit portfolio: https://...\` or \`edit roles: ...\`), click the link above to authorize Gmail for *@pip*, and reply *\`confirm\`* to unlock your personal *#talentloop-job-search* channel!`;

      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: reply,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });

      return { user: updatedUser, replyText: reply };
    }

    // Stage 5: REVIEW_PROFILE
    if (user.onboardingStage === 'REVIEW_PROFILE') {
      if (/^(confirm|yes|looks good|approve|done|start|ok)\b/i.test(text)) {
        const synced = syncCandidateProfileToCrawlJobDisk(user.id);
        const bundle = dbRepo.getCandidateFullBundle(user.id);

        // Provision the user's dedicated personal Slack channel & Switch room!
        const provisionedChannel = await slackClient.provisionUserJobSearchChannel({
          slackUserId: user.slackUserId,
          fullName: synced.profile.name,
          preferredRoles: synced.profile.jobPreferences.roles,
          skills: synced.profile.skills,
        });

        const provisionedSwitchRoom = await switchCoordinator.provisionUserSwitchRoom({
          roomName: provisionedChannel.channelName,
          userFullName: synced.profile.name,
        });

        dbRepo.setUserDedicatedWorkspace({
          userId: user.id,
          slackChannelId: provisionedChannel.channelId,
          slackChannelName: provisionedChannel.channelName,
          switchRoomId: provisionedSwitchRoom,
        });

        const updatedUser = dbRepo.updateUserOnboarding(user.id, {
          onboardingStage: 'COMPLETED',
          onboardingCompleted: true,
        });

        dbRepo.createNotification({
          userId: user.id,
          level: 'SUCCESS',
          title: 'Onboarding Completed & Personal Channel Provisioned',
          message: `Provisioned #${provisionedChannel.channelName} (${provisionedChannel.channelId}) and synced crawlJob profile.`,
        });

        const baseUrl =
          process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3000';
        const gmailOAuthUrl = `${baseUrl}/api/auth/gmail?userId=${encodeURIComponent(
          user.id,
        )}`;

        const onboardingReply = `🎉 *Onboarding & Profile Setup Complete, <@${user.slackUserId}>!*
• Your resume, portfolio, and job preferences are saved and synced to \`crawlJob\` (\`${synced.profile.jobPreferences.roles.join(', ')}\`).
${
  !updatedUser.gmailConnected
    ? `• ✉️ *Gmail OAuth for @pip:* <${gmailOAuthUrl}|Click here to authorize Gmail sending ↗>\n`
    : `• ✉️ *Gmail OAuth for @pip:* Connected (${updatedUser.gmailEmail}) ✓\n`
}
This channel (\`#talentloop-onboarding\`) is strictly for profile updates and agent explanations.

👉 *Head over to your personal job-search channel <#${provisionedChannel.channelId}> — here you can start with:*
• \`@scout find full stack jobs\`
• \`@inky apply to internshala jobs\`
• \`@wally apply to wellfound jobs\`
• \`@clover research startup founders\`
• \`@pip draft emails\` / \`@pip send emails\`
• \`report\``;

        await switchCoordinator.postAgentRoomMessage({
          fromAgent: 'milo',
          content: onboardingReply,
          slackChannelId: params.slackChannelId,
          threadId: params.threadTs,
        });

        // Also post the kickoff welcome inside their newly provisioned personal channel!
        if (
          provisionedChannel.channelId &&
          provisionedChannel.channelId !== params.slackChannelId
        ) {
          const personalKickoff = `🚀 *Welcome to your personal job-search channel, <@${user.slackUserId}>!*
Your profile is loaded (*${synced.profile.jobPreferences.roles.join(', ')}* · *${bundle.skills.slice(0, 6).map((s) => s.name).join(', ')}*).

*Here you can start with:*
• \`@scout find jobs\` — Discover & rank fresh openings matching your resume
• \`@inky apply to internshala jobs\` — Search unapplied Internshala matches & apply in your browser
• \`@wally apply to wellfound jobs\` — Run Wellfound automation in your browser
• \`@clover research startup founders\` — Find funded YC startups & verify founder emails
• \`@pip draft emails\` / \`@pip send emails\` — Draft & send personalized Gmail cold outreach
• \`report\` — Get your consolidated progress report`;

          await slackClient.postAgentMessage({
            agentId: 'milo',
            channel: provisionedChannel.channelId,
            text: personalKickoff,
          });
        }

        return { user: updatedUser, replyText: onboardingReply };
      }

      const nudge = `Reply **\`confirm\`** if your profile looks accurate, or update any field with \`edit <field>: <value>\` (e.g., \`edit roles: Full Stack Developer, SDE Intern\`).`;
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: nudge,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });
      return { user, replyText: nudge };
    }

    return { user, replyText: MILO_WELCOME_MESSAGE };
  }

  private async handleProfileEditCommand(
    user: UserRecord,
    text: string,
    slackChannelId?: string | null,
    threadTs?: string | null,
  ): Promise<MiloTurnResult> {
    const match = text.match(
      /^(?:edit|update|correct)\s+(name|email|phone|location|roles|skills|locations|types|work\s*mode|salary|github|linkedin|portfolio)\s*:\s*(.+)$/i,
    );
    const profile = dbRepo.getCandidateProfile(user.id);
    if (!match || !profile) {
      const msg = `Could not parse edit command. Use \`edit roles: Role A, Role B\` or \`edit skills: Skill 1, Skill 2\`.`;
      return { user, replyText: msg };
    }

    const field = match[1].toLowerCase().replace(/\s+/g, '');
    const value = match[2].trim();
    const listValues = value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

    if (field === 'skills') {
      dbRepo.replaceProfileCollections(user.id, profile.id, {
        skills: listValues.map((name) => ({ name, category: 'technical' })),
      });
    } else {
      dbRepo.upsertCandidateProfile(user.id, {
        ...profile,
        fullName: field === 'name' ? value : profile.fullName,
        email: field === 'email' ? value : profile.email,
        phone: field === 'phone' ? value : profile.phone,
        location: field === 'location' ? value : profile.location,
        preferredRoles: field === 'roles' ? listValues : profile.preferredRoles,
        preferredLocations:
          field === 'locations' ? listValues : profile.preferredLocations,
        preferredJobTypes:
          field === 'types'
            ? (listValues.filter((t) =>
                ['full-time', 'internship', 'part-time', 'contract', 'any'].includes(
                  t.toLowerCase(),
                ),
              ) as typeof profile.preferredJobTypes)
            : profile.preferredJobTypes,
        workModePreference:
          field === 'workmode' &&
          ['remote', 'hybrid', 'onsite', 'any'].includes(value.toLowerCase())
            ? (value.toLowerCase() as typeof profile.workModePreference)
            : profile.workModePreference,
        minSalaryText: field === 'salary' ? value : profile.minSalaryText,
        githubUrl: field === 'github' ? value : profile.githubUrl,
        linkedinUrl: field === 'linkedin' ? value : profile.linkedinUrl,
        portfolioUrl: field === 'portfolio' ? value : profile.portfolioUrl,
      });
    }

    if (user.onboardingCompleted) {
      syncCandidateProfileToCrawlJobDisk(user.id);
    }

    const reply = `✅ Updated **${field}** to: \`${value}\`.${
      user.onboardingStage === 'REVIEW_PROFILE'
        ? ' Reply **`confirm`** when you are ready to finish onboarding.'
        : ''
    }`;
    await switchCoordinator.postAgentRoomMessage({
      fromAgent: 'milo',
      content: reply,
      slackChannelId,
      threadId: threadTs,
    });
    return { user, replyText: reply };
  }

  /**
   * Strict, On-Demand Agent Flow Control:
   * Milo delegates ONLY to the exact specialist agent(s) requested by the user.
   * No agent runs unless explicitly tagged or needed for the user's specific command.
   */
  public async planAndDelegateWorkflow(params: {
    user: UserRecord;
    naturalLanguageRequest: string;
    slackChannelId?: string | null;
    threadTs?: string | null;
  }): Promise<MiloTurnResult> {
    const candidateContext = buildCandidateContext(params.user.id);
    if (!candidateContext) {
      throw new Error('Candidate profile is incomplete; please finish onboarding first.');
    }

    syncCandidateProfileToCrawlJobDisk(params.user.id);

    const lowerReq = params.naturalLanguageRequest.toLowerCase();

    // 1. Check explicit @agent tags first
    const taggedScout = /@scout\b/i.test(lowerReq);
    const taggedWally = /@wally\b/i.test(lowerReq);
    const taggedInky = /@inky\b/i.test(lowerReq);
    const taggedClover = /@clover\b/i.test(lowerReq);
    const taggedPip = /@pip\b/i.test(lowerReq);
    const hasExplicitSpecialistTag =
      taggedScout || taggedWally || taggedInky || taggedClover || taggedPip;

    // 2. Determine exact needed agents ONLY (never default to running everything unless user explicitly says "all" / "run all")
    const isRunAll = /^(all|run\s+all|start\s+all|everything)$/i.test(lowerReq.trim());

    const runScout = isRunAll
      ? true
      : hasExplicitSpecialistTag
        ? taggedScout
        : /\b(find|discover|search|shortlist|scrape)\b.*\b(jobs?|internships?|roles?|opportunities|openings)\b/i.test(
            lowerReq,
          );

    const runWally = hasExplicitSpecialistTag
      ? taggedWally
      : /\bapply\b.*\bwellfound\b|\bwellfound\b.*\bapply\b/i.test(lowerReq);

    const runInky = hasExplicitSpecialistTag
      ? taggedInky
      : /\bapply\b.*\binternshala\b|\binternshala\b.*\bapply\b/i.test(lowerReq);

    const runClover = isRunAll
      ? true
      : hasExplicitSpecialistTag
        ? taggedClover
        : /\b(research|find|discover|search)\b.*\b(founders?|startups?|companies|decision[- ]makers?)\b/i.test(
            lowerReq,
          );

    const runPip = hasExplicitSpecialistTag
      ? taggedPip
      : /\b(draft|write|prepare|send)\b.*\b(e?mails?|outreach|cold\s*e?mails?|messages?|founders?)\b/i.test(
          lowerReq,
        );

    const delegatedTargets: string[] = [];
    if (runScout) delegatedTargets.push('@scout');
    if (runWally) delegatedTargets.push('@wally');
    if (runInky) delegatedTargets.push('@inky');
    if (runClover) delegatedTargets.push('@clover');
    if (runPip) delegatedTargets.push('@pip');

    if (delegatedTargets.length === 0) {
      const clarifyMsg = `I want to make sure I only run the exact agent you need. Which specialist should I activate?\n• \`@scout find jobs\` — Discover & rank job/internship openings\n• \`@wally apply to wellfound\` — Apply on Wellfound (\`crawlJob\`)\n• \`@inky apply to internshala\` — Apply on Internshala (\`crawlJob\`)\n• \`@clover research founders\` — Research funded startups & founder emails\n• \`@pip draft emails\` — Draft personalized Gmail cold outreach\n• \`report\` — View your workflow summary`;
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: clarifyMsg,
        slackChannelId: params.slackChannelId,
        threadId: params.threadTs,
      });
      return { user: params.user, replyText: clarifyMsg };
    }

    const workflow = dbRepo.createWorkflow({
      userId: params.user.id,
      title: `Workflow (${delegatedTargets.join(', ')}): ${params.naturalLanguageRequest.slice(0, 50)}`,
      naturalLanguageRequest: params.naturalLanguageRequest,
      switchRoomId: switchCoordinator.getRoomId(),
      slackChannelId: params.slackChannelId ?? null,
      slackThreadTs: params.threadTs ?? null,
    });

    dbRepo.updateWorkflowStatus(workflow.id, 'RUNNING');

    const planAnnouncement = `Delegating to *${delegatedTargets.join(', ')}* in Switch room \`${switchCoordinator.getRoomId()}\`...`;

    await switchCoordinator.postAgentRoomMessage({
      fromAgent: 'milo',
      content: planAnnouncement,
      workflowId: workflow.id,
      slackChannelId: params.slackChannelId,
      threadId: params.threadTs,
    });

    const triggeredTasks: string[] = [];

    // --- Agent 4: @scout (Only when requested) ---
    if (runScout) {
      const requestedPlatforms: Array<
        'linkedin' | 'internshala' | 'wellfound' | 'yc' | 'arbeitnow'
      > = [];
      if (/\blinkedin\b/i.test(lowerReq)) requestedPlatforms.push('linkedin');
      if (/\binternshala\b/i.test(lowerReq)) requestedPlatforms.push('internshala');
      if (/\bwellfound\b/i.test(lowerReq)) requestedPlatforms.push('wellfound');
      if (/\byc\b|\by\s*combinator\b/i.test(lowerReq)) requestedPlatforms.push('yc');

      // Extract specific role or location from the user's natural-language message (e.g. "search for any Backend Intern position in Delhi")
      const locOverrideMatch = params.naturalLanguageRequest.match(
        /\bin\s+([A-Z][a-zA-Z\s]{2,25}?)(?:\?|\.|$|\s+on\s+|\s+for\s+)/,
      );
      const roleOverrideMatch = params.naturalLanguageRequest.match(
        /(?:for\s+(?:any\s+|a\s+)?|find\s+|search\s+(?:for\s+)?(?:any\s+)?)([A-Za-z0-9\s/-]{3,35}?\b(?:Intern(?:ship)?|Developer|Engineer|SDE|Designer|Analyst))\b/i,
      );

      const effectiveRoles = roleOverrideMatch?.[1]
        ? [roleOverrideMatch[1].trim(), ...candidateContext.preferredRoles]
        : candidateContext.preferredRoles;

      const effectiveLocations = locOverrideMatch?.[1]
        ? [locOverrideMatch[1].trim()]
        : candidateContext.preferredLocations;

      const scoutTask = await switchCoordinator.delegateTaskOverSwitch({
        workflowId: workflow.id,
        requestingAgent: 'milo',
        assignedAgent: 'scout',
        userId: params.user.id,
        taskType: 'DISCOVER_OPPORTUNITIES',
        input: {
          queryRoles: effectiveRoles,
          locations: effectiveLocations,
          jobTypes: /\bintern(ship)?\b/i.test(lowerReq)
            ? ['internship']
            : candidateContext.preferredJobTypes,
          workMode: locOverrideMatch?.[1]
            ? 'any'
            : candidateContext.workModePreference,
          maxResults: 20,
          ...(requestedPlatforms.length > 0
            ? { platforms: requestedPlatforms }
            : {}),
        },
        candidateContext: {
          ...candidateContext,
          preferredRoles: effectiveRoles,
          preferredLocations: effectiveLocations,
          ...(locOverrideMatch?.[1] ? { workModePreference: 'any' } : {}),
        },
        expectedOutput: 'ScoutTaskOutputSchema',
        humanSummary: `Discover, deduplicate, and rank ${
          requestedPlatforms.length > 0
            ? requestedPlatforms.join(', ').toUpperCase()
            : 'LinkedIn, Internshala & YC'
        } openings for ${candidateContext.fullName} targeting [${effectiveRoles.slice(0, 2).join(', ')}] in [${effectiveLocations.join(', ')}].`,
        threadId: params.threadTs,
      });
      triggeredTasks.push(scoutTask.taskId);
    }

    // --- Agent 5: @clover (Only when requested) ---
    if (runClover) {
      const cloverTask = await switchCoordinator.delegateTaskOverSwitch({
        workflowId: workflow.id,
        requestingAgent: 'milo',
        assignedAgent: 'clover',
        userId: params.user.id,
        taskType: 'RESEARCH_FOUNDERS',
        input: {
          targetRoles: candidateContext.preferredRoles,
          includeRecentlyFunded: true,
          maxContacts: 10,
        },
        candidateContext,
        expectedOutput: 'CloverTaskOutputSchema',
        humanSummary: `Research recently funded & actively hiring startups and verify founder contacts relevant to ${candidateContext.fullName}.`,
        threadId: params.threadTs,
      });
      triggeredTasks.push(cloverTask.taskId);
    }

    // --- Agent 2 & 3: @wally or @inky (Self-contained search of unapplied resume matches + execution) ---
    if (runInky || runWally) {
      const targetAgent = runInky ? 'inky' : 'wally';

      const prepTask = dbRepo.createAgentTask({
        workflowId: workflow.id,
        requestingAgent: 'milo',
        assignedAgent: targetAgent,
        userId: params.user.id,
        taskType:
          targetAgent === 'wally'
            ? 'PREPARE_WELLFOUND_BATCH'
            : 'PREPARE_INTERNSHALA_BATCH',
        input: {},
        candidateContext,
        expectedOutput:
          targetAgent === 'wally' ? 'WallyTaskOutputSchema' : 'InkyTaskOutputSchema',
      });

      const directApproval = dbRepo.createApproval({
        workflowId: workflow.id,
        taskId: prepTask.taskId,
        userId: params.user.id,
        actionType: 'BATCH_APPLICATION',
        requestedByAgent: 'milo',
        targetAgent,
        title: `Direct ${targetAgent === 'wally' ? 'Wellfound' : 'Internshala'} Run (@${targetAgent})`,
        summaryText: `User commanded @${targetAgent}: "${params.naturalLanguageRequest}"`,
        payload: {
          mode: 'both',
          jobs: [],
          listings: [],
          applicationAgentMode: 'auto-submit',
        },
      });

      dbRepo.decideApproval({
        approvalId: directApproval.id,
        status: 'APPROVED',
        decidedBySlackUserId: params.user.slackUserId,
        decisionNote: `Authorized by user via direct @${targetAgent} command in Slack`,
      });

      const appTask = await switchCoordinator.delegateTaskOverSwitch({
        workflowId: workflow.id,
        requestingAgent: 'milo',
        assignedAgent: targetAgent,
        userId: params.user.id,
        taskType:
          targetAgent === 'wally'
            ? 'APPLY_WELLFOUND_BATCH'
            : 'APPLY_INTERNSHALA_BATCH',
        input: {
          approvalId: directApproval.id,
          mode: 'both',
          jobs: [],
          listings: [],
          applicationAgentMode: 'auto-submit',
        },
        candidateContext,
        expectedOutput:
          targetAgent === 'wally' ? 'WallyTaskOutputSchema' : 'InkyTaskOutputSchema',
        humanSummary: `Search unapplied ${targetAgent === 'wally' ? 'Wellfound' : 'Internshala'} roles matching ${candidateContext.fullName}'s resume and apply.`,
        threadId: params.threadTs,
      });
      triggeredTasks.push(appTask.taskId);
    }

    // --- Agent 6: @pip (Only when requested, using existing founders from @clover) ---
    if (runPip) {
      const db = getDb();
      const verifiedFounderRows = db
        .prepare(
          'SELECT * FROM founder_contacts WHERE email_verified_public = 1 AND public_email IS NOT NULL ORDER BY confidence_score DESC LIMIT 10',
        )
        .all() as Array<Record<string, unknown>>;

      if (verifiedFounderRows.length === 0) {
        await switchCoordinator.postAgentRoomMessage({
          fromAgent: 'milo',
          content: `ℹ️ **No verified founder emails in your database yet.**\nRun **\`@clover research founders\`** first so @clover can discover startups and verify founder business emails, then run **\`@pip draft emails\`**.`,
          workflowId: workflow.id,
          slackChannelId: params.slackChannelId,
          threadId: params.threadTs,
        });
      } else {
        const campaignId = `cmpgn_${crypto.randomUUID().slice(0, 10)}`;
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO outreach_campaigns (
            id, user_id, workflow_id, name, target_role, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        `).run(
          campaignId,
          params.user.id,
          workflow.id,
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

        const pipDraftTask = await switchCoordinator.delegateTaskOverSwitch({
          workflowId: workflow.id,
          requestingAgent: 'milo',
          assignedAgent: 'pip',
          userId: params.user.id,
          taskType: 'DRAFT_OUTREACH_EMAILS',
          input: {
            campaignId,
            contacts: contactsPayload,
          },
          candidateContext,
          expectedOutput: 'PipDraftTaskOutputSchema',
          humanSummary: `Draft personalized cold outreach emails for **${contactsPayload.length}** verified founder contact(s) and pause for human approval before sending.`,
          threadId: params.threadTs,
        });
        triggeredTasks.push(pipDraftTask.taskId);
      }
    }

    return {
      user: params.user,
      replyText: planAnnouncement,
      workflow,
      triggeredTasks,
    };
  }

  /**
   * Handles Slack approval commands:
   * - `approve <approvalId>` or `approve all`
   * - `reject <approvalId> [reason]`
   * - `edit <approvalId> subject: ... | body: ...`
   */
  private async tryHandleApprovalCommand(
    user: UserRecord,
    text: string,
    slackChannelId?: string | null,
    threadTs?: string | null,
  ): Promise<MiloTurnResult | null> {
    const approveMatch = text.match(/^(approve|reject|edit\s+approval)\s+(apr_[a-zA-Z0-9_-]+|all)(?:\s+(.*))?$/i);
    if (!approveMatch) return null;

    const verb = approveMatch[1].toLowerCase();
    const targetId = approveMatch[2];
    const extraText = approveMatch[3]?.trim() ?? '';

    const pendingApprovals =
      targetId.toLowerCase() === 'all'
        ? dbRepo.listApprovals({ status: 'PENDING' })
        : [dbRepo.getApproval(targetId)].filter(
            (a): a is NonNullable<typeof a> => Boolean(a && a.status === 'PENDING'),
          );

    if (pendingApprovals.length === 0) {
      const msg = `No pending approval found matching \`${targetId}\`.`;
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: msg,
        slackChannelId,
        threadId: threadTs,
      });
      return { user, replyText: msg };
    }

    const decisionStatus =
      verb === 'reject'
        ? 'REJECTED'
        : verb.startsWith('edit')
          ? 'EDITED'
          : 'APPROVED';

    const processedIds: string[] = [];

    for (const approval of pendingApprovals) {
      let editedPayload: unknown = undefined;
      if (decisionStatus === 'EDITED' && extraText) {
        const currentPayload = JSON.parse(approval.payloadJson);
        editedPayload = { ...currentPayload, userEdits: extraText };
      }

      const updated = dbRepo.decideApproval({
        approvalId: approval.id,
        status: decisionStatus,
        decidedBySlackUserId: user.slackUserId,
        decisionNote: extraText || `User ${decisionStatus.toLowerCase()} via Slack`,
        editedPayload,
      });
      processedIds.push(updated.id);

      dbRepo.logAgentEvent({
        workflowId: approval.workflowId,
        taskId: approval.taskId,
        agentId: 'milo',
        eventType: `APPROVAL_${decisionStatus}`,
        switchRoomId: switchCoordinator.getRoomId(),
        summary: `User ${user.slackUserId} ${decisionStatus} ${approval.actionType} (${approval.id}) for @${approval.targetAgent}`,
        payload: { approvalId: approval.id, actionType: approval.actionType },
      });

      // Notify the target specialist agent (@wally, @inky, or @pip) over Switch if APPROVED or EDITED
      if (decisionStatus === 'APPROVED' || decisionStatus === 'EDITED') {
        const approvalOwnerId = approval.userId || user.id;
        const candidateContext =
          buildCandidateContext(approvalOwnerId) ?? buildCandidateContext(user.id)!;
        const payloadData = editedPayload ?? JSON.parse(approval.payloadJson);

        if (approval.actionType === 'BATCH_APPLICATION') {
          const taskType =
            approval.targetAgent === 'wally'
              ? 'APPLY_WELLFOUND_BATCH'
              : 'APPLY_INTERNSHALA_BATCH';

          await switchCoordinator.delegateTaskOverSwitch({
            workflowId: approval.workflowId,
            requestingAgent: 'milo',
            assignedAgent: approval.targetAgent,
            userId: approvalOwnerId,
            taskType,
            input: {
              ...payloadData,
              approvalId: approval.id,
            },
            candidateContext,
            expectedOutput:
              approval.targetAgent === 'wally'
                ? 'WallyTaskOutputSchema'
                : 'InkyTaskOutputSchema',
            humanSummary: `Human approval \`${approval.id}\` granted by <@${user.slackUserId}>! Execute approved ${approval.targetAgent === 'wally' ? 'Wellfound' : 'Internshala'} applications via the Local Companion.`,
            threadId: threadTs,
          });
        } else if (
          approval.actionType === 'SEND_EMAIL' ||
          approval.actionType === 'FOLLOW_UP_EMAIL'
        ) {
          await switchCoordinator.delegateTaskOverSwitch({
            workflowId: approval.workflowId,
            requestingAgent: 'milo',
            assignedAgent: 'pip',
            userId: approvalOwnerId,
            taskType: 'SEND_APPROVED_EMAILS',
            input: {
              approvalId: approval.id,
              draftIds: payloadData.draftIds ?? [],
              userEdits: extraText || undefined,
            },
            candidateContext,
            expectedOutput: 'PipSendTaskOutputSchema',
            humanSummary: `Human approval \`${approval.id}\` granted by <@${user.slackUserId}>! Send the approved Gmail drafts now.`,
            threadId: threadTs,
          });
        }
      } else {
        // Rejected: update associated records to SKIPPED
        dbRepo.updateAgentTaskStatus(approval.taskId, 'COMPLETED', {
          result: { rejectedByUser: true, approvalId: approval.id },
        });
      }
    }

    const reply = `✅ Recorded **${decisionStatus}** for approval(s): \`${processedIds.join(', ')}\`. ${
      decisionStatus === 'REJECTED'
        ? 'Those external actions have been cancelled.'
        : 'I have notified the specialist agent(s) in Switch to proceed!'
    }`;

    await switchCoordinator.postAgentRoomMessage({
      fromAgent: 'milo',
      content: reply,
      slackChannelId,
      threadId: threadTs,
    });

    return {
      user,
      replyText: reply,
      approvalUpdatedId: processedIds[0],
    };
  }

  /**
   * Builds Milo's Consolidated Report strictly from persisted database records.
   * Never confuses an email sent with one delivered or read, and counts only verified applications.
   */
  public buildConsolidatedReport(workflowId: string): string {
    const db = getDb();
    const wf = dbRepo.getWorkflow(workflowId);
    if (!wf) throw new Error(`Workflow not found: ${workflowId}`);

    // 1. Job discovery metrics from Scout task & job_matches
    const scoutTasks = dbRepo
      .listAgentTasks({ workflowId, assignedAgent: 'scout' })
      .filter((t) => t.status === 'COMPLETED' && t.resultJson);

    let opportunitiesFound = 0;
    let shortlistedCount = 0;
    let duplicatesRemoved = 0;

    if (scoutTasks.length > 0) {
      const parsed = JSON.parse(scoutTasks[0].resultJson!);
      opportunitiesFound = Number(parsed.totalFound ?? 0);
      shortlistedCount = Number(parsed.shortlistedCount ?? 0);
      duplicatesRemoved = Number(parsed.duplicatesRemoved ?? 0);
    } else {
      const matchCount = db
        .prepare('SELECT COUNT(*) as c FROM job_matches WHERE workflow_id = ?')
        .get(workflowId) as { c: number };
      opportunitiesFound = matchCount.c;
    }

    // 2. Applications metrics (strictly from persisted `applications` rows)
    const appRows = db
      .prepare('SELECT * FROM applications WHERE user_id = ? AND (workflow_id = ? OR workflow_id IS NULL)')
      .all(wf.userId, workflowId) as Array<Record<string, unknown>>;

    const wellfoundVerified = appRows.filter(
      (r) =>
        r.platform === 'wellfound' &&
        r.status === 'APPLIED' &&
        Boolean(r.verified_submission),
    ).length;

    const internshalaVerified = appRows.filter(
      (r) =>
        r.platform === 'internshala' &&
        r.status === 'APPLIED' &&
        Boolean(r.verified_submission),
    ).length;

    const requiresManualReview = appRows.filter((r) =>
      ['skipped_mandatory_fields', 'skippedQuestions', 'review_required', 'skipped_captcha', 'skippedCaptcha'].includes(
        String(r.crawljob_result_code ?? ''),
      ),
    ).length;

    const skippedApplications = appRows.filter(
      (r) => r.status === 'SKIPPED' || r.status === 'ALREADY_APPLIED',
    ).length;

    // 3. Founder outreach metrics (strictly from persisted `founder_contacts`, `email_drafts`, `email_messages`)
    const founderRows = db
      .prepare('SELECT * FROM founder_contacts')
      .all() as Array<Record<string, unknown>>;
    const foundersResearched = founderRows.length;
    const professionalEmailsVerified = founderRows.filter(
      (r) => Boolean(r.public_email) && Boolean(r.email_verified_public),
    ).length;

    const draftRows = db
      .prepare('SELECT * FROM email_drafts WHERE user_id = ?')
      .all(wf.userId) as Array<Record<string, unknown>>;
    const draftsCreated = draftRows.length;
    const draftsAwaitingApproval = draftRows.filter(
      (r) => r.status === 'PENDING_APPROVAL' || r.status === 'DRAFTED',
    ).length;

    const sentRows = db
      .prepare("SELECT * FROM email_messages WHERE user_id = ? AND status = 'SENT' AND gmail_message_id IS NOT NULL")
      .all(wf.userId) as Array<Record<string, unknown>>;
    const emailsSentVerified = sentRows.length;

    const reportText = `Your job search workflow has finished!

Job discovery:
- ${opportunitiesFound} opportunities found.
- ${shortlistedCount} shortlisted.
- ${duplicatesRemoved} duplicates removed.

Applications:
- ${wellfoundVerified} Wellfound applications verified.
- ${internshalaVerified} Internshala applications verified.
- ${requiresManualReview} require manual review.
- ${skippedApplications} skipped.

Founder outreach:
- ${foundersResearched} founders researched.
- ${professionalEmailsVerified} professional emails verified.
- ${draftsCreated} email drafts created.
- ${draftsAwaitingApproval} awaiting approval.${emailsSentVerified > 0 ? `\n- ${emailsSentVerified} emails sent via Gmail.` : ''}

You can review the complete results in your TalentLoop dashboard.`;

    dbRepo.updateWorkflowStatus(
      workflowId,
      draftsAwaitingApproval > 0 ? 'AWAITING_APPROVAL' : 'COMPLETED',
      JSON.stringify({
        opportunitiesFound,
        shortlistedCount,
        duplicatesRemoved,
        wellfoundVerified,
        internshalaVerified,
        requiresManualReview,
        skippedApplications,
        foundersResearched,
        professionalEmailsVerified,
        draftsCreated,
        draftsAwaitingApproval,
        emailsSentVerified,
        generatedAt: new Date().toISOString(),
      }),
    );

    return reportText;
  }
}

function parsePreferencesText(text: string): {
  roles: string[];
  locations: string[];
  jobTypes: Array<'full-time' | 'internship' | 'part-time' | 'contract' | 'any'>;
  workMode: 'remote' | 'hybrid' | 'onsite' | 'any';
  minSalaryText: string | null;
  minSalaryAmount: number | null;
  salaryCurrency: string | null;
  portfolioUrl: string | null;
} {
  const rolesMatch = text.match(/(?:roles?|positions?|targeting)\s*[:\-]\s*([^\n|;]+)/i);
  const locMatch = text.match(/(?:locations?|cities|city)\s*[:\-]\s*([^\n|;]+)/i);
  const salaryMatch = text.match(
    /(?:salary|stipend|min(?:imum)?\s*(?:salary|stipend)|compensation)\s*[:\-]\s*([^\n|;]+)/i,
  );
  const portfolioMatch = text.match(
    /(?:portfolio|website|site)\s*[:\-]\s*(https?:\/\/[^\s|;]+)/i,
  );

  let roles: string[] = [];
  if (rolesMatch?.[1]) {
    roles = rolesMatch[1]
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  } else {
    // Extract common role names from freeform text
    const firstLine = text.split(/[|\n]/)[0] ?? '';
    roles = firstLine
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 50 && !/^(locations?|types?|mode|salary)/i.test(s));
  }

  let locations: string[] = ['any'];
  if (locMatch?.[1]) {
    locations = locMatch[1]
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
  } else if (/\b(bangalore|bengaluru|mumbai|delhi|hyderabad|pune|remote|india)\b/i.test(text)) {
    locations = [
      ...new Set(
        [...text.matchAll(/\b(Bangalore|Bengaluru|Mumbai|Delhi|Hyderabad|Pune|Remote|India)\b/gi)].map(
          (m) => m[1],
        ),
      ),
    ];
  }

  const jobTypes: Array<'full-time' | 'internship' | 'part-time' | 'contract' | 'any'> = [];
  if (/\bboth\b/i.test(text)) {
    jobTypes.push('internship', 'full-time');
  } else {
    if (/\bintern(ship)?s?\b/i.test(text)) jobTypes.push('internship');
    if (/\bfull[- ]?time\b/i.test(text)) jobTypes.push('full-time');
    if (/\bpart[- ]?time\b/i.test(text)) jobTypes.push('part-time');
    if (/\bcontract\b/i.test(text)) jobTypes.push('contract');
  }
  if (jobTypes.length === 0) {
    jobTypes.push('internship', 'full-time');
  }

  let workMode: 'remote' | 'hybrid' | 'onsite' | 'any' = 'any';
  if (/\bremote\s+only\b|\bwork\s*mode\s*[:\-]\s*remote\b/i.test(text)) {
    workMode = 'remote';
  } else if (/\bhybrid\b/i.test(text)) {
    workMode = 'hybrid';
  } else if (/\bon[- ]?site\b/i.test(text)) {
    workMode = 'onsite';
  } else if (/\bremote\b/i.test(text)) {
    workMode = 'remote';
  }

  const minSalaryText = salaryMatch?.[1]?.trim() ?? null;
  let minSalaryAmount: number | null = null;
  let salaryCurrency: string | null = null;
  if (minSalaryText) {
    const numMatch = minSalaryText.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    if (numMatch) minSalaryAmount = Number(numMatch[1]);
    if (/inr|₹|rs\.?|lpa/i.test(minSalaryText)) salaryCurrency = 'INR';
    else if (/usd|\$/i.test(minSalaryText)) salaryCurrency = 'USD';
  }

  return {
    roles,
    locations,
    jobTypes,
    workMode,
    minSalaryText,
    minSalaryAmount,
    salaryCurrency,
    portfolioUrl: portfolioMatch?.[1]?.trim() ?? null,
  };
}

export const miloAgent = new MiloAgent();
