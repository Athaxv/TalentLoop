/**
 * TalentLoop Core Database Types & Status Enums
 * Covers all 21 required domain models with strict typing.
 */

export type ApplicationStatus =
  | 'DISCOVERED'
  | 'MATCHED'
  | 'SHORTLISTED'
  | 'PENDING_APPROVAL'
  | 'IN_PROGRESS'
  | 'APPLIED'
  | 'ALREADY_APPLIED'
  | 'SKIPPED'
  | 'FAILED'
  | 'INTERVIEW'
  | 'REJECTED'
  | 'OFFER';

export type OutreachStatus =
  | 'DISCOVERED'
  | 'CONTACT_VERIFIED'
  | 'DRAFTED'
  | 'PENDING_APPROVAL'
  | 'SENT'
  | 'DELIVERED'
  | 'BOUNCED'
  | 'REPLIED'
  | 'OPTED_OUT'
  | 'FAILED';

export type AgentId = 'milo' | 'wally' | 'inky' | 'scout' | 'clover' | 'pip';

export type AgentRuntimeState = 'ONLINE' | 'IDLE' | 'BUSY' | 'OFFLINE' | 'ERROR';

export type TaskLifecycleStatus =
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'REQUIRES_APPROVAL'
  | 'COMPLETED'
  | 'FAILED';

export type WorkflowStatus =
  | 'PLANNING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type ApprovalActionType =
  | 'BATCH_APPLICATION'
  | 'SEND_EMAIL'
  | 'FOLLOW_UP_EMAIL';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EDITED';

export type UserRoleSelection = 'UNSELECTED' | 'JOB_SEEKER' | 'HIRING';

export type OnboardingStage =
  | 'WELCOME'
  | 'ROLE_SELECTION'
  | 'COLLECT_BASIC_INFO'
  | 'COLLECT_RESUME'
  | 'COLLECT_PREFERENCES'
  | 'REVIEW_PROFILE'
  | 'COMPLETED'
  | 'HIRING_WAITLIST';

export interface UserRecord {
  id: string;
  slackUserId: string;
  slackTeamId: string | null;
  slackUsername: string | null;
  switchParticipantId: string | null;
  email: string | null;
  fullName: string | null;
  phone: string | null;
  passwordHash?: string | null;
  roleSelection: UserRoleSelection;
  onboardingStage: OnboardingStage;
  onboardingCompleted: boolean;
  dedicatedSlackChannelId?: string | null;
  dedicatedSlackChannelName?: string | null;
  dedicatedSwitchRoomId?: string | null;
  gmailConnected: boolean;
  gmailEmail: string | null;
  gmailRefreshToken: string | null;
  gmailAccessToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface CandidateProfileRecord {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  phone: string | null;
  location: string | null;
  headline: string | null;
  summary: string | null;
  experienceLevel: 'fresher' | 'entry' | 'mid' | 'senior' | 'any';
  yearsOfExperience: number | null;
  preferredRoles: string[];
  preferredLocations: string[];
  preferredJobTypes: ('full-time' | 'internship' | 'part-time' | 'contract' | 'any')[];
  workModePreference: 'remote' | 'hybrid' | 'onsite' | 'any';
  minSalaryText: string | null;
  minSalaryAmount: number | null;
  salaryCurrency: string | null;
  portfolioUrl: string | null;
  githubUrl: string | null;
  linkedinUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeRecord {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  rawText: string;
  parsedJson: string;
  sourceMxcUrl: string | null;
  isPrimary: boolean;
  createdAt: string;
}

export interface SkillRecord {
  id: string;
  userId: string;
  profileId: string;
  name: string;
  category: string;
  proficiency: string | null;
  createdAt: string;
}

export interface ExperienceRecord {
  id: string;
  userId: string;
  profileId: string;
  company: string;
  role: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  description: string;
  createdAt: string;
}

export interface EducationRecord {
  id: string;
  userId: string;
  profileId: string;
  institution: string;
  degree: string;
  fieldOfStudy: string | null;
  startYear: string | null;
  endYear: string | null;
  grade: string | null;
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  userId: string;
  profileId: string;
  name: string;
  description: string;
  techStack: string[];
  repoUrl: string | null;
  liveUrl: string | null;
  createdAt: string;
}

export interface CompanyRecord {
  id: string;
  name: string;
  normalizedName: string;
  website: string | null;
  domain: string | null;
  description: string | null;
  industry: string | null;
  location: string | null;
  fundingStage: string | null;
  fundingAmount: string | null;
  fundingDate: string | null;
  fundingSourceUrl: string | null;
  hiringEvidence: string | null;
  hiringSourceUrl: string | null;
  ycBatch: string | null;
  isActivelyHiring: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  companyId: string | null;
  companyName: string;
  title: string;
  location: string;
  workMode: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  employmentType: 'full-time' | 'internship' | 'part-time' | 'contract';
  salaryText: string | null;
  experienceRequirements: string | null;
  requiredSkills: string[];
  description: string;
  postedAt: string | null;
  applicationUrl: string;
  sourceUrl: string;
  platform: 'wellfound' | 'internshala' | 'linkedin' | 'yc' | 'greenhouse' | 'lever' | 'remoteok' | 'arbeitnow' | 'public_web';
  isVerifiedCurrent: boolean;
  dedupFingerprint: string;
  discoveredAt: string;
}

export interface JobMatchRecord {
  id: string;
  userId: string;
  jobId: string;
  workflowId: string | null;
  matchScore: number;
  eligibleByCrawlJobScreen: boolean;
  screeningReason: string;
  matchedSkills: string[];
  missingSkills: string[];
  rankOrder: number;
  status: ApplicationStatus;
  createdAt: string;
}

export interface FounderContactRecord {
  id: string;
  companyId: string;
  companyName: string;
  companyWebsite: string | null;
  founderName: string;
  role: string;
  fundingOrHiringEvidence: string;
  evidenceSourceUrl: string;
  sourceDate: string | null;
  publicEmail: string | null;
  emailVerifiedPublic: boolean;
  emailSourceUrl: string | null;
  linkedinUrl: string | null;
  relevanceToCandidate: string;
  confidenceScore: number;
  status: OutreachStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationRecord {
  id: string;
  userId: string;
  jobId: string;
  workflowId: string | null;
  taskId: string | null;
  approvalId: string | null;
  agentId: 'wally' | 'inky';
  platform: 'wellfound' | 'internshala';
  status: ApplicationStatus;
  verifiedSubmission: boolean;
  crawlJobResultCode: string | null;
  skipOrFailureReason: string | null;
  screenshotPath: string | null;
  auditLogJson: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachCampaignRecord {
  id: string;
  userId: string;
  workflowId: string | null;
  name: string;
  targetRole: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  createdAt: string;
  updatedAt: string;
}

export interface EmailDraftRecord {
  id: string;
  userId: string;
  campaignId: string;
  workflowId: string | null;
  taskId: string | null;
  approvalId: string | null;
  founderContactId: string;
  companyId: string;
  recipientEmail: string | null;
  recipientName: string;
  companyName: string;
  subject: string;
  bodyText: string;
  gmailDraftId: string | null;
  whyCompanyExplanation: string;
  highlightedSkills: string[];
  highlightedProjects: string[];
  status: OutreachStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EmailMessageRecord {
  id: string;
  draftId: string;
  userId: string;
  campaignId: string;
  founderContactId: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  status: OutreachStatus;
  sentAt: string | null;
  deliveredAt: string | null;
  bouncedAt: string | null;
  bounceReason: string | null;
  repliedAt: string | null;
  optedOutAt: string | null;
  errorDetails: string | null;
  createdAt: string;
}

export interface AgentRecord {
  id: AgentId;
  displayName: string;
  roleTitle: string;
  description: string;
  switchAgentId: string | null;
  switchApiKey: string | null;
  switchConnectionId: string;
  switchGeneration: number;
  switchCursor: number;
  switchRoomId: string | null;
  status: AgentRuntimeState;
  currentTaskId: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRecord {
  id: string;
  userId: string;
  title: string;
  naturalLanguageRequest: string;
  switchRoomId: string;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  status: WorkflowStatus;
  reportJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskRecord {
  taskId: string;
  workflowId: string;
  requestingAgent: AgentId;
  assignedAgent: AgentId;
  userId: string;
  taskType: string;
  inputJson: string;
  candidateContextJson: string;
  expectedOutputJson: string;
  status: TaskLifecycleStatus;
  idempotencyKey: string;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  resultJson: string | null;
  errorText: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentEventRecord {
  id: string;
  workflowId: string | null;
  taskId: string | null;
  agentId: AgentId;
  eventType: string;
  switchSequence: number | null;
  switchRoomId: string | null;
  summary: string;
  payloadJson: string;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  workflowId: string;
  taskId: string;
  userId: string;
  actionType: ApprovalActionType;
  requestedByAgent: AgentId;
  targetAgent: AgentId;
  title: string;
  summaryText: string;
  payloadJson: string;
  editedPayloadJson: string | null;
  status: ApprovalStatus;
  decidedBySlackUserId: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  deviceName: string;
  tokenHash: string;
  tokenPrefix: string;
  status: 'ONLINE' | 'PAUSED' | 'OFFLINE';
  crawlJobPath: string;
  profilePath: string;
  browserReady: boolean;
  activeTaskId: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  workflowId: string | null;
  level: 'INFO' | 'SUCCESS' | 'WARNING' | 'APPROVAL_REQUIRED' | 'ERROR';
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}
