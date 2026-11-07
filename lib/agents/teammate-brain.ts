import { ensureEnvLoaded } from '../gmail/service';
import { dbRepo } from '../db';
import type { AgentId, UserRecord } from '../db/schema';
import type { CandidateContext } from './contracts';

/**
 * Resolves the active onboarded user from a Switch participant ID (`@switch-user-<slackId>:...`),
 * ensuring we always pick a user record that has an active CandidateProfile.
 */
export function resolveActiveUserFromSwitchSender(senderId: string): UserRecord | null {
  const users = dbRepo.listUsers();
  const matched = users.find(
    (u) =>
      u.switchParticipantId === senderId ||
      (u.slackUserId && senderId.toLowerCase().includes(u.slackUserId.toLowerCase())),
  );
  if (matched && dbRepo.getCandidateProfile(matched.id)) {
    return matched;
  }
  return (
    users.find((u) => u.onboardingCompleted && Boolean(dbRepo.getCandidateProfile(u.id))) ??
    users.find((u) => Boolean(dbRepo.getCandidateProfile(u.id))) ??
    matched ??
    users[0] ??
    null
  );
}

export interface AgentPersonaConfig {
  id: AgentId;
  name: string;
  role: string;
  personalityPrompt: string;
}

export const AGENT_PERSONAS: Record<AgentId, AgentPersonaConfig> = {
  milo: {
    id: 'milo',
    name: 'Milo',
    role: 'Talent Manager & Team Lead',
    personalityPrompt: `You are Milo, the Talent Manager and team lead of TalentLoop in Slack.
Your teammates in this Switch room are:
- @scout (Opportunity Discovery — searches LinkedIn, Internshala, YC)
- @wally (Wellfound Specialist — runs local Playwright crawlJob automation on Wellfound)
- @inky (Internshala Specialist — runs local Playwright crawlJob automation on Internshala)
- @clover (Founder Intelligence — researches YC startups & verifies public founder business emails)
- @pip (Gmail Outreach — writes punchy, anti-AI-slop cold emails & sends via Gmail OAuth2)

Speak like a sharp, warm, human teammate in Slack (2-4 concise sentences, use Slack *bold* with single asterisks). Never run a scraper or delegate a task if the user is just saying hi, chatting, or asking a question.`,
  },
  scout: {
    id: 'scout',
    name: 'Scout',
    role: 'Opportunity Discovery Specialist',
    personalityPrompt: `You are Scout (@scout), the Opportunity Discovery Specialist on the TalentLoop team in Slack.
You search live job postings across LinkedIn, Internshala, Y Combinator, Remotive, and Arbeitnow, and rank them against the candidate's resume.
Your teammates are @milo (Talent Manager), @wally (Wellfound auto-apply), @inky (Internshala auto-apply), @clover (Founder research), and @pip (Cold email outreach).
Speak like a sharp, friendly human teammate in Slack (2-3 concise sentences, use Slack *bold* with single asterisks). When someone just says "hi @scout" or asks what you do, greet them naturally in character and ask what roles or cities they want you to hunt for—do NOT dump job lists unless they asked you to search!`,
  },
  wally: {
    id: 'wally',
    name: 'Wally',
    role: 'Wellfound Application Specialist',
    personalityPrompt: `You are Wally (@wally), the Wellfound Application Specialist on the TalentLoop team in Slack.
You run the local Playwright browser automation (crawlJob) on Wellfound (wellfound.com/jobs) using the candidate's logged-in browser session, handle custom modal questions safely, and verify submissions.
Speak like a pragmatic, hands-on automation engineer teammate in Slack (2-3 concise sentences, use Slack *bold* with single asterisks).`,
  },
  inky: {
    id: 'inky',
    name: 'Inky',
    role: 'Internshala Application Specialist',
    personalityPrompt: `You are Inky (@inky), the Internshala Application Specialist on the TalentLoop team in Slack.
You run the local Playwright browser automation (crawlJob) on Internshala internships and jobs, skip roles the candidate already applied to, handle resume continuation and required questions, and return direct links for any role that needs manual review.
Speak like a focused, helpful teammate in Slack (2-3 concise sentences, use Slack *bold* with single asterisks).`,
  },
  clover: {
    id: 'clover',
    name: 'Clover',
    role: 'Founder & Startup Intelligence Specialist',
    personalityPrompt: `You are Clover (@clover), the Startup & Founder Intelligence Specialist on the TalentLoop team in Slack.
You research recently funded and actively hiring Y Combinator startups, identify founders and CTOs/CEOs, and verify publicly listed business emails from live startup websites without ever guessing private emails.
Speak like a sharp VC/startup researcher teammate in Slack (2-3 concise sentences, use Slack *bold* with single asterisks).`,
  },
  pip: {
    id: 'pip',
    name: 'Pip',
    role: 'Cold Email & Gmail Outreach Specialist',
    personalityPrompt: `You are Pip (@pip), the Gmail Outreach & Cold Copywriting Specialist on the TalentLoop team in Slack.
You hate generic AI-slop cover letters and write sharp, pattern-interrupt founder cold emails grounded in the candidate's real projects (like MemoryOS and Kira), and send them via Gmail OAuth2 only after human approval.
Speak like a witty, high-agency copywriter teammate in Slack (2-3 concise sentences, use Slack *bold* with single asterisks).`,
  },
};

export interface IntentClassification {
  intent:
    | 'CHAT_CONVERSATION'
    | 'SEARCH_JOBS'
    | 'APPLY_WELLFOUND'
    | 'APPLY_INTERNSHALA'
    | 'RESEARCH_FOUNDERS'
    | 'DRAFT_EMAILS'
    | 'SEND_EMAILS'
    | 'DELEGATE_MULTI';
  extractedCompany: string | null;
  extractedRole: string | null;
  extractedLocation: string | null;
  extractedPlatforms: Array<'linkedin' | 'internshala' | 'wellfound' | 'yc'>;
  delegateToAgents: AgentId[];
  conversationalReply: string;
}

/**
 * Classifies a Slack/Switch message addressed to an agent and generates a natural,
 * in-character teammate response using Groq LLM (with fast deterministic fallback).
 * Distinguishes casual chat ("hi @scout", "what do you do?", "thanks!") from explicit action requests!
 */
export async function analyzeTurnWithTeammateBrain(params: {
  agentId: AgentId;
  senderName: string;
  messageText: string;
  candidateContext: CandidateContext | null;
  recentRoomMessages: Array<{ senderName: string; body: string }>;
  dbStats?: {
    jobsCount?: number;
    appliedCount?: number;
    foundersCount?: number;
    draftsCount?: number;
  };
}): Promise<IntentClassification> {
  ensureEnvLoaded();
  const persona = AGENT_PERSONAS[params.agentId];
  const raw = params.messageText.trim();
  const lower = raw
    .replace(/@(milo|scout|wally|inky|clover|pip)\b/gi, '')
    .replace(/^[,:\-\s]+/, '')
    .trim()
    .toLowerCase();

  // Extract platforms if mentioned
  const extractedPlatforms: Array<'linkedin' | 'internshala' | 'wellfound' | 'yc'> = [];
  if (/\blinkedin\b/i.test(raw)) extractedPlatforms.push('linkedin');
  if (/\binternshala\b/i.test(raw)) extractedPlatforms.push('internshala');
  if (/\bwellfound\b/i.test(raw)) extractedPlatforms.push('wellfound');
  if (/\byc\b|\by\s*combinator\b/i.test(raw)) extractedPlatforms.push('yc');

  // Extract location if mentioned (e.g. "in Delhi", "in Bangalore", "remote")
  const locMatch = raw.match(
    /\bin\s+([A-Z][a-zA-Z\s]{2,25}?)(?:\?|\.|$|\s+on\s+|\s+for\s+|\s+and\s+)/,
  );
  const extractedLocation = locMatch?.[1]?.trim() || (/\bremote\b/i.test(raw) ? 'Remote' : null);

  // Extract company + role if mentioned (e.g. "for microsoft related to SDE 1", "at Google", "Backend Intern")
  const companyMatch = raw.match(
    /\b(?:for|at|from)\s+([A-Za-z0-9._-]{2,25}?)\s+(?:related\s+to|for|as|in|on)\s+([A-Za-z0-9\s./+-]{2,30}?)(?:\?|\.|$)/i,
  );
  const extractedCompany = companyMatch ? companyMatch[1].trim() : null;

  const roleMatch = raw.match(
    /(?:related\s+to\s+|for\s+(?:any\s+|a\s+)?|find\s+(?:me\s+)?(?:any\s+)?|search\s+(?:for\s+)?(?:any\s+)?)([A-Za-z0-9\s./+-]{2,35}?\b(?:Intern(?:ship)?|Developer|Engineer|SDE(?:\s*[123I]+)?|Designer|Architect|Analyst|Full\s*Stack|Backend|Frontend))\b/i,
  );
  const extractedRole = companyMatch
    ? `${companyMatch[1].trim()} ${companyMatch[2].replace(/\bSDE\s*1\b/i, 'Software Engineer').trim()}`
    : roleMatch?.[1]?.trim() || null;

  // 1. Check if this is purely a greeting, question about identity, or casual chat!
  const isPureGreetingOrChat =
    lower.length === 0 ||
    /^(hi|hello|hey|yo|sup|hola|good\s*(morning|afternoon|evening)|thanks|thank\s*you|cool|awesome|great|ok|okay|how\s+are\s+you|who\s+are\s+you|what\s+(do|can)\s+you\s+do|introduce\s+yourself|help|what'?s\s+up)\b[?!.\s]*$/i.test(
      lower,
    ) ||
    (!/\b(check|search|find|discover|scrape|look\s+for|shortlist|apply|run|research|draft|write|send|e?mails?|outreach|jobs?|internships?|positions?|openings?|opportunities|founders?|startups?)\b/i.test(
      lower,
    ) &&
      lower.split(/\s+/).length <= 6);

  // Determine action intent when NOT a pure greeting
  let intent: IntentClassification['intent'] = 'CHAT_CONVERSATION';
  const delegateToAgents: AgentId[] = [];

  if (!isPureGreetingOrChat) {
    if (params.agentId === 'scout') {
      if (
        /\b(check|search|find|discover|look\s+for|get|pull|show|any|open|jobs?|internships?|positions?|roles?|openings?|opportunities)\b/i.test(
          lower,
        )
      ) {
        intent = 'SEARCH_JOBS';
      }
    } else if (params.agentId === 'wally') {
      if (/\b(apply|run|start|submit|wellfound|jobs?)\b/i.test(lower)) {
        intent = 'APPLY_WELLFOUND';
      }
    } else if (params.agentId === 'inky') {
      if (/\b(apply|run|start|submit|internshala|jobs?|internships?)\b/i.test(lower)) {
        intent = 'APPLY_INTERNSHALA';
      }
    } else if (params.agentId === 'clover') {
      if (/\b(research|find|discover|search|look\s+for|founders?|startups?|yc|e?mails?|contacts?)\b/i.test(lower)) {
        intent = 'RESEARCH_FOUNDERS';
      }
    } else if (params.agentId === 'pip') {
      if (/\b(send|deliver|approve|dispatch)\b/i.test(lower)) {
        intent = 'SEND_EMAILS';
      } else if (/\b(draft|write|create|prepare|cold|e?mails?|outreach)\b/i.test(lower)) {
        intent = 'DRAFT_EMAILS';
      }
    } else if (params.agentId === 'milo') {
      if (/\b(search|find|discover|look\s+for|shortlist|check)\b.*\b(jobs?|internships?|positions?|roles?|openings?|opportunities)\b/i.test(lower)) {
        intent = 'DELEGATE_MULTI';
        delegateToAgents.push('scout');
      }
      if (/\b(apply)\b.*\b(wellfound)\b/i.test(lower)) {
        intent = 'DELEGATE_MULTI';
        delegateToAgents.push('wally');
      }
      if (/\b(apply)\b.*\b(internshala)\b/i.test(lower)) {
        intent = 'DELEGATE_MULTI';
        delegateToAgents.push('inky');
      }
      if (/\b(research|find|search)\b.*\b(founders?|startups?|yc)\b/i.test(lower)) {
        intent = 'DELEGATE_MULTI';
        delegateToAgents.push('clover');
      }
      if (/\b(draft|write|prepare|send)\b.*\b(e?mails?|outreach|cold\s*e?mails?|founders?)\b/i.test(lower)) {
        intent = 'DELEGATE_MULTI';
        delegateToAgents.push('pip');
      }
    }
  }

  // FAST PATH: If this is an explicit action intent (SEARCH_JOBS, APPLY_*, RESEARCH_FOUNDERS, DRAFT_EMAILS, SEND_EMAILS, DELEGATE_MULTI),
  // return IMMEDIATELY in 0ms without blocking on an external LLM call so the agent starts working right away!
  if (intent !== 'CHAT_CONVERSATION') {
    return {
      intent,
      extractedCompany,
      extractedRole,
      extractedLocation,
      extractedPlatforms,
      delegateToAgents,
      conversationalReply: '',
    };
  }

  // Generate in-character conversational reply via fast Groq model (`llama-3.1-8b-instant`, ~180ms) if available
  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (groqKey) {
    try {
      const candidateSummary = params.candidateContext
        ? `Candidate: ${params.candidateContext.fullName} | Roles: ${params.candidateContext.preferredRoles.join(', ')} | Skills: ${params.candidateContext.skills.slice(0, 8).join(', ')} | Projects: ${params.candidateContext.projects.map((p) => p.name).join(', ')}`
        : 'Candidate profile loaded.';

      const recentTranscript = params.recentRoomMessages
        .slice(-5)
        .map((m) => `${m.senderName}: ${m.body.slice(0, 150)}`)
        .join('\n');

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          temperature: 0.4,
          max_tokens: 160,
          messages: [
            {
              role: 'system',
              content: `${persona.personalityPrompt}\n\n${candidateSummary}\nDatabase stats: ${JSON.stringify(params.dbStats ?? {})}\nReply naturally in character to the user's message in 2-3 concise sentences without claiming you just ran a background task.`,
            },
            {
              role: 'user',
              content: `Recent room context:\n${recentTranscript}\n\nNew message from ${params.senderName}: "${params.messageText}"`,
            },
          ],
        }),
        signal: AbortSignal.timeout(1800),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const reply = data.choices?.[0]?.message?.content?.trim();
        if (reply) {
          return {
            intent,
            extractedCompany,
            extractedRole,
            extractedLocation,
            extractedPlatforms,
            delegateToAgents,
            conversationalReply: reply,
          };
        }
      }
    } catch {
      // Fallback to deterministic persona response below
    }
  }

  // Fast deterministic fallback in each agent's voice
  const firstName = params.candidateContext?.fullName?.split(' ')[0] || params.senderName.split(' ')[0] || 'there';
  const defaultReplies: Record<AgentId, string> = {
    milo: `Hey ${firstName}! 🧭 I'm *Milo*, your Talent Manager here in Switch. You can talk directly to *@scout* (job discovery), *@inky* (Internshala apply), *@wally* (Wellfound apply), *@clover* (founder research), or *@pip* (cold emails)—or just tell me what you want the team to tackle!`,
    scout: `Hey ${firstName}! 👋 I'm *Scout*—I hunt down live job and internship openings across *LinkedIn*, *Internshala*, and *Y Combinator* that match your stack. Tell me a role and city (like \`@scout search for Backend Intern in Delhi\`) whenever you want me to pull fresh listings!`,
    wally: `Hey ${firstName}! 🚀 *Wally* here—I handle your Wellfound browser automation via \`crawlJob\`. Just say \`@wally apply to wellfound jobs\` whenever you want me to open your browser session and apply!`,
    inky: `Hey ${firstName}! 🎓 *Inky* here—I run your Internshala internship & job applications in \`crawlJob\` (skipping the ${params.dbStats?.appliedCount ?? 19} roles you've already applied to). Tell me \`@inky apply to internshala jobs\` when you're ready!`,
    clover: `Hey ${firstName}! 🍀 *Clover* here—I research funded Y Combinator startups and verify public founder business emails. Say \`@clover research startup founders\` whenever you want fresh founder leads!`,
    pip: `Hey ${firstName}! ✉️ *Pip* here—I write sharp, anti-AI-slop founder cold emails grounded in your projects (*MemoryOS*, *Kira*) and send them through your connected Gmail OAuth account. Say \`@pip draft emails\` or \`@pip send emails\` anytime!`,
  };

  return {
    intent,
    extractedCompany,
    extractedRole,
    extractedLocation,
    extractedPlatforms,
    delegateToAgents,
    conversationalReply: defaultReplies[params.agentId],
  };
}
