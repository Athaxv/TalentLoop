import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentEventRecord,
  AgentId,
  AgentRecord,
  AgentRuntimeState,
  AgentTaskRecord,
  ApplicationRecord,
  ApplicationStatus,
  ApprovalActionType,
  ApprovalRecord,
  ApprovalStatus,
  CandidateProfileRecord,
  CompanyRecord,
  DeviceRecord,
  EducationRecord,
  EmailDraftRecord,
  EmailMessageRecord,
  ExperienceRecord,
  FounderContactRecord,
  JobMatchRecord,
  JobRecord,
  NotificationRecord,
  OnboardingStage,
  OutreachCampaignRecord,
  OutreachStatus,
  ProjectRecord,
  ResumeRecord,
  SkillRecord,
  TaskLifecycleStatus,
  UserRecord,
  UserRoleSelection,
  WorkflowRecord,
  WorkflowStatus,
} from './schema';

const DEFAULT_AGENTS: Array<{
  id: AgentId;
  displayName: string;
  roleTitle: string;
  description: string;
}> = [
  {
    id: 'milo',
    displayName: 'Milo — Talent Manager',
    roleTitle: 'Talent Manager & Team Coordinator',
    description:
      'Main coordinator and user-facing Talent Manager. Handles onboarding, workflow planning, Switch task delegation, human approval gates, and consolidated reporting.',
  },
  {
    id: 'wally',
    displayName: 'Wally — Wellfound Specialist',
    roleTitle: 'Wellfound Application Agent',
    description:
      'Dedicated Wellfound application specialist running crawlJob Wellfound automation through the authorized local browser companion.',
  },
  {
    id: 'inky',
    displayName: 'Inky — Internshala Specialist',
    roleTitle: 'Internshala Application Agent',
    description:
      'Dedicated Internshala application specialist running crawlJob Internshala internships & jobs automation through the local browser companion.',
  },
  {
    id: 'scout',
    displayName: 'Scout — Opportunity Discovery',
    roleTitle: 'Opportunity Discovery Agent',
    description:
      'Searches public job boards, YC startups, and career pages; normalizes, deduplicates, and ranks relevant job opportunities.',
  },
  {
    id: 'clover',
    displayName: 'Clover — Founder Intelligence',
    roleTitle: 'Founder & Startup Research Agent',
    description:
      'Researches recently funded and actively hiring startups, identifies founders and hiring leaders, and verifies publicly listed business emails.',
  },
  {
    id: 'pip',
    displayName: 'Pip — Gmail Outreach',
    roleTitle: 'Personalized Cold-Email & Gmail Specialist',
    description:
      'Drafts personalized founder outreach grounded in candidate facts, creates Gmail drafts, enforces approval before sending, and prevents duplicate outreach.',
  },
];

let dbInstance: DatabaseSync | null = null;
let currentDbPath: string | null = null;

export function getDbPath(): string {
  const envPath = process.env.TALENTLOOP_DB_PATH?.trim();
  if (envPath) {
    return envPath === ':memory:' ? ':memory:' : path.resolve(envPath);
  }
  return path.resolve(process.cwd(), '.talentloop', 'talentloop.sqlite');
}

export function getDb(): DatabaseSync {
  const resolvedPath = getDbPath();
  if (dbInstance && currentDbPath === resolvedPath) {
    return dbInstance;
  }
  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }
  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  seedDefaultAgents(db);
  dbInstance = db;
  currentDbPath = resolvedPath;
  return db;
}

export function resetDbForTests(customPath = ':memory:'): DatabaseSync {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore close errors
    }
  }
  process.env.TALENTLOOP_DB_PATH = customPath;
  dbInstance = null;
  currentDbPath = null;
  return getDb();
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      slack_user_id TEXT NOT NULL UNIQUE,
      slack_team_id TEXT,
      slack_username TEXT,
      switch_participant_id TEXT,
      email TEXT UNIQUE,
      full_name TEXT,
      phone TEXT,
      password_hash TEXT,
      role_selection TEXT NOT NULL DEFAULT 'UNSELECTED',
      onboarding_stage TEXT NOT NULL DEFAULT 'WELCOME',
      onboarding_completed INTEGER NOT NULL DEFAULT 0,
      gmail_connected INTEGER NOT NULL DEFAULT 0,
      gmail_email TEXT,
      gmail_refresh_token TEXT,
      gmail_access_token TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_slack_user_id ON users(slack_user_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token_hash);

    CREATE TABLE IF NOT EXISTS candidate_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      location TEXT,
      headline TEXT,
      summary TEXT,
      experience_level TEXT NOT NULL DEFAULT 'entry',
      years_of_experience REAL,
      preferred_roles_json TEXT NOT NULL DEFAULT '[]',
      preferred_locations_json TEXT NOT NULL DEFAULT '[]',
      preferred_job_types_json TEXT NOT NULL DEFAULT '["full-time","internship"]',
      work_mode_preference TEXT NOT NULL DEFAULT 'any',
      min_salary_text TEXT,
      min_salary_amount REAL,
      salary_currency TEXT,
      portfolio_url TEXT,
      github_url TEXT,
      linkedin_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resumes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      raw_text TEXT NOT NULL,
      parsed_json TEXT NOT NULL,
      source_mxc_url TEXT,
      is_primary INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_resumes_user_id ON resumes(user_id);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      proficiency TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(profile_id, name)
    );

    CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      location TEXT,
      start_date TEXT,
      end_date TEXT,
      is_current INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS educations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
      institution TEXT NOT NULL,
      degree TEXT NOT NULL,
      field_of_study TEXT,
      start_year TEXT,
      end_year TEXT,
      grade TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      tech_stack_json TEXT NOT NULL DEFAULT '[]',
      repo_url TEXT,
      live_url TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      website TEXT,
      domain TEXT,
      description TEXT,
      industry TEXT,
      location TEXT,
      funding_stage TEXT,
      funding_amount TEXT,
      funding_date TEXT,
      funding_source_url TEXT,
      hiring_evidence TEXT,
      hiring_source_url TEXT,
      yc_batch TEXT,
      is_actively_hiring INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      company_name TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT NOT NULL,
      work_mode TEXT NOT NULL DEFAULT 'unknown',
      employment_type TEXT NOT NULL DEFAULT 'full-time',
      salary_text TEXT,
      experience_requirements TEXT,
      required_skills_json TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL,
      posted_at TEXT,
      application_url TEXT NOT NULL UNIQUE,
      source_url TEXT NOT NULL,
      platform TEXT NOT NULL,
      is_verified_current INTEGER NOT NULL DEFAULT 1,
      dedup_fingerprint TEXT NOT NULL UNIQUE,
      discovered_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_platform ON jobs(platform);
    CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);

    CREATE TABLE IF NOT EXISTS job_matches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      workflow_id TEXT,
      match_score REAL NOT NULL,
      eligible_by_crawljob_screen INTEGER NOT NULL DEFAULT 1,
      screening_reason TEXT NOT NULL,
      matched_skills_json TEXT NOT NULL DEFAULT '[]',
      missing_skills_json TEXT NOT NULL DEFAULT '[]',
      rank_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'MATCHED',
      created_at TEXT NOT NULL,
      UNIQUE(user_id, job_id)
    );

    CREATE INDEX IF NOT EXISTS idx_job_matches_user_score ON job_matches(user_id, match_score DESC);

    CREATE TABLE IF NOT EXISTS founder_contacts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      company_name TEXT NOT NULL,
      company_website TEXT,
      founder_name TEXT NOT NULL,
      role TEXT NOT NULL,
      funding_or_hiring_evidence TEXT NOT NULL,
      evidence_source_url TEXT NOT NULL,
      source_date TEXT,
      public_email TEXT,
      email_verified_public INTEGER NOT NULL DEFAULT 0,
      email_source_url TEXT,
      linkedin_url TEXT,
      relevance_to_candidate TEXT NOT NULL,
      confidence_score REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'DISCOVERED',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, founder_name)
    );

    CREATE INDEX IF NOT EXISTS idx_founder_contacts_email ON founder_contacts(public_email);

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      workflow_id TEXT,
      task_id TEXT,
      approval_id TEXT,
      agent_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DISCOVERED',
      verified_submission INTEGER NOT NULL DEFAULT 0,
      crawljob_result_code TEXT,
      skip_or_failure_reason TEXT,
      screenshot_path TEXT,
      audit_log_json TEXT,
      submitted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, job_id)
    );

    CREATE INDEX IF NOT EXISTS idx_applications_user_status ON applications(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_applications_workflow ON applications(workflow_id);

    CREATE TABLE IF NOT EXISTS outreach_campaigns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workflow_id TEXT,
      name TEXT NOT NULL,
      target_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
      workflow_id TEXT,
      task_id TEXT,
      approval_id TEXT,
      founder_contact_id TEXT NOT NULL REFERENCES founder_contacts(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      recipient_email TEXT,
      recipient_name TEXT NOT NULL,
      company_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      gmail_draft_id TEXT,
      why_company_explanation TEXT NOT NULL,
      highlighted_skills_json TEXT NOT NULL DEFAULT '[]',
      highlighted_projects_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'DRAFTED',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, campaign_id, founder_contact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_email_drafts_user_status ON email_drafts(user_id, status);

    CREATE TABLE IF NOT EXISTS email_messages (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE REFERENCES email_drafts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
      founder_contact_id TEXT NOT NULL REFERENCES founder_contacts(id) ON DELETE CASCADE,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      gmail_message_id TEXT,
      gmail_thread_id TEXT,
      status TEXT NOT NULL,
      sent_at TEXT,
      delivered_at TEXT,
      bounced_at TEXT,
      bounce_reason TEXT,
      replied_at TEXT,
      opted_out_at TEXT,
      error_details TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(campaign_id, recipient_email)
    );

    CREATE INDEX IF NOT EXISTS idx_email_messages_recipient ON email_messages(recipient_email);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role_title TEXT NOT NULL,
      description TEXT NOT NULL,
      switch_agent_id TEXT,
      switch_api_key TEXT,
      switch_connection_id TEXT NOT NULL,
      switch_generation INTEGER NOT NULL DEFAULT 0,
      switch_cursor INTEGER NOT NULL DEFAULT 0,
      switch_room_id TEXT,
      status TEXT NOT NULL DEFAULT 'IDLE',
      current_task_id TEXT,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      natural_language_request TEXT NOT NULL,
      switch_room_id TEXT NOT NULL,
      slack_channel_id TEXT,
      slack_thread_ts TEXT,
      status TEXT NOT NULL DEFAULT 'PLANNING',
      report_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflows_user_id ON workflows(user_id);

    CREATE TABLE IF NOT EXISTS agent_tasks (
      task_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      requesting_agent TEXT NOT NULL REFERENCES agents(id),
      assigned_agent TEXT NOT NULL REFERENCES agents(id),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_type TEXT NOT NULL,
      input_json TEXT NOT NULL,
      candidate_context_json TEXT NOT NULL,
      expected_output_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACCEPTED',
      idempotency_key TEXT NOT NULL UNIQUE,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 2,
      timeout_ms INTEGER NOT NULL DEFAULT 120000,
      result_json TEXT,
      error_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_tasks_workflow ON agent_tasks(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_assigned_status ON agent_tasks(assigned_agent, status);

    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      workflow_id TEXT,
      task_id TEXT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      event_type TEXT NOT NULL,
      switch_sequence INTEGER,
      switch_room_id TEXT,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_events_workflow ON agent_events(workflow_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      requested_by_agent TEXT NOT NULL REFERENCES agents(id),
      target_agent TEXT NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      edited_payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      decided_by_slack_user_id TEXT,
      decision_note TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_user_status ON approvals(user_id, status);

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OFFLINE',
      crawljob_path TEXT NOT NULL,
      profile_path TEXT NOT NULL,
      browser_ready INTEGER NOT NULL DEFAULT 0,
      active_task_id TEXT,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workflow_id TEXT,
      level TEXT NOT NULL DEFAULT 'INFO',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC);
  `);

  // Safe migration for existing SQLite files
  const alterStatements = [
    'ALTER TABLE users ADD COLUMN password_hash TEXT;',
    'ALTER TABLE users ADD COLUMN dedicated_slack_channel_id TEXT;',
    'ALTER TABLE users ADD COLUMN dedicated_slack_channel_name TEXT;',
    'ALTER TABLE users ADD COLUMN dedicated_switch_room_id TEXT;',
  ];
  for (const sql of alterStatements) {
    try {
      db.exec(sql);
    } catch {
      // column already exists
    }
  }
}

function seedDefaultAgents(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO agents (
      id, display_name, role_title, description,
      switch_connection_id, switch_generation, switch_cursor,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 'IDLE', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      role_title = excluded.role_title,
      description = excluded.description
  `);

  for (const agent of DEFAULT_AGENTS) {
    stmt.run(
      agent.id,
      agent.displayName,
      agent.roleTitle,
      agent.description,
      crypto.randomUUID(),
      now,
      now,
    );
  }
}

function mapUserRow(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    slackUserId: String(row.slack_user_id),
    slackTeamId: row.slack_team_id ? String(row.slack_team_id) : null,
    slackUsername: row.slack_username ? String(row.slack_username) : null,
    switchParticipantId: row.switch_participant_id ? String(row.switch_participant_id) : null,
    email: row.email ? String(row.email) : null,
    fullName: row.full_name ? String(row.full_name) : null,
    phone: row.phone ? String(row.phone) : null,
    passwordHash: row.password_hash ? String(row.password_hash) : null,
    roleSelection: row.role_selection as UserRoleSelection,
    onboardingStage: row.onboarding_stage as OnboardingStage,
    onboardingCompleted: Boolean(row.onboarding_completed),
    dedicatedSlackChannelId: row.dedicated_slack_channel_id
      ? String(row.dedicated_slack_channel_id)
      : null,
    dedicatedSlackChannelName: row.dedicated_slack_channel_name
      ? String(row.dedicated_slack_channel_name)
      : null,
    dedicatedSwitchRoomId: row.dedicated_switch_room_id
      ? String(row.dedicated_switch_room_id)
      : null,
    gmailConnected: Boolean(row.gmail_connected),
    gmailEmail: row.gmail_email ? String(row.gmail_email) : null,
    gmailRefreshToken: row.gmail_refresh_token ? String(row.gmail_refresh_token) : null,
    gmailAccessToken: row.gmail_access_token ? String(row.gmail_access_token) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    id: row.id as AgentId,
    displayName: String(row.display_name),
    roleTitle: String(row.role_title),
    description: String(row.description),
    switchAgentId: row.switch_agent_id ? String(row.switch_agent_id) : null,
    switchApiKey: row.switch_api_key ? String(row.switch_api_key) : null,
    switchConnectionId: String(row.switch_connection_id),
    switchGeneration: Number(row.switch_generation),
    switchCursor: Number(row.switch_cursor),
    switchRoomId: row.switch_room_id ? String(row.switch_room_id) : null,
    status: row.status as AgentRuntimeState,
    currentTaskId: row.current_task_id ? String(row.current_task_id) : null,
    lastHeartbeatAt: row.last_heartbeat_at ? String(row.last_heartbeat_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTaskRow(row: Record<string, unknown>): AgentTaskRecord {
  return {
    taskId: String(row.task_id),
    workflowId: String(row.workflow_id),
    requestingAgent: row.requesting_agent as AgentId,
    assignedAgent: row.assigned_agent as AgentId,
    userId: String(row.user_id),
    taskType: String(row.task_type),
    inputJson: String(row.input_json),
    candidateContextJson: String(row.candidate_context_json),
    expectedOutputJson: String(row.expected_output_json),
    status: row.status as TaskLifecycleStatus,
    idempotencyKey: String(row.idempotency_key),
    retryCount: Number(row.retry_count),
    maxRetries: Number(row.max_retries),
    timeoutMs: Number(row.timeout_ms),
    resultJson: row.result_json ? String(row.result_json) : null,
    errorText: row.error_text ? String(row.error_text) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEventRow(row: Record<string, unknown>): AgentEventRecord {
  return {
    id: String(row.id),
    workflowId: row.workflow_id ? String(row.workflow_id) : null,
    taskId: row.task_id ? String(row.task_id) : null,
    agentId: row.agent_id as AgentId,
    eventType: String(row.event_type),
    switchSequence: row.switch_sequence != null ? Number(row.switch_sequence) : null,
    switchRoomId: row.switch_room_id ? String(row.switch_room_id) : null,
    summary: String(row.summary),
    payloadJson: String(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function mapWorkflowRow(row: Record<string, unknown>): WorkflowRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    naturalLanguageRequest: String(row.natural_language_request),
    switchRoomId: String(row.switch_room_id),
    slackChannelId: row.slack_channel_id ? String(row.slack_channel_id) : null,
    slackThreadTs: row.slack_thread_ts ? String(row.slack_thread_ts) : null,
    status: row.status as WorkflowStatus,
    reportJson: row.report_json ? String(row.report_json) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapApprovalRow(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    taskId: String(row.task_id),
    userId: String(row.user_id),
    actionType: row.action_type as ApprovalActionType,
    requestedByAgent: row.requested_by_agent as AgentId,
    targetAgent: row.target_agent as AgentId,
    title: String(row.title),
    summaryText: String(row.summary_text),
    payloadJson: String(row.payload_json),
    editedPayloadJson: row.edited_payload_json ? String(row.edited_payload_json) : null,
    status: row.status as ApprovalStatus,
    decidedBySlackUserId: row.decided_by_slack_user_id ? String(row.decided_by_slack_user_id) : null,
    decisionNote: row.decision_note ? String(row.decision_note) : null,
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    createdAt: String(row.created_at),
  };
}

export const dbRepo = {
  // --- Users ---
  getOrCreateUserBySlack(params: {
    slackUserId: string;
    slackTeamId?: string | null;
    slackUsername?: string | null;
    switchParticipantId?: string | null;
  }): UserRecord {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM users WHERE slack_user_id = ?')
      .get(params.slackUserId) as Record<string, unknown> | undefined;

    if (existing) {
      if (params.switchParticipantId && !existing.switch_participant_id) {
        const now = new Date().toISOString();
        db.prepare('UPDATE users SET switch_participant_id = ?, updated_at = ? WHERE id = ?').run(
          params.switchParticipantId,
          now,
          existing.id as string,
        );
        existing.switch_participant_id = params.switchParticipantId;
        existing.updated_at = now;
      }
      return mapUserRow(existing);
    }

    const id = `usr_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (
        id, slack_user_id, slack_team_id, slack_username, switch_participant_id,
        role_selection, onboarding_stage, onboarding_completed, gmail_connected,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'UNSELECTED', 'WELCOME', 0, 0, ?, ?)
    `).run(
      id,
      params.slackUserId,
      params.slackTeamId ?? null,
      params.slackUsername ?? null,
      params.switchParticipantId ?? null,
      now,
      now,
    );

    const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
    return mapUserRow(created);
  },

  getUserById(userId: string): UserRecord | null {
    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapUserRow(row) : null;
  },

  getUserBySlackId(slackUserId: string): UserRecord | null {
    const row = getDb()
      .prepare('SELECT * FROM users WHERE slack_user_id = ?')
      .get(slackUserId) as Record<string, unknown> | undefined;
    return row ? mapUserRow(row) : null;
  },

  getUserByEmail(email: string): UserRecord | null {
    const row = getDb()
      .prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)')
      .get(email.trim()) as Record<string, unknown> | undefined;
    return row ? mapUserRow(row) : null;
  },

  listUsers(): UserRecord[] {
    const rows = getDb()
      .prepare('SELECT * FROM users ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map(mapUserRow);
  },

  getUserByDedicatedChannel(slackChannelId: string): UserRecord | null {
    const row = getDb()
      .prepare('SELECT * FROM users WHERE dedicated_slack_channel_id = ?')
      .get(slackChannelId) as Record<string, unknown> | undefined;
    return row ? mapUserRow(row) : null;
  },

  setUserDedicatedWorkspace(params: {
    userId: string;
    slackChannelId: string;
    slackChannelName: string;
    switchRoomId: string;
  }): UserRecord {
    const now = new Date().toISOString();
    getDb()
      .prepare(`
        UPDATE users SET
          dedicated_slack_channel_id = ?,
          dedicated_slack_channel_name = ?,
          dedicated_switch_room_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        params.slackChannelId,
        params.slackChannelName,
        params.switchRoomId,
        now,
        params.userId,
      );
    return this.getUserById(params.userId)!;
  },

  updateUserOnboarding(
    userId: string,
    updates: Partial<{
      roleSelection: UserRoleSelection;
      onboardingStage: OnboardingStage;
      onboardingCompleted: boolean;
      fullName: string;
      email: string;
      phone: string | null;
    }>,
  ): UserRecord {
    const db = getDb();
    const current = this.getUserById(userId);
    if (!current) throw new Error(`User not found: ${userId}`);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE users SET
        role_selection = ?,
        onboarding_stage = ?,
        onboarding_completed = ?,
        full_name = ?,
        email = ?,
        phone = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      updates.roleSelection ?? current.roleSelection,
      updates.onboardingStage ?? current.onboardingStage,
      (updates.onboardingCompleted ?? current.onboardingCompleted) ? 1 : 0,
      updates.fullName ?? current.fullName,
      updates.email ?? current.email,
      updates.phone !== undefined ? updates.phone : current.phone,
      now,
      userId,
    );
    return this.getUserById(userId)!;
  },

  // --- Candidate Profiles & Related Entities ---
  upsertCandidateProfile(
    userId: string,
    data: Omit<CandidateProfileRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>,
  ): CandidateProfileRecord {
    const db = getDb();
    const existing = db
      .prepare('SELECT id FROM candidate_profiles WHERE user_id = ?')
      .get(userId) as { id: string } | undefined;
    const id = existing?.id ?? `prf_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO candidate_profiles (
        id, user_id, full_name, email, phone, location, headline, summary,
        experience_level, years_of_experience, preferred_roles_json,
        preferred_locations_json, preferred_job_types_json, work_mode_preference,
        min_salary_text, min_salary_amount, salary_currency,
        portfolio_url, github_url, linkedin_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        full_name = excluded.full_name,
        email = excluded.email,
        phone = excluded.phone,
        location = excluded.location,
        headline = excluded.headline,
        summary = excluded.summary,
        experience_level = excluded.experience_level,
        years_of_experience = excluded.years_of_experience,
        preferred_roles_json = excluded.preferred_roles_json,
        preferred_locations_json = excluded.preferred_locations_json,
        preferred_job_types_json = excluded.preferred_job_types_json,
        work_mode_preference = excluded.work_mode_preference,
        min_salary_text = excluded.min_salary_text,
        min_salary_amount = excluded.min_salary_amount,
        salary_currency = excluded.salary_currency,
        portfolio_url = excluded.portfolio_url,
        github_url = excluded.github_url,
        linkedin_url = excluded.linkedin_url,
        updated_at = excluded.updated_at
    `).run(
      id,
      userId,
      data.fullName,
      data.email,
      data.phone,
      data.location,
      data.headline,
      data.summary,
      data.experienceLevel,
      data.yearsOfExperience,
      JSON.stringify(data.preferredRoles),
      JSON.stringify(data.preferredLocations),
      JSON.stringify(data.preferredJobTypes),
      data.workModePreference,
      data.minSalaryText,
      data.minSalaryAmount,
      data.salaryCurrency,
      data.portfolioUrl,
      data.githubUrl,
      data.linkedinUrl,
      now,
      now,
    );

    return this.getCandidateProfile(userId)!;
  },

  getCandidateProfile(userId: string): CandidateProfileRecord | null {
    const row = getDb()
      .prepare('SELECT * FROM candidate_profiles WHERE user_id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      fullName: String(row.full_name),
      email: String(row.email),
      phone: row.phone ? String(row.phone) : null,
      location: row.location ? String(row.location) : null,
      headline: row.headline ? String(row.headline) : null,
      summary: row.summary ? String(row.summary) : null,
      experienceLevel: row.experience_level as CandidateProfileRecord['experienceLevel'],
      yearsOfExperience: row.years_of_experience != null ? Number(row.years_of_experience) : null,
      preferredRoles: JSON.parse(String(row.preferred_roles_json || '[]')),
      preferredLocations: JSON.parse(String(row.preferred_locations_json || '[]')),
      preferredJobTypes: JSON.parse(String(row.preferred_job_types_json || '[]')),
      workModePreference: row.work_mode_preference as CandidateProfileRecord['workModePreference'],
      minSalaryText: row.min_salary_text ? String(row.min_salary_text) : null,
      minSalaryAmount: row.min_salary_amount != null ? Number(row.min_salary_amount) : null,
      salaryCurrency: row.salary_currency ? String(row.salary_currency) : null,
      portfolioUrl: row.portfolio_url ? String(row.portfolio_url) : null,
      githubUrl: row.github_url ? String(row.github_url) : null,
      linkedinUrl: row.linkedin_url ? String(row.linkedin_url) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  },

  replaceProfileCollections(
    userId: string,
    profileId: string,
    collections: {
      skills?: Array<{ name: string; category?: string; proficiency?: string | null }>;
      experiences?: Array<{
        company: string;
        role: string;
        location?: string | null;
        startDate?: string | null;
        endDate?: string | null;
        isCurrent?: boolean;
        description: string;
      }>;
      educations?: Array<{
        institution: string;
        degree: string;
        fieldOfStudy?: string | null;
        startYear?: string | null;
        endYear?: string | null;
        grade?: string | null;
      }>;
      projects?: Array<{
        name: string;
        description: string;
        techStack?: string[];
        repoUrl?: string | null;
        liveUrl?: string | null;
      }>;
    },
  ): void {
    const db = getDb();
    const now = new Date().toISOString();

    if (collections.skills) {
      db.prepare('DELETE FROM skills WHERE profile_id = ?').run(profileId);
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO skills (id, user_id, profile_id, name, category, proficiency, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of collections.skills) {
        stmt.run(
          `skl_${crypto.randomUUID().slice(0, 12)}`,
          userId,
          profileId,
          s.name.trim(),
          s.category ?? 'technical',
          s.proficiency ?? null,
          now,
        );
      }
    }

    if (collections.experiences) {
      db.prepare('DELETE FROM experiences WHERE profile_id = ?').run(profileId);
      const stmt = db.prepare(`
        INSERT INTO experiences (
          id, user_id, profile_id, company, role, location, start_date, end_date, is_current, description, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const exp of collections.experiences) {
        stmt.run(
          `exp_${crypto.randomUUID().slice(0, 12)}`,
          userId,
          profileId,
          exp.company,
          exp.role,
          exp.location ?? null,
          exp.startDate ?? null,
          exp.endDate ?? null,
          exp.isCurrent ? 1 : 0,
          exp.description,
          now,
        );
      }
    }

    if (collections.educations) {
      db.prepare('DELETE FROM educations WHERE profile_id = ?').run(profileId);
      const stmt = db.prepare(`
        INSERT INTO educations (
          id, user_id, profile_id, institution, degree, field_of_study, start_year, end_year, grade, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const edu of collections.educations) {
        stmt.run(
          `edu_${crypto.randomUUID().slice(0, 12)}`,
          userId,
          profileId,
          edu.institution,
          edu.degree,
          edu.fieldOfStudy ?? null,
          edu.startYear ?? null,
          edu.endYear ?? null,
          edu.grade ?? null,
          now,
        );
      }
    }

    if (collections.projects) {
      db.prepare('DELETE FROM projects WHERE profile_id = ?').run(profileId);
      const stmt = db.prepare(`
        INSERT INTO projects (
          id, user_id, profile_id, name, description, tech_stack_json, repo_url, live_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const proj of collections.projects) {
        stmt.run(
          `prj_${crypto.randomUUID().slice(0, 12)}`,
          userId,
          profileId,
          proj.name,
          proj.description,
          JSON.stringify(proj.techStack ?? []),
          proj.repoUrl ?? null,
          proj.liveUrl ?? null,
          now,
        );
      }
    }
  },

  getCandidateFullBundle(userId: string): {
    user: UserRecord | null;
    profile: CandidateProfileRecord | null;
    skills: SkillRecord[];
    experiences: ExperienceRecord[];
    educations: EducationRecord[];
    projects: ProjectRecord[];
    resumes: ResumeRecord[];
  } {
    const db = getDb();
    const user = this.getUserById(userId);
    const profile = this.getCandidateProfile(userId);

    const skills = (db
      .prepare('SELECT * FROM skills WHERE user_id = ? ORDER BY name ASC')
      .all(userId) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      profileId: String(r.profile_id),
      name: String(r.name),
      category: String(r.category),
      proficiency: r.proficiency ? String(r.proficiency) : null,
      createdAt: String(r.created_at),
    }));

    const experiences = (db
      .prepare('SELECT * FROM experiences WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      profileId: String(r.profile_id),
      company: String(r.company),
      role: String(r.role),
      location: r.location ? String(r.location) : null,
      startDate: r.start_date ? String(r.start_date) : null,
      endDate: r.end_date ? String(r.end_date) : null,
      isCurrent: Boolean(r.is_current),
      description: String(r.description),
      createdAt: String(r.created_at),
    }));

    const educations = (db
      .prepare('SELECT * FROM educations WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      profileId: String(r.profile_id),
      institution: String(r.institution),
      degree: String(r.degree),
      fieldOfStudy: r.field_of_study ? String(r.field_of_study) : null,
      startYear: r.start_year ? String(r.start_year) : null,
      endYear: r.end_year ? String(r.end_year) : null,
      grade: r.grade ? String(r.grade) : null,
      createdAt: String(r.created_at),
    }));

    const projects = (db
      .prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      profileId: String(r.profile_id),
      name: String(r.name),
      description: String(r.description),
      techStack: JSON.parse(String(r.tech_stack_json || '[]')),
      repoUrl: r.repo_url ? String(r.repo_url) : null,
      liveUrl: r.live_url ? String(r.live_url) : null,
      createdAt: String(r.created_at),
    }));

    const resumes = (db
      .prepare('SELECT * FROM resumes WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      filename: String(r.filename),
      mimeType: String(r.mime_type),
      fileSize: Number(r.file_size),
      rawText: String(r.raw_text),
      parsedJson: String(r.parsed_json),
      sourceMxcUrl: r.source_mxc_url ? String(r.source_mxc_url) : null,
      isPrimary: Boolean(r.is_primary),
      createdAt: String(r.created_at),
    }));

    return { user, profile, skills, experiences, educations, projects, resumes };
  },

  saveResume(params: {
    userId: string;
    filename: string;
    mimeType: string;
    fileSize: number;
    rawText: string;
    parsedJson: string;
    sourceMxcUrl?: string | null;
  }): ResumeRecord {
    const db = getDb();
    const id = `res_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    db.prepare('UPDATE resumes SET is_primary = 0 WHERE user_id = ?').run(params.userId);
    db.prepare(`
      INSERT INTO resumes (
        id, user_id, filename, mime_type, file_size, raw_text, parsed_json, source_mxc_url, is_primary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      id,
      params.userId,
      params.filename,
      params.mimeType,
      params.fileSize,
      params.rawText,
      params.parsedJson,
      params.sourceMxcUrl ?? null,
      now,
    );
    return {
      id,
      userId: params.userId,
      filename: params.filename,
      mimeType: params.mimeType,
      fileSize: params.fileSize,
      rawText: params.rawText,
      parsedJson: params.parsedJson,
      sourceMxcUrl: params.sourceMxcUrl ?? null,
      isPrimary: true,
      createdAt: now,
    };
  },

  // --- Agents ---
  listAgents(): AgentRecord[] {
    const rows = getDb().prepare('SELECT * FROM agents ORDER BY id ASC').all() as Record<
      string,
      unknown
    >[];
    return rows.map(mapAgentRow);
  },

  getAgent(agentId: AgentId): AgentRecord {
    const row = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Agent not found: ${agentId}`);
    return mapAgentRow(row);
  },

  updateAgentSwitchRegistration(
    agentId: AgentId,
    data: Partial<{
      switchAgentId: string;
      switchApiKey: string;
      switchConnectionId: string;
      switchGeneration: number;
      switchCursor: number;
      switchRoomId: string;
      status: AgentRuntimeState;
      currentTaskId: string | null;
    }>,
  ): AgentRecord {
    const current = this.getAgent(agentId);
    const now = new Date().toISOString();
    getDb()
      .prepare(`
        UPDATE agents SET
          switch_agent_id = ?,
          switch_api_key = ?,
          switch_connection_id = ?,
          switch_generation = ?,
          switch_cursor = ?,
          switch_room_id = ?,
          status = ?,
          current_task_id = ?,
          last_heartbeat_at = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        data.switchAgentId ?? current.switchAgentId,
        data.switchApiKey ?? current.switchApiKey,
        data.switchConnectionId ?? current.switchConnectionId,
        data.switchGeneration ?? current.switchGeneration,
        data.switchCursor ?? current.switchCursor,
        data.switchRoomId ?? current.switchRoomId,
        data.status ?? current.status,
        data.currentTaskId !== undefined ? data.currentTaskId : current.currentTaskId,
        now,
        now,
        agentId,
      );
    return this.getAgent(agentId);
  },

  // --- Workflows ---
  createWorkflow(params: {
    userId: string;
    title: string;
    naturalLanguageRequest: string;
    switchRoomId: string;
    slackChannelId?: string | null;
    slackThreadTs?: string | null;
  }): WorkflowRecord {
    const id = `wf_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    getDb()
      .prepare(`
        INSERT INTO workflows (
          id, user_id, title, natural_language_request, switch_room_id,
          slack_channel_id, slack_thread_ts, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNING', ?, ?)
      `)
      .run(
        id,
        params.userId,
        params.title,
        params.naturalLanguageRequest,
        params.switchRoomId,
        params.slackChannelId ?? null,
        params.slackThreadTs ?? null,
        now,
        now,
      );
    return this.getWorkflow(id)!;
  },

  getWorkflow(workflowId: string): WorkflowRecord | null {
    const row = getDb().prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapWorkflowRow(row) : null;
  },

  listWorkflows(userId?: string): WorkflowRecord[] {
    const rows = (
      userId
        ? getDb()
            .prepare('SELECT * FROM workflows WHERE user_id = ? ORDER BY created_at DESC')
            .all(userId)
        : getDb().prepare('SELECT * FROM workflows ORDER BY created_at DESC').all()
    ) as Record<string, unknown>[];
    return rows.map(mapWorkflowRow);
  },

  updateWorkflowStatus(
    workflowId: string,
    status: WorkflowStatus,
    reportJson?: string | null,
  ): WorkflowRecord {
    const now = new Date().toISOString();
    if (reportJson !== undefined) {
      getDb()
        .prepare('UPDATE workflows SET status = ?, report_json = ?, updated_at = ? WHERE id = ?')
        .run(status, reportJson, now, workflowId);
    } else {
      getDb()
        .prepare('UPDATE workflows SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, workflowId);
    }
    return this.getWorkflow(workflowId)!;
  },

  // --- Agent Tasks ---
  createAgentTask(params: {
    taskId?: string;
    workflowId: string;
    requestingAgent: AgentId;
    assignedAgent: AgentId;
    userId: string;
    taskType: string;
    input: unknown;
    candidateContext: unknown;
    expectedOutput: unknown;
    idempotencyKey?: string;
    maxRetries?: number;
    timeoutMs?: number;
  }): AgentTaskRecord {
    const db = getDb();
    const idempotencyKey =
      params.idempotencyKey ??
      `${params.workflowId}:${params.assignedAgent}:${params.taskType}:${crypto
        .createHash('sha1')
        .update(JSON.stringify(params.input))
        .digest('hex')
        .slice(0, 12)}`;

    const existing = db
      .prepare('SELECT * FROM agent_tasks WHERE idempotency_key = ?')
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      return mapTaskRow(existing);
    }

    const taskId = params.taskId ?? `tsk_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO agent_tasks (
        task_id, workflow_id, requesting_agent, assigned_agent, user_id,
        task_type, input_json, candidate_context_json, expected_output_json,
        status, idempotency_key, retry_count, max_retries, timeout_ms,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', ?, 0, ?, ?, ?, ?)
    `).run(
      taskId,
      params.workflowId,
      params.requestingAgent,
      params.assignedAgent,
      params.userId,
      params.taskType,
      JSON.stringify(params.input),
      JSON.stringify(params.candidateContext),
      JSON.stringify(params.expectedOutput),
      idempotencyKey,
      params.maxRetries ?? 2,
      params.timeoutMs ?? 120000,
      now,
      now,
    );
    return this.getAgentTask(taskId)!;
  },

  getAgentTask(taskId: string): AgentTaskRecord | null {
    const row = getDb().prepare('SELECT * FROM agent_tasks WHERE task_id = ?').get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapTaskRow(row) : null;
  },

  listAgentTasks(filters?: {
    workflowId?: string;
    assignedAgent?: AgentId;
    status?: TaskLifecycleStatus;
  }): AgentTaskRecord[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (filters?.workflowId) {
      clauses.push('workflow_id = ?');
      args.push(filters.workflowId);
    }
    if (filters?.assignedAgent) {
      clauses.push('assigned_agent = ?');
      args.push(filters.assignedAgent);
    }
    if (filters?.status) {
      clauses.push('status = ?');
      args.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = getDb()
      .prepare(`SELECT * FROM agent_tasks ${where} ORDER BY created_at DESC`)
      .all(...args) as Record<string, unknown>[];
    return rows.map(mapTaskRow);
  },

  updateAgentTaskStatus(
    taskId: string,
    status: TaskLifecycleStatus,
    options?: { result?: unknown; errorText?: string | null; incrementRetry?: boolean },
  ): AgentTaskRecord {
    const current = this.getAgentTask(taskId);
    if (!current) throw new Error(`AgentTask not found: ${taskId}`);
    const now = new Date().toISOString();
    const retryCount = options?.incrementRetry ? current.retryCount + 1 : current.retryCount;
    const resultJson =
      options?.result !== undefined ? JSON.stringify(options.result) : current.resultJson;
    const errorText =
      options?.errorText !== undefined ? options.errorText : current.errorText;

    getDb()
      .prepare(`
        UPDATE agent_tasks SET
          status = ?,
          retry_count = ?,
          result_json = ?,
          error_text = ?,
          updated_at = ?
        WHERE task_id = ?
      `)
      .run(status, retryCount, resultJson, errorText, now, taskId);

    return this.getAgentTask(taskId)!;
  },

  // --- Agent Events ---
  logAgentEvent(params: {
    workflowId?: string | null;
    taskId?: string | null;
    agentId: AgentId;
    eventType: string;
    switchSequence?: number | null;
    switchRoomId?: string | null;
    summary: string;
    payload?: unknown;
  }): AgentEventRecord {
    const id = `evt_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    getDb()
      .prepare(`
        INSERT INTO agent_events (
          id, workflow_id, task_id, agent_id, event_type,
          switch_sequence, switch_room_id, summary, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        params.workflowId ?? null,
        params.taskId ?? null,
        params.agentId,
        params.eventType,
        params.switchSequence ?? null,
        params.switchRoomId ?? null,
        params.summary,
        JSON.stringify(params.payload ?? {}),
        now,
      );
    const row = getDb().prepare('SELECT * FROM agent_events WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return mapEventRow(row);
  },

  listAgentEvents(limit = 100, workflowId?: string): AgentEventRecord[] {
    const rows = (
      workflowId
        ? getDb()
            .prepare(
              'SELECT * FROM agent_events WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?',
            )
            .all(workflowId, limit)
        : getDb()
            .prepare('SELECT * FROM agent_events ORDER BY created_at DESC LIMIT ?')
            .all(limit)
    ) as Record<string, unknown>[];
    return rows.map(mapEventRow);
  },

  // --- Approvals ---
  createApproval(params: {
    workflowId: string;
    taskId: string;
    userId: string;
    actionType: ApprovalActionType;
    requestedByAgent: AgentId;
    targetAgent: AgentId;
    title: string;
    summaryText: string;
    payload: unknown;
  }): ApprovalRecord {
    if (params.requestedByAgent === params.targetAgent && params.actionType === 'SEND_EMAIL') {
      // Milo requests approval on behalf of specialist agents, or specialist requests user approval via Milo
    }
    const id = `apr_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    getDb()
      .prepare(`
        INSERT INTO approvals (
          id, workflow_id, task_id, user_id, action_type,
          requested_by_agent, target_agent, title, summary_text,
          payload_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
      `)
      .run(
        id,
        params.workflowId,
        params.taskId,
        params.userId,
        params.actionType,
        params.requestedByAgent,
        params.targetAgent,
        params.title,
        params.summaryText,
        JSON.stringify(params.payload),
        now,
      );
    return this.getApproval(id)!;
  },

  getApproval(approvalId: string): ApprovalRecord | null {
    const row = getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapApprovalRow(row) : null;
  },

  listApprovals(filters?: { userId?: string; status?: ApprovalStatus; workflowId?: string }): ApprovalRecord[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filters?.userId) {
      clauses.push('user_id = ?');
      args.push(filters.userId);
    }
    if (filters?.status) {
      clauses.push('status = ?');
      args.push(filters.status);
    }
    if (filters?.workflowId) {
      clauses.push('workflow_id = ?');
      args.push(filters.workflowId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = getDb()
      .prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC`)
      .all(...args) as Record<string, unknown>[];
    return rows.map(mapApprovalRow);
  },

  decideApproval(params: {
    approvalId: string;
    status: 'APPROVED' | 'REJECTED' | 'EDITED';
    decidedBySlackUserId: string;
    decisionNote?: string | null;
    editedPayload?: unknown;
  }): ApprovalRecord {
    const approval = this.getApproval(params.approvalId);
    if (!approval) throw new Error(`Approval not found: ${params.approvalId}`);
    // Enforce rule: Do not allow an agent to approve its own action
    const agentIds: string[] = ['milo', 'wally', 'inky', 'scout', 'clover', 'pip'];
    if (
      agentIds.includes(params.decidedBySlackUserId.toLowerCase()) ||
      params.decidedBySlackUserId.startsWith('@switch-agent-')
    ) {
      throw new Error('Security Policy Violation: An AI agent cannot approve an external action.');
    }

    const now = new Date().toISOString();
    getDb()
      .prepare(`
        UPDATE approvals SET
          status = ?,
          decided_by_slack_user_id = ?,
          decision_note = ?,
          edited_payload_json = ?,
          decided_at = ?
        WHERE id = ?
      `)
      .run(
        params.status,
        params.decidedBySlackUserId,
        params.decisionNote ?? null,
        params.editedPayload !== undefined
          ? JSON.stringify(params.editedPayload)
          : approval.editedPayloadJson,
        now,
        params.approvalId,
      );
    return this.getApproval(params.approvalId)!;
  },

  // --- Notifications ---
  createNotification(params: {
    userId: string;
    workflowId?: string | null;
    level: NotificationRecord['level'];
    title: string;
    message: string;
  }): NotificationRecord {
    const id = `ntf_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    getDb()
      .prepare(`
        INSERT INTO notifications (id, user_id, workflow_id, level, title, message, is_read, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `)
      .run(id, params.userId, params.workflowId ?? null, params.level, params.title, params.message, now);
    return {
      id,
      userId: params.userId,
      workflowId: params.workflowId ?? null,
      level: params.level,
      title: params.title,
      message: params.message,
      isRead: false,
      createdAt: now,
    };
  },

  listNotifications(userId?: string, limit = 50): NotificationRecord[] {
    const rows = (
      userId
        ? getDb()
            .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(userId, limit)
        : getDb().prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      workflowId: r.workflow_id ? String(r.workflow_id) : null,
      level: r.level as NotificationRecord['level'],
      title: String(r.title),
      message: String(r.message),
      isRead: Boolean(r.is_read),
      createdAt: String(r.created_at),
    }));
  },
};
