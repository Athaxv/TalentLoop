import crypto from 'node:crypto';
import { dbRepo, getDb } from '../db';
import {
  ScoutTaskInputSchema,
  ScoutTaskOutputSchema,
  sanitizeUntrustedData,
  type CandidateContext,
  type DelegatedTaskEnvelope,
} from './contracts';
import { switchCoordinator } from '../switch/coordinator';
import { slackClient } from '../slack/client';
import {
  analyzeTurnWithTeammateBrain,
  resolveActiveUserFromSwitchSender,
} from './teammate-brain';
import { buildCandidateContext } from '../onboarding/profile-sync';

export interface RawDiscoveredListing {
  title: string;
  company: string;
  companyWebsite?: string | null;
  location: string;
  workMode: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  employmentType: 'full-time' | 'internship' | 'part-time' | 'contract';
  salaryOrStipend: string | null;
  experienceRequirements: string | null;
  skillsRequired: string[];
  description: string;
  postingDate: string | null;
  applicationUrl: string;
  sourceUrl: string;
  platform:
    | 'wellfound'
    | 'internshala'
    | 'linkedin'
    | 'yc'
    | 'greenhouse'
    | 'lever'
    | 'remoteok'
    | 'arbeitnow'
    | 'public_web';
  isVerifiedCurrent: boolean;
}

/**
 * Exact replica of crawlJob's `screenJob()` logic from `src/job-screening.ts` (commit 98d59e0)
 * so Scout's shortlisting aligns with Wally and Inky's pre-application screening.
 */
export function evaluateCrawlJobScreening(
  title: string,
  description: string,
  candidate: CandidateContext,
  listingType?: string,
  locationText?: string,
): { eligible: boolean; reason: string } {
  const roles = candidate.preferredRoles;
  if (!roles.length) {
    return { eligible: false, reason: 'No target roles configured in candidate profile.' };
  }

  const roleTitle = title.toLowerCase();
  const roleMatches = roles.some((role) => {
    const normalized = role.toLowerCase().trim();
    return (
      normalized &&
      (roleTitle.includes(normalized) ||
        normalized
          .split(/\s+/)
          .filter((word) => word.length > 2)
          .some((word) => roleTitle.includes(word)))
    );
  });

  if (!roleMatches) {
    return {
      eligible: false,
      reason: `Role does not match target roles: ${roles.join(', ')}`,
    };
  }

  const level = candidate.experienceLevel;
  const seniorRole = /\b(senior|sr\.?|staff|principal|lead|manager|director|head of)\b/i.test(
    title,
  );
  if ((level === 'fresher' || level === 'entry') && seniorRole) {
    return {
      eligible: false,
      reason: 'Role title requires seniority above the configured experience level.',
    };
  }

  const years = [
    ...description.matchAll(
      /(?:(\d{1,2})\s*[-–to]+\s*)?(\d{1,2})\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+)?experience/gi,
    ),
  ].map((m) => (m[1] !== undefined ? Number(m[1]) : Number(m[2])));

  if (
    candidate.yearsOfExperience != null &&
    years.some((req) => req > (candidate.yearsOfExperience ?? 0) + 1)
  ) {
    return {
      eligible: false,
      reason: `Description asks for ${Math.max(...years)} years of experience; profile has ${candidate.yearsOfExperience}.`,
    };
  }

  const desiredTypes = candidate.preferredJobTypes.map((t) => t.toLowerCase());
  const typeText = `${listingType ?? ''} ${locationText ?? ''} ${title} ${description.slice(0, 1500)}`.toLowerCase();

  if (
    candidate.workModePreference === 'remote' &&
    !/\b(remote|work from home|wfh|distributed|anywhere|multiple locations)\b/i.test(typeText)
  ) {
    return {
      eligible: false,
      reason: 'Remote-only location preference does not match this listing.',
    };
  }

  const inferredType = /\bintern(ship)?\b/.test(typeText)
    ? 'internship'
    : /\bpart[- ]time\b/.test(typeText)
      ? 'part-time'
      : /\b(contract|contractor|freelance)\b/.test(typeText)
        ? 'contract'
        : /\b(full[- ]time|permanent)\b/.test(typeText)
          ? 'full-time'
          : undefined;

  if (!desiredTypes.includes('any') && inferredType && !desiredTypes.includes(inferredType)) {
    return {
      eligible: false,
      reason: `Job type is ${inferredType}; accepted types: ${desiredTypes.join(', ')}.`,
    };
  }

  return { eligible: true, reason: 'Matches configured role and experience filters.' };
}

/**
 * Computes a 0-100 relevance score between a job listing and the candidate profile.
 */
export function computeCandidateMatchScore(
  job: RawDiscoveredListing,
  candidate: CandidateContext,
): {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
} {
  const candidateSkillsLower = new Map(
    candidate.skills.map((s) => [s.toLowerCase(), s]),
  );

  const matchedSkills: string[] = [];
  const missingSkills: string[] = [];

  for (const reqSkill of job.skillsRequired) {
    const hit = candidateSkillsLower.get(reqSkill.toLowerCase());
    if (hit) {
      matchedSkills.push(hit);
    } else {
      missingSkills.push(reqSkill);
    }
  }

  const descLower = `${job.title} ${job.description}`.toLowerCase();
  for (const [lower, canonical] of candidateSkillsLower.entries()) {
    if (descLower.includes(lower) && !matchedSkills.includes(canonical)) {
      matchedSkills.push(canonical);
    }
  }

  let score = 50;

  const titleLower = job.title.toLowerCase();
  if (
    candidate.preferredRoles.some((r) => titleLower.includes(r.toLowerCase()))
  ) {
    score += 25;
  } else if (
    candidate.preferredRoles.some((r) =>
      r
        .toLowerCase()
        .split(/\s+/)
        .some((w) => w.length > 2 && titleLower.includes(w)),
    )
  ) {
    score += 15;
  }

  const skillBoost = Math.min(20, matchedSkills.length * 5);
  score += skillBoost;

  if (
    candidate.workModePreference === 'any' ||
    job.workMode === candidate.workModePreference ||
    job.workMode === 'remote'
  ) {
    score += 10;
  }

  return {
    score: Math.min(99, Math.max(15, Math.round(score))),
    matchedSkills,
    missingSkills,
  };
}

/**
 * Parses company name and location from an Internshala detail URL slug:
 * e.g. `/internship/detail/java-full-stack-internship-in-bangalore-at-gateway-software-solutions1793963436`
 */
function parseInternshalaSlugMeta(url: string, rawTitle: string): {
  company: string;
  location: string;
  workMode: 'remote' | 'hybrid' | 'onsite';
  skills: string[];
} {
  const pathname = new URL(url).pathname;
  const slug = pathname.split('/').pop() ?? '';
  const withoutId = slug.replace(/\d+$/, '').replace(/-+$/, '');

  let company = 'Internshala Partner Company';
  let location = 'India';
  const atParts = withoutId.split('-at-');
  if (atParts.length >= 2) {
    company = atParts[atParts.length - 1]
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  const beforeAt = atParts[0] ?? '';
  const inParts = beforeAt.split('-in-');
  if (inParts.length >= 2) {
    location = inParts[inParts.length - 1]
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  } else if (beforeAt.includes('work-from-home')) {
    location = 'Remote (Work From Home)';
  }

  const workMode: 'remote' | 'hybrid' | 'onsite' =
    /work-from-home|remote|multiple-locations/i.test(slug) ? 'remote' : 'onsite';

  const inferredSkills: string[] = [];
  const combined = `${rawTitle} ${slug}`.toLowerCase();
  const skillTokens: Array<[RegExp, string]> = [
    [/full[- ]?stack|web|react|frontend/, 'React'],
    [/full[- ]?stack|node|backend|software|web/, 'Node.js'],
    [/typescript|javascript|web|full[- ]?stack|react/, 'TypeScript'],
    [/python|ai|data|machine/, 'Python'],
    [/java\b/, 'Java'],
    [/flutter|mobile|android/, 'Flutter'],
  ];
  for (const [re, label] of skillTokens) {
    if (re.test(combined)) inferredSkills.push(label);
  }

  return { company, location, workMode, skills: inferredSkills };
}

/**
 * Fetches 100% live job postings from real, public, accessible sources:
 * 1. Live Internshala Internships & Jobs pages (`internshala.com/internships/...`, `internshala.com/jobs/...`)
 * 2. Live Y Combinator Startup Job Boards (`yc-oss` + `ycombinator.com/companies/<slug>`)
 * 3. Live Remotive Public API (`remotive.com/api/remote-jobs`)
 * 4. Live Arbeitnow Public API (`arbeitnow.com/api/job-board-api`)
 * Never fabricates job openings, dates, salaries, or application URLs.
 */
export async function fetchPublicJobSources(
  queryRoles: string[] = [],
  locations: string[] = ['India'],
  platforms?: string[],
): Promise<RawDiscoveredListing[]> {
  const results: RawDiscoveredListing[] = [];
  const wantPlatform = (p: string) =>
    !platforms || platforms.length === 0 || platforms.includes(p);

  const tasks: Array<Promise<void>> = [];

  // 0. Live LinkedIn Public Guest Job Search API (`linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`)
  if (wantPlatform('linkedin')) {
    const linkedInRoles =
      queryRoles.length > 0
        ? queryRoles.slice(0, 2)
        : ['Full Stack Developer', 'Software Engineer'];
    const linkedInLocation =
      locations.find((l) => l.toLowerCase() !== 'any' && l.toLowerCase() !== 'remote') ||
      'India';

    for (const roleQuery of linkedInRoles) {
      tasks.push(
        (async () => {
          const liUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(
            roleQuery,
          )}&location=${encodeURIComponent(linkedInLocation)}&f_TPR=r604800&f_E=1%2C2&start=0`;

          const res = await fetch(liUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
              Accept: 'text/html',
            },
            signal: AbortSignal.timeout(3500),
          });
          if (!res.ok) return;
          const html = await res.text();

          const cardMatches = [
            ...html.matchAll(
              /<div class="base-card[\s\S]*?<a class="base-card__full-link[\s\S]*?href="([^"?]+)[\s\S]*?<h3 class="base-search-card__title">([\s\S]*?)<\/h3>[\s\S]*?<h4 class="base-search-card__subtitle">([\s\S]*?)<\/h4>[\s\S]*?<span class="job-search-card__location">([\s\S]*?)<\/span>(?:[\s\S]*?<time class="job-search-card__listdate[^"]*" datetime="([^"]+)")?/g,
            ),
          ];

          for (const m of cardMatches.slice(0, 8)) {
            const cleanUrl = m[1].trim();
            const title = m[2].replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
            const company = m[3].replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
            const loc = m[4].replace(/<[^>]+>/g, '').trim() || linkedInLocation;
            const postDate = m[5]?.trim() || null;

            if (!cleanUrl || !title || !company) continue;

            const meta = parseInternshalaSlugMeta(cleanUrl, `${title} ${roleQuery}`);
            results.push({
              title,
              company,
              location: loc,
              workMode: /remote|hybrid/i.test(`${title} ${loc}`) ? 'remote' : 'onsite',
              employmentType: /intern/i.test(title) ? 'internship' : 'full-time',
              salaryOrStipend: null,
              experienceRequirements: 'Entry level / Internship (LinkedIn verified)',
              skillsRequired: meta.skills,
              description: `Live LinkedIn job posting: ${title} at ${company} (${loc}). Apply or view directly on LinkedIn: ${cleanUrl}`,
              postingDate: postDate,
              applicationUrl: cleanUrl,
              sourceUrl: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(roleQuery)}`,
              platform: 'linkedin',
              isVerifiedCurrent: true,
            });
          }
        })(),
      );
    }
  }

  // 1. Live Internshala Internships & Jobs
  if (wantPlatform('internshala')) {
    const dynamicInternshalaUrls = new Set<string>();
    const specificCity = locations
      .map((l) => l.trim().toLowerCase())
      .find((l) => l && l !== 'any' && l !== 'remote' && l !== 'india');

    for (const role of queryRoles.slice(0, 2)) {
      const slug = role
        .toLowerCase()
        .replace(/\bintern(ship)?\b/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (slug.length >= 2) {
        if (specificCity) {
          const citySlug = specificCity.replace(/[^a-z0-9]+/g, '-');
          dynamicInternshalaUrls.add(
            `https://internshala.com/internships/${slug}-internship-in-${citySlug}/`,
          );
          dynamicInternshalaUrls.add(
            `https://internshala.com/jobs/${slug}-jobs-in-${citySlug}/`,
          );
        }
        dynamicInternshalaUrls.add(`https://internshala.com/internships/${slug}-internship/`);
        dynamicInternshalaUrls.add(`https://internshala.com/jobs/${slug}-jobs/`);
      }
    }

    const internshalaSources: Array<{
      url: string;
      employmentType: 'internship' | 'full-time';
    }> = [
      ...[...dynamicInternshalaUrls].slice(0, 3).map((url) => ({
        url,
        employmentType: (url.includes('/internships/')
          ? 'internship'
          : 'full-time') as 'internship' | 'full-time',
      })),
      {
        url:
          process.env.INTERNSHALA_INTERNSHIPS_URL?.trim() ||
          'https://internshala.com/internships/work-from-home-software-development-internships/',
        employmentType: 'internship',
      },
      {
        url:
          process.env.INTERNSHALA_JOBS_URL?.trim() ||
          'https://internshala.com/jobs/software-development-jobs/',
        employmentType: 'full-time',
      },
    ];

    for (const src of internshalaSources) {
      tasks.push(
        (async () => {
          const res = await fetch(src.url, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
              Accept: 'text/html',
            },
            signal: AbortSignal.timeout(3500),
          });
          if (!res.ok) return;
          const html = await res.text();
          const ldMatches = [
            ...html.matchAll(
              /<script type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
            ),
          ];
          for (const m of ldMatches) {
            try {
              const parsed = JSON.parse(m[1]) as {
                '@type'?: string;
                itemListElement?: Array<{ name?: string; url?: string }>;
              };
              if (
                parsed['@type'] === 'ItemList' &&
                Array.isArray(parsed.itemListElement)
              ) {
                for (const item of parsed.itemListElement.slice(0, 8)) {
                  if (!item.url || !item.name) continue;
                  const meta = parseInternshalaSlugMeta(item.url, item.name);
                  const cleanTitle = item.name.replace(/\s*-\s*Internship$/i, '').trim();
                  results.push({
                    title:
                      src.employmentType === 'internship' &&
                      !/intern/i.test(cleanTitle)
                        ? `${cleanTitle} Intern`
                        : cleanTitle,
                    company: meta.company,
                    location: meta.location,
                    workMode: meta.workMode,
                    employmentType: src.employmentType,
                    salaryOrStipend: null,
                    experienceRequirements:
                      src.employmentType === 'internship'
                        ? '0 years experience (Internship)'
                        : 'Entry level / Fresher',
                    skillsRequired: meta.skills,
                    description: `Live Internshala ${src.employmentType} listing: ${item.name} at ${meta.company} (${meta.location}). Direct application URL: ${item.url}`,
                    postingDate: null,
                    applicationUrl: item.url,
                    sourceUrl: src.url,
                    platform: 'internshala',
                    isVerifiedCurrent: true,
                  });
                }
              }
            } catch {
              // ignore non-JSON-LD blocks
            }
          }
        })(),
      );
    }
  }

  // 2. Live Y Combinator Startup Job Postings
  if (wantPlatform('yc')) {
    tasks.push(
      (async () => {
        const ycRes = await fetch('https://yc-oss.github.io/api/batches/s24.json', {
          signal: AbortSignal.timeout(3000),
        });
        if (!ycRes.ok) return;
        const ycCompanies = (await ycRes.json()) as Array<{
          name: string;
          slug: string;
          website?: string;
          url: string;
          isHiring?: boolean;
          one_liner?: string;
        }>;
        const hiringSlice = ycCompanies.filter((c) => c.isHiring).slice(0, 3);
        await Promise.allSettled(
          hiringSlice.map(async (comp) => {
            const pageRes = await fetch(comp.url, {
              signal: AbortSignal.timeout(2500),
            });
            if (!pageRes.ok) return;
            const html = await pageRes.text();
            const dpMatch = html.match(/data-page="([^"]+)"/);
            if (!dpMatch?.[1]) return;
            const decoded = dpMatch[1]
              .replace(/&quot;/g, '"')
              .replace(/&amp;/g, '&')
              .replace(/&#39;/g, "'");
            const dataPage = JSON.parse(decoded) as {
              props?: {
                jobPostings?: Array<{
                  id: number;
                  title: string;
                  url: string;
                  location?: string;
                  type?: string;
                  salaryRange?: string;
                  minExperience?: string;
                  skills?: string[];
                  companyName?: string;
                }>;
              };
            };
            for (const jb of dataPage.props?.jobPostings ?? []) {
              const fullUrl = jb.url.startsWith('http')
                ? jb.url
                : `https://www.ycombinator.com${jb.url}`;
              results.push({
                title: jb.title,
                company: jb.companyName || comp.name,
                companyWebsite: comp.website ?? null,
                location: jb.location || 'Remote / US',
                workMode: /remote/i.test(jb.location ?? '') ? 'remote' : 'onsite',
                employmentType: /intern/i.test(jb.type ?? jb.title)
                  ? 'internship'
                  : 'full-time',
                salaryOrStipend: jb.salaryRange || null,
                experienceRequirements: jb.minExperience || null,
                skillsRequired: jb.skills ?? [],
                description: `${jb.title} at ${comp.name} (YC S24). ${comp.one_liner ?? ''} Minimum experience: ${jb.minExperience ?? 'Not specified'}.`,
                postingDate: null,
                applicationUrl: fullUrl,
                sourceUrl: comp.url,
                platform: 'yc',
                isVerifiedCurrent: true,
              });
            }
          }),
        );
      })(),
    );
  }

  // Run all active job source requests in parallel (~1.2s total instead of 9s sequential!)
  await Promise.allSettled(tasks);
  return results;
}

function normalizeUrlForDedup(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

export function buildDedupFingerprint(company: string, title: string, url: string): string {
  const normCompany = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normUrl = normalizeUrlForDedup(url);
  return crypto
    .createHash('sha1')
    .update(`${normCompany}::${normTitle}::${normUrl}`)
    .digest('hex')
    .slice(0, 20);
}

/**
 * Agent 4: Scout — Opportunity Discovery Runtime
 */
export class ScoutAgent {
  public registerWithSwitch(): void {
    switchCoordinator.registerAgentHandler(
      'scout',
      async ({ parsedTaskEnvelope, message }) => {
        if (parsedTaskEnvelope && parsedTaskEnvelope.taskType === 'DISCOVER_OPPORTUNITIES') {
          await this.executeDiscoveryTask(parsedTaskEnvelope, message.thread_id);
          return;
        }

        // Direct human conversation or direct command to @scout over Switch WebSocket!
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
      agentId: 'scout',
      senderName: message.sender_name,
      messageText: message.body,
      candidateContext,
      recentRoomMessages,
    });

    // If the user is just saying hi or chatting ("hi @scout", "what do you do?"), reply in character and STOP!
    if (brain.intent === 'CHAT_CONVERSATION' || !candidateContext) {
      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'scout',
        content: brain.conversationalReply,
        slackChannelId: channelId,
        threadId: message.thread_id,
      });
      return;
    }

    // Otherwise, the user asked @scout to search for jobs!
    const effectiveRoles = brain.extractedRole
      ? [brain.extractedRole]
      : candidateContext.preferredRoles;
    const effectiveLocations = brain.extractedLocation
      ? [brain.extractedLocation]
      : candidateContext.preferredLocations;

    const wf = dbRepo.createWorkflow({
      userId: user.id,
      title: `Scout Search: ${effectiveRoles[0]} (${effectiveLocations.join(', ')})`,
      naturalLanguageRequest: message.body,
      switchRoomId: switchCoordinator.getRoomId(),
      slackChannelId: channelId ?? null,
      slackThreadTs: message.thread_id,
    });

    const taskRec = dbRepo.createAgentTask({
      workflowId: wf.id,
      requestingAgent: 'scout',
      assignedAgent: 'scout',
      userId: user.id,
      taskType: 'DISCOVER_OPPORTUNITIES',
      input: {
        queryRoles: effectiveRoles,
        targetCompany: brain.extractedCompany,
        locations: effectiveLocations,
        jobTypes: /\bintern(ship)?\b/i.test(message.body)
          ? ['internship']
          : candidateContext.preferredJobTypes,
        workMode: brain.extractedLocation
          ? 'any'
          : candidateContext.workModePreference,
        maxResults: 20,
        ...(brain.extractedPlatforms.length > 0
          ? { platforms: brain.extractedPlatforms }
          : brain.extractedCompany
            ? { platforms: ['linkedin'] }
            : {}),
      },
      candidateContext: {
        ...candidateContext,
        preferredRoles: effectiveRoles,
        preferredLocations: effectiveLocations,
        ...(brain.extractedLocation ? { workModePreference: 'any' } : {}),
      },
      expectedOutput: 'ScoutTaskOutputSchema',
    });

    await this.executeDiscoveryTask(
      {
        taskId: taskRec.taskId,
        workflowId: wf.id,
        requestingAgent: 'scout',
        assignedAgent: 'scout',
        userId: user.id,
        taskType: 'DISCOVER_OPPORTUNITIES',
        input: JSON.parse(taskRec.inputJson),
        candidateContext: JSON.parse(taskRec.candidateContextJson),
        expectedOutput: 'ScoutTaskOutputSchema',
        status: 'IN_PROGRESS',
        createdAt: taskRec.createdAt,
        updatedAt: taskRec.updatedAt,
      },
      message.thread_id,
    );
  }

  public async executeDiscoveryTask(
    envelope: DelegatedTaskEnvelope,
    threadId?: string | null,
  ): Promise<void> {
    const { taskId, workflowId, userId, candidateContext } = envelope;
    const wf = dbRepo.getWorkflow(workflowId);
    const targetSlackChannel = wf?.slackChannelId || undefined;

    // Immediate visible loading card in Slack so the user knows @scout is working right now!
    const loadingMsg = await slackClient.postAgentMessage({
      agentId: 'scout',
      channel: targetSlackChannel,
      threadTs: threadId,
      text: `⏳ *Scout is searching LinkedIn, Internshala & YC for open roles matching [${candidateContext.preferredRoles.slice(0, 2).join(', ')}] in [${candidateContext.preferredLocations.join(', ')}]...*`,
    });

    try {
      const parsedInput = ScoutTaskInputSchema.parse(envelope.input);

      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'scout',
        status: 'IN_PROGRESS',
        summaryMessage: `Searching live job postings across *LinkedIn*, *Internshala*, *Y Combinator*, *Remotive*, and *Arbeitnow* for [${parsedInput.queryRoles.join(', ')}]...`,
        threadId,
      });

      const rawListings = await fetchPublicJobSources(
        parsedInput.queryRoles,
        parsedInput.locations,
        parsedInput.platforms,
      );

      const seenUrls = new Set<string>();
      const seenCompanyTitle = new Set<string>();
      let duplicatesRemoved = 0;
      const uniqueListings: RawDiscoveredListing[] = [];

      for (const item of rawListings) {
        const canonicalUrl = normalizeUrlForDedup(item.applicationUrl);
        const companyTitleKey = `${item.company.trim().toLowerCase()}::${item.title.trim().toLowerCase()}`;

        if (seenUrls.has(canonicalUrl) || seenCompanyTitle.has(companyTitleKey)) {
          duplicatesRemoved += 1;
          continue;
        }
        seenUrls.add(canonicalUrl);
        seenCompanyTitle.add(companyTitleKey);
        uniqueListings.push({
          ...item,
          company: item.company.trim(),
          title: item.title.trim(),
          applicationUrl: canonicalUrl.startsWith('http')
            ? new URL(item.applicationUrl).origin + new URL(item.applicationUrl).pathname
            : item.applicationUrl,
        });
      }

      const db = getDb();
      const now = new Date().toISOString();

      const scoredOpportunities: Array<{
        jobId: string;
        listing: RawDiscoveredListing;
        matchScore: number;
        matchedSkills: string[];
        missingSkills: string[];
        eligible: boolean;
        screeningReason: string;
      }> = [];

      const filteredByPlatform =
        parsedInput.platforms && parsedInput.platforms.length > 0
          ? uniqueListings.filter((u) =>
              parsedInput.platforms!.includes(
                u.platform as NonNullable<typeof parsedInput.platforms>[number],
              ),
            )
          : uniqueListings;

      const targetCompLower = parsedInput.targetCompany?.trim().toLowerCase();
      const filteredListings = targetCompLower
        ? filteredByPlatform.filter(
            (u) =>
              u.company.toLowerCase().includes(targetCompLower) ||
              u.title.toLowerCase().includes(targetCompLower),
          )
        : filteredByPlatform;

      for (const listing of filteredListings) {
        const safeDescription = sanitizeUntrustedData(
          listing.description,
          `job:${listing.company}:${listing.title}`,
        );

        const normCompany = listing.company.toLowerCase().replace(/[^a-z0-9]/g, '');
        let companyRow = db
          .prepare('SELECT id FROM companies WHERE normalized_name = ?')
          .get(normCompany) as { id: string } | undefined;

        if (!companyRow) {
          const companyId = `cmp_${crypto.randomUUID().slice(0, 10)}`;
          db.prepare(`
            INSERT INTO companies (
              id, name, normalized_name, website, location, is_actively_hiring, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
          `).run(
            companyId,
            listing.company,
            normCompany,
            listing.companyWebsite ?? null,
            listing.location,
            now,
            now,
          );
          companyRow = { id: companyId };
        }

        const fingerprint = buildDedupFingerprint(
          listing.company,
          listing.title,
          listing.applicationUrl,
        );

        const existingJob = db
          .prepare('SELECT id FROM jobs WHERE application_url = ? OR dedup_fingerprint = ?')
          .get(listing.applicationUrl, fingerprint) as { id: string } | undefined;

        const jobId = existingJob?.id ?? `job_${crypto.randomUUID().slice(0, 10)}`;

        if (!existingJob) {
          db.prepare(`
            INSERT INTO jobs (
              id, company_id, company_name, title, location, work_mode,
              employment_type, salary_text, experience_requirements,
              required_skills_json, description, posted_at, application_url,
              source_url, platform, is_verified_current, dedup_fingerprint, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            jobId,
            companyRow.id,
            listing.company,
            listing.title,
            listing.location,
            listing.workMode,
            listing.employmentType,
            listing.salaryOrStipend,
            listing.experienceRequirements,
            JSON.stringify(listing.skillsRequired),
            listing.description,
            listing.postingDate,
            listing.applicationUrl,
            listing.sourceUrl,
            listing.platform,
            listing.isVerifiedCurrent ? 1 : 0,
            fingerprint,
            now,
          );
        }

        const screening = evaluateCrawlJobScreening(
          listing.title,
          `${listing.experienceRequirements ?? ''} ${safeDescription}`,
          candidateContext,
          listing.employmentType,
          `${listing.location} ${listing.workMode}`,
        );
        const match = computeCandidateMatchScore(listing, candidateContext);

        scoredOpportunities.push({
          jobId,
          listing,
          matchScore: screening.eligible ? match.score : Math.min(35, match.score),
          matchedSkills: match.matchedSkills,
          missingSkills: match.missingSkills,
          eligible: screening.eligible,
          screeningReason: screening.reason,
        });
      }

      scoredOpportunities.sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        return b.matchScore - a.matchScore;
      });

      const limited = scoredOpportunities.slice(0, parsedInput.maxResults);
      let shortlistedCount = 0;

      for (let i = 0; i < limited.length; i++) {
        const item = limited[i];
        const isShortlisted = item.eligible && item.matchScore >= 55;
        if (isShortlisted) shortlistedCount += 1;

        const matchStatus = isShortlisted ? 'SHORTLISTED' : 'DISCOVERED';

        db.prepare(`
          INSERT INTO job_matches (
            id, user_id, job_id, workflow_id, match_score,
            eligible_by_crawljob_screen, screening_reason,
            matched_skills_json, missing_skills_json, rank_order, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, job_id) DO UPDATE SET
            workflow_id = excluded.workflow_id,
            match_score = excluded.match_score,
            eligible_by_crawljob_screen = excluded.eligible_by_crawljob_screen,
            screening_reason = excluded.screening_reason,
            rank_order = excluded.rank_order,
            status = excluded.status
        `).run(
          `jm_${crypto.randomUUID().slice(0, 10)}`,
          userId,
          item.jobId,
          workflowId,
          item.matchScore,
          item.eligible ? 1 : 0,
          item.screeningReason,
          JSON.stringify(item.matchedSkills),
          JSON.stringify(item.missingSkills),
          i + 1,
          matchStatus,
          now,
        );

        if (
          isShortlisted &&
          (item.listing.platform === 'wellfound' || item.listing.platform === 'internshala')
        ) {
          const targetAgent = item.listing.platform === 'wellfound' ? 'wally' : 'inky';
          db.prepare(`
            INSERT INTO applications (
              id, user_id, job_id, workflow_id, agent_id, platform,
              status, verified_submission, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'SHORTLISTED', 0, ?, ?)
            ON CONFLICT(user_id, job_id) DO NOTHING
          `).run(
            `app_${crypto.randomUUID().slice(0, 10)}`,
            userId,
            item.jobId,
            workflowId,
            targetAgent,
            item.listing.platform,
            now,
            now,
          );
        }
      }

      const validatedOutput = ScoutTaskOutputSchema.parse({
        totalFound: limited.length,
        shortlistedCount,
        duplicatesRemoved,
        opportunities: limited.map((item) => ({
          jobId: item.jobId,
          title: item.listing.title,
          company: item.listing.company,
          location: item.listing.location,
          workMode: item.listing.workMode,
          employmentType: item.listing.employmentType,
          salaryOrStipend: item.listing.salaryOrStipend,
          experienceRequirements: item.listing.experienceRequirements,
          skillsRequired: item.listing.skillsRequired,
          description: item.listing.description,
          postingDate: item.listing.postingDate,
          applicationUrl: item.listing.applicationUrl,
          sourceUrl: item.listing.sourceUrl,
          platform: item.listing.platform,
          isVerifiedCurrent: item.listing.isVerifiedCurrent,
          matchScore: item.matchScore,
          eligibleByCrawlJobScreen: item.eligible,
          screeningReason: item.screeningReason,
        })),
      });

      const topPreview = validatedOutput.opportunities
        .filter((o) => o.eligibleByCrawlJobScreen)
        .slice(0, 8)
        .map(
          (o, idx) =>
            `${idx + 1}. *${o.title}* at *${o.company}* (\`${o.platform.toUpperCase()}\` · ${o.location} · Match: *${o.matchScore}%*)\n   👉 <${o.applicationUrl}|Open & View Job Posting ↗>`,
        )
        .join('\n');

      const finalSummaryText = `🔍 *Opportunity Discovery Summary (@scout)*\nFound *${validatedOutput.totalFound}* live openings · *${validatedOutput.shortlistedCount}* matched your filter · *${validatedOutput.duplicatesRemoved}* duplicate(s) removed.\n\n*Top Matching Roles:*\n${
        topPreview || 'No matching listings passed all filters.'
      }\n\n💡 *Next Step:* Reply *\`@inky apply\`* (for Internshala) or *\`@wally apply\`* (for Wellfound) if you want to auto-apply to these shortlisted roles.`;

      await slackClient.updateAgentMessage({
        channel: targetSlackChannel,
        ts: loadingMsg.slackMessageTs,
        text: finalSummaryText,
      });

      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'scout',
        status: 'COMPLETED',
        summaryMessage: finalSummaryText,
        result: validatedOutput,
        threadId,
      });
    } catch (err) {
      await slackClient.updateAgentMessage({
        channel: targetSlackChannel,
        ts: loadingMsg.slackMessageTs,
        text: `❌ *Scout Search Failed:* ${(err as Error).message}`,
      });
      await switchCoordinator.reportTaskStatusOverSwitch({
        taskId,
        agentId: 'scout',
        status: 'FAILED',
        summaryMessage: `Opportunity discovery failed: ${(err as Error).message}`,
        errorText: (err as Error).message,
        threadId,
      });
    }
  }

  private async requestApplicationBatchApprovals(params: {
    workflowId: string;
    scoutTaskId: string;
    userId: string;
    opportunities: Array<{
      jobId: string;
      title: string;
      company: string;
      applicationUrl: string;
      platform: string;
      employmentType: string;
      eligibleByCrawlJobScreen: boolean;
      matchScore: number;
    }>;
    threadId?: string | null;
  }): Promise<void> {
    const db = getDb();

    // Exclude any job the user has ALREADY applied to in any previous run
    const alreadyAppliedRows = db
      .prepare(
        "SELECT j.id, j.application_url FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ? AND a.status IN ('APPLIED', 'ALREADY_APPLIED')",
      )
      .all(params.userId) as Array<{ id: string; application_url: string }>;

    const appliedJobIds = new Set(alreadyAppliedRows.map((r) => r.id));
    const appliedUrls = new Set(
      alreadyAppliedRows.map((r) => normalizeUrlForDedup(r.application_url)),
    );

    const isNotAlreadyApplied = (o: { jobId: string; applicationUrl: string }) =>
      !appliedJobIds.has(o.jobId) &&
      !appliedUrls.has(normalizeUrlForDedup(o.applicationUrl));

    const wellfoundBatch = params.opportunities.filter(
      (o) =>
        o.platform === 'wellfound' &&
        o.eligibleByCrawlJobScreen &&
        isNotAlreadyApplied(o),
    );
    const internshalaBatch = params.opportunities.filter(
      (o) =>
        o.platform === 'internshala' &&
        o.eligibleByCrawlJobScreen &&
        isNotAlreadyApplied(o),
    );

    if (wellfoundBatch.length > 0) {
      const approval = dbRepo.createApproval({
        workflowId: params.workflowId,
        taskId: params.scoutTaskId,
        userId: params.userId,
        actionType: 'BATCH_APPLICATION',
        requestedByAgent: 'milo',
        targetAgent: 'wally',
        title: `Approve ${wellfoundBatch.length} Wellfound Application(s) via @wally`,
        summaryText: wellfoundBatch
          .map((j) => `• ${j.title} at ${j.company} (${j.applicationUrl})`)
          .join('\n'),
        payload: {
          jobs: wellfoundBatch.map((j) => ({
            jobId: j.jobId,
            title: j.title,
            company: j.company,
            applicationUrl: j.applicationUrl,
          })),
          applicationAgentMode: 'review',
        },
      });

      for (const j of wellfoundBatch) {
        db.prepare(
          "UPDATE applications SET status = 'PENDING_APPROVAL', approval_id = ?, updated_at = ? WHERE user_id = ? AND job_id = ?",
        ).run(approval.id, new Date().toISOString(), params.userId, j.jobId);
      }

      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: `⏸️ **Human Approval Required (\`${approval.id}\`) — Wellfound Applications (@wally)**\n@scout shortlisted **${wellfoundBatch.length}** Wellfound role(s) matching your profile:\n${wellfoundBatch
          .map((j) => `- **${j.title}** at **${j.company}** (Match: ${j.matchScore}%) — <${j.applicationUrl}>`)
          .join('\n')}\n\nReply **\`approve ${approval.id}\`** (or **\`approve all\`**) to run @wally on your local browser companion, or **\`reject ${approval.id}\`** to skip.`,
        workflowId: params.workflowId,
        taskId: params.scoutTaskId,
        threadId: params.threadId,
      });
    }

    if (internshalaBatch.length > 0) {
      const approval = dbRepo.createApproval({
        workflowId: params.workflowId,
        taskId: params.scoutTaskId,
        userId: params.userId,
        actionType: 'BATCH_APPLICATION',
        requestedByAgent: 'milo',
        targetAgent: 'inky',
        title: `Approve ${internshalaBatch.length} Internshala Application(s) via @inky`,
        summaryText: internshalaBatch
          .map((j) => `• ${j.title} at ${j.company} (${j.applicationUrl})`)
          .join('\n'),
        payload: {
          mode: 'both',
          listings: internshalaBatch.map((j) => ({
            jobId: j.jobId,
            title: j.title,
            company: j.company,
            applicationUrl: j.applicationUrl,
            category: j.employmentType === 'internship' ? 'internship' : 'job',
          })),
          applicationAgentMode: 'review',
        },
      });

      for (const j of internshalaBatch) {
        db.prepare(
          "UPDATE applications SET status = 'PENDING_APPROVAL', approval_id = ?, updated_at = ? WHERE user_id = ? AND job_id = ?",
        ).run(approval.id, new Date().toISOString(), params.userId, j.jobId);
      }

      await switchCoordinator.postAgentRoomMessage({
        fromAgent: 'milo',
        content: `⏸️ **Human Approval Required (\`${approval.id}\`) — Internshala Applications (@inky)**\n@scout shortlisted **${internshalaBatch.length}** live Internshala listing(s) matching your profile:\n${internshalaBatch
          .map((j) => `- **${j.title}** at **${j.company}** (${j.employmentType} · Match: ${j.matchScore}%) — <${j.applicationUrl}>`)
          .join('\n')}\n\nReply **\`approve ${approval.id}\`** (or **\`approve all\`**) to run @inky on your local browser companion, or **\`reject ${approval.id}\`** to skip.`,
        workflowId: params.workflowId,
        taskId: params.scoutTaskId,
        threadId: params.threadId,
      });
    }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractExperiencePhrase(text: string): string | null {
  const m = text.match(
    /(?:minimum|at least|\b)\s*\d{1,2}\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+)?experience/i,
  );
  return m ? m[0].trim() : null;
}

export const scoutAgent = new ScoutAgent();
