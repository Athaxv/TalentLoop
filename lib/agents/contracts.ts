import { z } from 'zod';

export const AgentIdSchema = z.enum(['milo', 'wally', 'inky', 'scout', 'clover', 'pip']);

export const TaskStatusReportSchema = z.enum([
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'REQUIRES_APPROVAL',
]);

export const CandidateContextSchema = z.object({
  userId: z.string(),
  fullName: z.string(),
  email: z.string().email(),
  phone: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  experienceLevel: z.enum(['fresher', 'entry', 'mid', 'senior', 'any']),
  yearsOfExperience: z.number().nullable().optional(),
  skills: z.array(z.string()),
  preferredRoles: z.array(z.string()),
  preferredLocations: z.array(z.string()),
  preferredJobTypes: z.array(
    z.enum(['full-time', 'internship', 'part-time', 'contract', 'any']),
  ),
  workModePreference: z.enum(['remote', 'hybrid', 'onsite', 'any']),
  minSalaryText: z.string().nullable().optional(),
  links: z.object({
    portfolio: z.string().nullable().optional(),
    github: z.string().nullable().optional(),
    linkedin: z.string().nullable().optional(),
  }),
  experiences: z.array(
    z.object({
      company: z.string(),
      role: z.string(),
      description: z.string(),
    }),
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      techStack: z.array(z.string()).optional(),
      repoUrl: z.string().nullable().optional(),
    }),
  ),
});

export type CandidateContext = z.infer<typeof CandidateContextSchema>;

// --- Agent 4: Scout Schemas ---
export const ScoutTaskInputSchema = z.object({
  queryRoles: z.array(z.string()).min(1),
  targetCompany: z.string().nullable().optional(),
  locations: z.array(z.string()).default(['any']),
  jobTypes: z.array(z.enum(['full-time', 'internship', 'part-time', 'contract', 'any'])),
  workMode: z.enum(['remote', 'hybrid', 'onsite', 'any']).default('any'),
  maxResults: z.number().int().min(1).max(50).default(20),
  platforms: z
    .array(
      z.enum([
        'wellfound',
        'internshala',
        'linkedin',
        'yc',
        'greenhouse',
        'lever',
        'remoteok',
        'arbeitnow',
      ]),
    )
    .optional(),
});

export const DiscoveredJobContractSchema = z.object({
  jobId: z.string(),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string(),
  workMode: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
  employmentType: z.enum(['full-time', 'internship', 'part-time', 'contract']),
  salaryOrStipend: z.string().nullable(),
  experienceRequirements: z.string().nullable(),
  skillsRequired: z.array(z.string()),
  description: z.string(),
  postingDate: z.string().nullable(),
  applicationUrl: z.string().url(),
  sourceUrl: z.string().url(),
  platform: z.enum([
    'wellfound',
    'internshala',
    'linkedin',
    'yc',
    'greenhouse',
    'lever',
    'remoteok',
    'arbeitnow',
    'public_web',
  ]),
  isVerifiedCurrent: z.boolean(),
  matchScore: z.number().min(0).max(100),
  eligibleByCrawlJobScreen: z.boolean(),
  screeningReason: z.string(),
});

export const ScoutTaskOutputSchema = z.object({
  totalFound: z.number().int().min(0),
  shortlistedCount: z.number().int().min(0),
  duplicatesRemoved: z.number().int().min(0),
  opportunities: z.array(DiscoveredJobContractSchema),
});

// --- Agent 2: Wally (Wellfound) Schemas ---
export const WallyTaskInputSchema = z.object({
  approvalId: z.string().min(1),
  jobs: z
    .array(
      z.object({
        jobId: z.string(),
        title: z.string(),
        company: z.string(),
        applicationUrl: z.string().url(),
      }),
    )
    .default([]),
  applicationAgentMode: z.enum(['review', 'fill', 'auto-submit']).default('auto-submit'),
});

export const WallyJobOutcomeSchema = z.object({
  jobId: z.string(),
  applicationUrl: z.string().url(),
  company: z.string(),
  role: z.string(),
  crawlJobResult: z.enum([
    'applied',
    'already_applied',
    'skipped_external',
    'skipped_mandatory_fields',
    'skipped_captcha',
    'skipped_no_apply_button',
    'skipped_rate_limited',
    'skipped_ineligible',
    'skipped_error',
  ]),
  status: z.enum(['APPLIED', 'ALREADY_APPLIED', 'SKIPPED', 'FAILED']),
  verified: z.boolean(),
  reason: z.string().nullable(),
  screenshotPath: z.string().nullable().optional(),
});

export const WallyTaskOutputSchema = z.object({
  totalProcessed: z.number().int().min(0),
  verifiedApplied: z.number().int().min(0),
  alreadyApplied: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  requiresManualReview: z.number().int().min(0),
  outcomes: z.array(WallyJobOutcomeSchema),
});

// --- Agent 3: Inky (Internshala) Schemas ---
export const InkyTaskInputSchema = z.object({
  approvalId: z.string().min(1),
  mode: z.enum(['internships', 'jobs', 'both']).default('both'),
  listings: z
    .array(
      z.object({
        jobId: z.string(),
        title: z.string(),
        company: z.string(),
        applicationUrl: z.string().url(),
        category: z.enum(['internship', 'job']),
      }),
    )
    .default([]),
  applicationAgentMode: z.enum(['review', 'fill', 'auto-submit']).default('auto-submit'),
});

export const InkyListingOutcomeSchema = z.object({
  jobId: z.string(),
  applicationUrl: z.string().url(),
  company: z.string(),
  role: z.string(),
  category: z.enum(['internship', 'job']),
  crawlJobResult: z.enum([
    'applied',
    'alreadyApplied',
    'skippedQuestions',
    'skippedProfile',
    'skippedCaptcha',
    'skippedExternal',
    'skippedError',
  ]),
  status: z.enum(['APPLIED', 'ALREADY_APPLIED', 'SKIPPED', 'FAILED']),
  verified: z.boolean(),
  reason: z.string().nullable(),
  screenshotPath: z.string().nullable().optional(),
});

export const InkyTaskOutputSchema = z.object({
  totalProcessed: z.number().int().min(0),
  verifiedApplied: z.number().int().min(0),
  alreadyApplied: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  requiresManualReview: z.number().int().min(0),
  outcomes: z.array(InkyListingOutcomeSchema),
});

// --- Agent 5: Clover (Founder Intelligence) Schemas ---
export const CloverTaskInputSchema = z.object({
  targetCompanies: z.array(z.string()).optional(),
  targetRoles: z.array(z.string()),
  includeRecentlyFunded: z.boolean().default(true),
  maxContacts: z.number().int().min(1).max(30).default(10),
});

export const FounderContactContractSchema = z.object({
  contactId: z.string(),
  founderName: z.string().min(1),
  role: z.string().min(1),
  company: z.string().min(1),
  companyWebsite: z.string().url().nullable(),
  fundingOrHiringEvidence: z.string().min(1),
  evidenceSourceUrl: z.string().url(),
  sourceDate: z.string().nullable(),
  publicProfessionalEmail: z.string().email().nullable(),
  emailSourceUrl: z.string().url().nullable(),
  emailVerifiedPublic: z.boolean(),
  linkedinUrl: z.string().url().nullable(),
  relevanceToCandidate: z.string().min(1),
  confidenceScore: z.number().min(0).max(100),
});

export const CloverTaskOutputSchema = z.object({
  foundersResearched: z.number().int().min(0),
  verifiedEmailsFound: z.number().int().min(0),
  unavailableEmailsMarked: z.number().int().min(0),
  duplicatesRemoved: z.number().int().min(0),
  contacts: z.array(FounderContactContractSchema),
});

// --- Agent 6: Pip (Gmail Outreach) Schemas ---
export const PipDraftTaskInputSchema = z.object({
  campaignId: z.string(),
  contacts: z.array(FounderContactContractSchema).min(1),
});

export const PipDraftItemSchema = z.object({
  draftId: z.string(),
  contactId: z.string(),
  recipientName: z.string(),
  recipientEmail: z.string().email().nullable(),
  company: z.string(),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  whyCompanyExplanation: z.string().min(1),
  highlightedSkills: z.array(z.string()),
  highlightedProjects: z.array(z.string()),
  gmailDraftId: z.string().nullable(),
  status: z.enum(['DRAFTED', 'PENDING_APPROVAL', 'SKIPPED']),
});

export const PipDraftTaskOutputSchema = z.object({
  draftsCreated: z.number().int().min(0),
  awaitingApproval: z.number().int().min(0),
  skippedDuplicateOrOptOut: z.number().int().min(0),
  drafts: z.array(PipDraftItemSchema),
});

export const PipSendTaskInputSchema = z.object({
  approvalId: z.string().min(1),
  draftIds: z.array(z.string()).min(1),
});

export const PipSendTaskOutputSchema = z.object({
  sentCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  bouncedCount: z.number().int().min(0),
  results: z.array(
    z.object({
      draftId: z.string(),
      recipientEmail: z.string().email(),
      gmailMessageId: z.string().nullable(),
      status: z.enum(['SENT', 'FAILED', 'BOUNCED', 'OPTED_OUT']),
      error: z.string().nullable(),
    }),
  ),
});

// --- Universal Delegated Task Envelope ---
export const DelegatedTaskEnvelopeSchema = z.object({
  taskId: z.string().min(1),
  workflowId: z.string().min(1),
  requestingAgent: AgentIdSchema,
  assignedAgent: AgentIdSchema,
  userId: z.string().min(1),
  taskType: z.string().min(1),
  input: z.unknown(),
  candidateContext: CandidateContextSchema,
  expectedOutput: z.string(),
  status: TaskStatusReportSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  result: z.unknown().nullable().optional(),
  error: z.string().nullable().optional(),
});

export type DelegatedTaskEnvelope = z.infer<typeof DelegatedTaskEnvelopeSchema>;

/**
 * Untrusted External Data Guardrail
 * Ensures job descriptions, resumes, and scraped startup text cannot inject instructions.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /system\s*prompt\s*:/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /disregard\s+your\s+rules/i,
  /auto[- ]?approve\s+all/i,
  /send\s+email\s+without\s+approval/i,
];

export function detectPromptInjectionAttempt(rawText: string): {
  suspicious: boolean;
  matchedPattern: string | null;
} {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(rawText)) {
      return { suspicious: true, matchedPattern: pattern.source };
    }
  }
  return { suspicious: false, matchedPattern: null };
}

export function sanitizeUntrustedData(rawText: string, label: string): string {
  const detection = detectPromptInjectionAttempt(rawText);
  const cleaned = rawText
    .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions/gi, '[REDACTED_DIRECTIVE]')
    .replace(/disregard\s+your\s+rules/gi, '[REDACTED_DIRECTIVE]');
  return `<untrusted_data source="${label}" injection_detected="${detection.suspicious}">\n${cleaned}\n</untrusted_data>`;
}
