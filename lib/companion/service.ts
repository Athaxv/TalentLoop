import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDb } from '../db';
import type { DeviceRecord } from '../db/schema';
import { syncCandidateProfileToCrawlJobDisk } from '../onboarding/profile-sync';
import { evaluateCrawlJobScreening } from '../agents/scout';
import type { CandidateContext } from '../agents/contracts';

export interface RegisteredDeviceResult {
  device: DeviceRecord;
  rawDeviceToken: string;
}

export interface CompanionExecutionOptions {
  mode?: 'LIVE_PLAYWRIGHT' | 'TEST_MOCK';
  timeoutMs?: number;
}

const cancelledTaskIds = new Set<string>();

const globalForCompanion = globalThis as unknown as {
  __talentLoopBrowserBusy?: boolean;
};

function mapDeviceRow(row: Record<string, unknown>): DeviceRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    deviceName: String(row.device_name),
    tokenHash: String(row.token_hash),
    tokenPrefix: String(row.token_prefix),
    status: row.status as DeviceRecord['status'],
    crawlJobPath: String(row.crawljob_path),
    profilePath: String(row.profile_path),
    browserReady: Boolean(row.browser_ready),
    activeTaskId: row.active_task_id ? String(row.active_task_id) : null,
    lastHeartbeatAt: row.last_heartbeat_at ? String(row.last_heartbeat_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Local Execution Companion Service
 * Connects to the local `D:\Learning\LLD\smallJobs\crawlJob` repository,
 * syncs `.crawljob/profile.json`, launches the real Playwright persistent browser context,
 * and executes Wellfound and Internshala applications using the user's logged-in browser session.
 * Never fabricates `APPLIED` status without real verification.
 */
export class LocalCompanionService {
  public getCrawlJobRepoPath(): string {
    return (
      process.env.CRAWLJOB_REPO_PATH?.trim() ||
      'D:\\Learning\\LLD\\smallJobs\\crawlJob'
    );
  }

  private loadCrawlJobEnv(): void {
    const repoPath = this.getCrawlJobRepoPath();
    for (const envFile of [
      path.join(repoPath, '.env'),
      path.resolve(process.cwd(), '.env'),
    ]) {
      if (!fs.existsSync(envFile)) continue;
      const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && val) {
          process.env[key] = val;
        }
      }
    }
  }

  private async importCrawlJobModule<T = Record<string, unknown>>(
    relativeDistPath: string,
  ): Promise<T> {
    this.loadCrawlJobEnv();
    const repoPath = this.getCrawlJobRepoPath();
    const fullPath = path.join(repoPath, 'dist', relativeDistPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(
        `crawlJob compiled module not found at ${fullPath}. Run "bun run build" in ${repoPath}.`,
      );
    }
    const fileUrl = pathToFileURL(fullPath).href;
    return (await import(/* webpackIgnore: true */ fileUrl)) as T;
  }

  public registerDevice(params: {
    userId: string;
    deviceName?: string;
    crawlJobPath?: string;
  }): RegisteredDeviceResult {
    const db = getDb();
    const id = `dev_${crypto.randomUUID().slice(0, 10)}`;
    const rawToken = `tl_dev_${crypto.randomBytes(20).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const tokenPrefix = rawToken.slice(0, 14);
    const now = new Date().toISOString();

    const crawlJobPath = params.crawlJobPath || this.getCrawlJobRepoPath();
    const targetProfilePath = path.join(crawlJobPath, '.crawljob', 'profile.json');
    const synced = syncCandidateProfileToCrawlJobDisk(params.userId, targetProfilePath);
    const crawlJobExists = fs.existsSync(path.join(crawlJobPath, 'dist', 'browser.js'));

    db.prepare(`
      INSERT INTO devices (
        id, user_id, device_name, token_hash, token_prefix,
        status, crawljob_path, profile_path, browser_ready,
        last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'ONLINE', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.userId,
      params.deviceName || 'Local Desktop Companion (Playwright + crawlJob)',
      tokenHash,
      tokenPrefix,
      crawlJobPath,
      synced.filePath,
      crawlJobExists ? 1 : 0,
      now,
      now,
      now,
    );

    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return {
      device: mapDeviceRow(row),
      rawDeviceToken: rawToken,
    };
  }

  public authenticateDevice(rawToken: string): DeviceRecord | null {
    const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
    const row = getDb()
      .prepare('SELECT * FROM devices WHERE token_hash = ?')
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    getDb()
      .prepare('UPDATE devices SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, String(row.id));
    return mapDeviceRow({ ...row, last_heartbeat_at: now, updated_at: now });
  }

  public getOrEnsureUserDevice(userId: string): DeviceRecord {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(userId) as Record<string, unknown> | undefined;
    if (existing) {
      return mapDeviceRow(existing);
    }
    return this.registerDevice({ userId }).device;
  }

  public listDevices(userId?: string): DeviceRecord[] {
    const rows = (
      userId
        ? getDb()
            .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC')
            .all(userId)
        : getDb().prepare('SELECT * FROM devices ORDER BY created_at DESC').all()
    ) as Record<string, unknown>[];
    return rows.map(mapDeviceRow);
  }

  public setDeviceStatus(
    deviceId: string,
    status: 'ONLINE' | 'PAUSED' | 'OFFLINE',
  ): DeviceRecord {
    const now = new Date().toISOString();
    getDb()
      .prepare('UPDATE devices SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, deviceId);
    const row = getDb().prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Device not found: ${deviceId}`);
    return mapDeviceRow(row);
  }

  public cancelTask(taskId: string): void {
    cancelledTaskIds.add(taskId);
  }

  public isTaskCancelled(taskId: string): boolean {
    return cancelledTaskIds.has(taskId);
  }

  public writeCrawlJobAuditEntry(profileFilePath: string, entry: Record<string, unknown>): string {
    const auditFile = profileFilePath.replace(/profile\.json$/i, 'application-audit.jsonl');
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(
      auditFile,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      'utf8',
    );
    return auditFile;
  }

  private isTestMockMode(options?: CompanionExecutionOptions): boolean {
    return (
      options?.mode === 'TEST_MOCK' ||
      process.env.TALENTLOOP_TEST_MOCK_BROWSER === '1'
    );
  }

  /**
   * Executes a batch of approved Wellfound applications.
   * In live mode, launches the actual Playwright persistent browser from `crawlJob` (`dist/browser.js`)
   * and executes `dist/wellfound/wellfound.js` + `dist/wellfound/application.js`.
   */
  public async executeWellfoundBatch(params: {
    userId: string;
    taskId: string;
    candidateContext: CandidateContext;
    jobs: Array<{
      jobId: string;
      title: string;
      company: string;
      applicationUrl: string;
    }>;
    options?: CompanionExecutionOptions;
  }): Promise<
    Array<{
      jobId: string;
      applicationUrl: string;
      company: string;
      role: string;
      crawlJobResult:
        | 'applied'
        | 'already_applied'
        | 'skipped_external'
        | 'skipped_mandatory_fields'
        | 'skipped_captcha'
        | 'skipped_no_apply_button'
        | 'skipped_rate_limited'
        | 'skipped_ineligible'
        | 'skipped_error';
      status: 'APPLIED' | 'ALREADY_APPLIED' | 'SKIPPED' | 'FAILED';
      verified: boolean;
      reason: string | null;
      screenshotPath: string | null;
    }>
  > {
    const device = this.getOrEnsureUserDevice(params.userId);
    if (device.status === 'PAUSED') {
      throw new Error(
        `Local Companion device (${device.id}) is currently PAUSED by the user. Resume the device to run Wellfound applications.`,
      );
    }

    const synced = syncCandidateProfileToCrawlJobDisk(params.userId, device.profilePath);
    process.env.CRAWLJOB_PROFILE_PATH = synced.filePath;

    const db = getDb();
    const outcomes: Awaited<ReturnType<LocalCompanionService['executeWellfoundBatch']>> = [];

    // Unit test mock mode (used only when TALENTLOOP_TEST_MOCK_BROWSER=1 in automated test scripts)
    if (this.isTestMockMode(params.options)) {
      for (const item of params.jobs) {
        const existingApp = db
          .prepare(
            "SELECT status, verified_submission FROM applications WHERE user_id = ? AND job_id = ? AND status = 'APPLIED' AND verified_submission = 1",
          )
          .get(params.userId, item.jobId) as Record<string, unknown> | undefined;

        if (existingApp) {
          outcomes.push({
            jobId: item.jobId,
            applicationUrl: item.applicationUrl,
            company: item.company,
            role: item.title,
            crawlJobResult: 'already_applied',
            status: 'ALREADY_APPLIED',
            verified: false,
            reason: 'Already applied and verified in TalentLoop history.',
            screenshotPath: null,
          });
          continue;
        }

        this.writeCrawlJobAuditEntry(synced.filePath, {
          mode: 'test-mock',
          result: 'filled',
          context: { jobUrl: item.applicationUrl, company: item.company, role: item.title, platform: 'Wellfound' },
        });

        outcomes.push({
          jobId: item.jobId,
          applicationUrl: item.applicationUrl,
          company: item.company,
          role: item.title,
          crawlJobResult: 'applied',
          status: 'APPLIED',
          verified: true,
          reason: 'Verified (automated test runner mode).',
          screenshotPath: null,
        });
      }
      return outcomes;
    }

    if (globalForCompanion.__talentLoopBrowserBusy) {
      throw new Error(
        'Local Playwright browser is already running an application task. Wait for the active browser window to finish before starting another run.',
      );
    }

    globalForCompanion.__talentLoopBrowserBusy = true;

    // LIVE PLAYWRIGHT EXECUTION via D:\Learning\LLD\smallJobs\crawlJob
    const browserMod = await this.importCrawlJobModule<{
      launchBrowser: () => Promise<any>;
      getActivePage: (ctx: any) => Promise<any>;
      openFirstPage: (
        ctx: any,
        url: string,
        opts?: { skipIfHostIncludes?: string },
      ) => Promise<any>;
      closeBrowser: (ctx: any) => Promise<void>;
    }>('browser.js');

    const wfMod = await this.importCrawlJobModule<{
      getJobListings: (page: any) => Promise<string[]>;
      getJobMeta: (page: any) => Promise<{ company: string; role: string }>;
      openJob: (page: any, url: string) => Promise<string>;
      isAlreadyApplied: (page: any) => Promise<boolean>;
      findApplyButton: (page: any) => Promise<any>;
    }>('wellfound/wellfound.js');

    const wfAppMod = await this.importCrawlJobModule<{
      openApplication: (page: any, ctx: any, btn: any) => Promise<any>;
      hasCaptcha: (modal: any) => Promise<boolean>;
      isExternalApplication: (modal: any) => Promise<boolean>;
      hasMandatoryAdditionalFields: (modal: any) => Promise<boolean>;
      hasApplicationLimitError: (modal: any) => Promise<boolean>;
      submitApplication: (page: any, modal: any) => Promise<boolean>;
      verifyApplication: (page: any) => Promise<boolean>;
      dismissModal: (page: any, modal: any) => Promise<void>;
    }>('wellfound/application.js');

    const agentMod = await this.importCrawlJobModule<{
      handleRequiredFields: (
        scope: any,
        context: Record<string, string>,
      ) => Promise<'filled' | 'review_required' | 'blocked'>;
    }>('application-agent/index.js');

    const screenMod = await this.importCrawlJobModule<{
      screenJob: (
        title: string,
        description: string,
        listingType?: string,
      ) => { eligible: boolean; reason: string };
    }>('job-screening.js');

    let context: any = null;
    try {
      context = await browserMod.launchBrowser();
      let page = await browserMod.getActivePage(context);

      // If @wally was invoked directly (e.g. "@wally apply to wellfound jobs") without pre-seeded URLs,
      // open Wellfound in the user's persistent browser session and collect listings via crawlJob's getJobListings(page)!
      let jobsToProcess = [...params.jobs];
      if (jobsToProcess.length === 0) {
        page = await browserMod.openFirstPage(context, 'https://wellfound.com/jobs', {
          skipIfHostIncludes: 'wellfound.com',
        });
        const scrapedUrls = await wfMod.getJobListings(page);
        const now = new Date().toISOString();

        for (const url of scrapedUrls.slice(0, 15)) {
          const existing = db
            .prepare('SELECT id, title, company_name FROM jobs WHERE application_url = ?')
            .get(url) as
            | { id: string; title: string; company_name: string }
            | undefined;

          if (existing) {
            jobsToProcess.push({
              jobId: existing.id,
              title: existing.title,
              company: existing.company_name,
              applicationUrl: url,
            });
          } else {
            const jobId = `job_${crypto.randomUUID().slice(0, 10)}`;
            const slug = new URL(url).pathname.split('/').pop() ?? 'wellfound-role';
            db.prepare(`
              INSERT OR IGNORE INTO jobs (
                id, company_name, title, location, work_mode, employment_type,
                required_skills_json, description, application_url, source_url,
                platform, is_verified_current, dedup_fingerprint, discovered_at
              ) VALUES (?, 'Wellfound Startup', ?, 'Remote', 'remote', 'full-time', '[]', 'Discovered via live Wellfound browser session', ?, 'https://wellfound.com/jobs', 'wellfound', 1, ?, ?)
            `).run(jobId, slug, url, `wf_${slug}_${Date.now()}`, now);

            jobsToProcess.push({
              jobId,
              title: slug,
              company: 'Wellfound Startup',
              applicationUrl: url,
            });
          }
        }
      }

      if (jobsToProcess.length === 0) {
        return [
          {
            jobId: `job_wf_none_${Date.now()}`,
            applicationUrl: 'https://wellfound.com/jobs',
            company: 'Wellfound',
            role: 'Wellfound Filtered Listings',
            crawlJobResult: 'skipped_no_apply_button',
            status: 'SKIPPED',
            verified: false,
            reason:
              'No Wellfound job listings were found on the current browser page. Please log in to Wellfound in the opened browser window and navigate to https://wellfound.com/jobs, then run `@wally apply` again.',
            screenshotPath: null,
          },
        ];
      }

      for (const item of jobsToProcess) {
        if (this.isTaskCancelled(params.taskId)) {
          outcomes.push({
            jobId: item.jobId,
            applicationUrl: item.applicationUrl,
            company: item.company,
            role: item.title,
            crawlJobResult: 'skipped_error',
            status: 'SKIPPED',
            verified: false,
            reason: 'Cancelled by user.',
            screenshotPath: null,
          });
          continue;
        }

        const existingApp = db
          .prepare(
            "SELECT status, verified_submission FROM applications WHERE user_id = ? AND job_id = ? AND status = 'APPLIED' AND verified_submission = 1",
          )
          .get(params.userId, item.jobId) as Record<string, unknown> | undefined;

        if (existingApp) {
          outcomes.push({
            jobId: item.jobId,
            applicationUrl: item.applicationUrl,
            company: item.company,
            role: item.title,
            crawlJobResult: 'already_applied',
            status: 'ALREADY_APPLIED',
            verified: false,
            reason: 'Already applied in TalentLoop database.',
            screenshotPath: null,
          });
          continue;
        }

        try {
          await wfMod.openJob(page, item.applicationUrl);

          // Extract real Company & Role title from the opened Wellfound job page (matching src/wellfound/index.ts)
          const meta = await wfMod.getJobMeta(page);
          const resolvedCompany =
            meta.company && meta.company !== 'Unknown Company'
              ? meta.company
              : item.company;
          const resolvedRole =
            meta.role && meta.role !== 'Unknown Role' ? meta.role : item.title;

          db.prepare('UPDATE jobs SET company_name = ?, title = ? WHERE id = ?').run(
            resolvedCompany,
            resolvedRole,
            item.jobId,
          );

          // Run crawlJob's screenJob(meta.role, description) before touching Apply!
          const description = await page
            .locator('main, [role="main"]')
            .first()
            .innerText()
            .catch(() => '');
          const screening = screenMod.screenJob(resolvedRole, description);
          if (!screening.eligible) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: resolvedCompany,
              role: resolvedRole,
              crawlJobResult: 'skipped_ineligible',
              status: 'SKIPPED',
              verified: false,
              reason: `Profile filter: ${screening.reason}`,
              screenshotPath: null,
            });
            continue;
          }

          if (await wfMod.isAlreadyApplied(page)) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: resolvedCompany,
              role: resolvedRole,
              crawlJobResult: 'already_applied',
              status: 'ALREADY_APPLIED',
              verified: false,
              reason: 'Already applied on Wellfound page.',
              screenshotPath: null,
            });
            continue;
          }

          const applyBtn = await wfMod.findApplyButton(page);
          if (!applyBtn) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: resolvedCompany,
              role: resolvedRole,
              crawlJobResult: 'skipped_no_apply_button',
              status: 'SKIPPED',
              verified: false,
              reason: 'No Apply button found on page.',
              screenshotPath: null,
            });
            continue;
          }

          const modal = await wfAppMod.openApplication(page, context, applyBtn);
          if (!modal) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: resolvedCompany,
              role: resolvedRole,
              crawlJobResult: 'skipped_external',
              status: 'SKIPPED',
              verified: false,
              reason: 'External application or no Wellfound modal detected.',
              screenshotPath: null,
            });
            continue;
          }

          if (await wfAppMod.hasCaptcha(modal)) {
            await wfAppMod.dismissModal(page, modal);
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: resolvedCompany,
              role: resolvedRole,
              crawlJobResult: 'skipped_captcha',
              status: 'SKIPPED',
              verified: false,
              reason: 'CAPTCHA detected — skipped safely.',
              screenshotPath: null,
            });
            continue;
          }

          if (await wfAppMod.isExternalApplication(modal)) {
            await wfAppMod.dismissModal(page, modal);
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: resolvedCompany,
              role: resolvedRole,
              crawlJobResult: 'skipped_external',
              status: 'SKIPPED',
              verified: false,
              reason: 'External application link inside modal.',
              screenshotPath: null,
            });
            continue;
          }

          if (await wfAppMod.hasMandatoryAdditionalFields(modal)) {
            const agentRes = await agentMod.handleRequiredFields(modal, {
              jobUrl: item.applicationUrl,
              company: resolvedCompany,
              role: resolvedRole,
              platform: 'Wellfound',
            });
            if (agentRes !== 'filled') {
              await wfAppMod.dismissModal(page, modal);
              outcomes.push({
                jobId: item.jobId,
                applicationUrl: item.applicationUrl,
                company: resolvedCompany,
                role: resolvedRole,
                crawlJobResult: 'skipped_mandatory_fields',
                status: 'SKIPPED',
                verified: false,
                reason:
                  agentRes === 'review_required'
                    ? 'Required fields drafted in review mode — requires manual review.'
                    : 'Mandatory custom fields could not be safely filled.',
                screenshotPath: null,
              });
              continue;
            }
          }

          if (await wfAppMod.hasApplicationLimitError(modal)) {
            await wfAppMod.dismissModal(page, modal);
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: resolvedCompany,
              role: resolvedRole,
              crawlJobResult: 'skipped_rate_limited',
              status: 'SKIPPED',
              verified: false,
              reason: 'Wellfound active application limit reached.',
              screenshotPath: null,
            });
            break;
          }

          const submitted = await wfAppMod.submitApplication(page, modal);
          if (!submitted) {
            await wfAppMod.dismissModal(page, modal).catch(() => undefined);
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: resolvedCompany,
              role: resolvedRole,
              crawlJobResult: 'skipped_error',
              status: 'SKIPPED',
              verified: false,
              reason: 'Submit button did not complete modal submission.',
              screenshotPath: null,
            });
            continue;
          }

          // Match crawlJob's src/wellfound/index.ts lines 146-154:
          // submitApplication() already confirmed the modal closed / success indicator appeared.
          const badgeVerified = await wfAppMod.verifyApplication(page);
          outcomes.push({
            jobId: item.jobId,
            applicationUrl: item.applicationUrl,
            company: resolvedCompany,
            role: resolvedRole,
            crawlJobResult: 'applied',
            status: 'APPLIED',
            verified: true,
            reason: badgeVerified
              ? 'Application submitted and Applied badge verified on page.'
              : 'Application submitted (ReactModal confirmed closed after Submit).',
            screenshotPath: null,
          });

          await new Promise((r) => setTimeout(r, 1500));
        } catch (jobErr) {
          outcomes.push({
            jobId: item.jobId,
            applicationUrl: item.applicationUrl,
            company: item.company,
            role: item.title,
            crawlJobResult: 'skipped_error',
            status: 'FAILED',
            verified: false,
            reason: (jobErr as Error).message,
            screenshotPath: null,
          });
        }
      }
    } finally {
      globalForCompanion.__talentLoopBrowserBusy = false;
      if (context) {
        await browserMod.closeBrowser(context).catch(() => undefined);
      }
    }

    return outcomes;
  }

  /**
   * Executes a batch of approved Internshala applications.
   * In live mode, launches the actual Playwright persistent browser from `crawlJob` (`dist/browser.js`)
   * and executes `dist/internshala/jobs.js` + `dist/internshala/selectors.js` + `dist/application-agent/index.js`.
   */
  public async executeInternshalaBatch(params: {
    userId: string;
    taskId: string;
    candidateContext: CandidateContext;
    mode: 'internships' | 'jobs' | 'both';
    listings: Array<{
      jobId: string;
      title: string;
      company: string;
      applicationUrl: string;
      category: 'internship' | 'job';
    }>;
    options?: CompanionExecutionOptions;
  }): Promise<
    Array<{
      jobId: string;
      applicationUrl: string;
      company: string;
      role: string;
      category: 'internship' | 'job';
      crawlJobResult:
        | 'applied'
        | 'alreadyApplied'
        | 'skippedQuestions'
        | 'skippedProfile'
        | 'skippedCaptcha'
        | 'skippedExternal'
        | 'skippedError';
      status: 'APPLIED' | 'ALREADY_APPLIED' | 'SKIPPED' | 'FAILED';
      verified: boolean;
      reason: string | null;
      screenshotPath: string | null;
    }>
  > {
    const device = this.getOrEnsureUserDevice(params.userId);
    if (device.status === 'PAUSED') {
      throw new Error(
        `Local Companion device (${device.id}) is currently PAUSED by the user. Resume the device to run Internshala applications.`,
      );
    }

    const synced = syncCandidateProfileToCrawlJobDisk(params.userId, device.profilePath);
    process.env.CRAWLJOB_PROFILE_PATH = synced.filePath;

    const db = getDb();
    const outcomes: Awaited<ReturnType<LocalCompanionService['executeInternshalaBatch']>> = [];

    // Unit test mock mode (used only when TALENTLOOP_TEST_MOCK_BROWSER=1 in automated test scripts)
    if (this.isTestMockMode(params.options)) {
      for (const item of params.listings) {
        const existingApp = db
          .prepare(
            "SELECT status, verified_submission FROM applications WHERE user_id = ? AND job_id = ? AND status = 'APPLIED' AND verified_submission = 1",
          )
          .get(params.userId, item.jobId) as Record<string, unknown> | undefined;

        if (existingApp) {
          outcomes.push({
            jobId: item.jobId,
            applicationUrl: item.applicationUrl,
            company: item.company,
            role: item.title,
            category: item.category,
            crawlJobResult: 'alreadyApplied',
            status: 'ALREADY_APPLIED',
            verified: false,
            reason: 'Already applied and verified in TalentLoop history.',
            screenshotPath: null,
          });
          continue;
        }

        this.writeCrawlJobAuditEntry(synced.filePath, {
          mode: 'test-mock',
          result: 'filled',
          context: { url: item.applicationUrl, listing: `${item.title} — ${item.company}`, platform: 'Internshala' },
        });

        outcomes.push({
          jobId: item.jobId,
          applicationUrl: item.applicationUrl,
          company: item.company,
          role: item.title,
          category: item.category,
          crawlJobResult: 'applied',
          status: 'APPLIED',
          verified: true,
          reason: 'Verified (automated test runner mode).',
          screenshotPath: null,
        });
      }
      return outcomes;
    }

    if (globalForCompanion.__talentLoopBrowserBusy) {
      throw new Error(
        'Local Playwright browser is already running an application task. Wait for the active browser window to finish before starting another run.',
      );
    }

    globalForCompanion.__talentLoopBrowserBusy = true;

    // LIVE PLAYWRIGHT EXECUTION via D:\Learning\LLD\smallJobs\crawlJob
    const browserMod = await this.importCrawlJobModule<{
      launchBrowser: () => Promise<any>;
      getActivePage: (ctx: any) => Promise<any>;
      closeBrowser: (ctx: any) => Promise<void>;
    }>('browser.js');

    const isJobsMod = await this.importCrawlJobModule<{
      isAlreadyApplied: (page: any) => Promise<boolean>;
      isVisible: (loc: any) => Promise<boolean>;
      continueFromResume: (page: any) => Promise<boolean>;
    }>('internshala/jobs.js');

    const isSelMod = await this.importCrawlJobModule<{
      IS: {
        applyButton: string;
        submitButton: string;
        success: string;
        resumeHeading: string;
        captcha: string;
      };
      INTERNSHALA_DOMAIN_RE: RegExp;
    }>('internshala/selectors.js');

    const agentMod = await this.importCrawlJobModule<{
      handleRequiredFields: (
        scope: any,
        context: Record<string, string>,
      ) => Promise<'filled' | 'review_required' | 'blocked'>;
    }>('application-agent/index.js');

    let context: any = null;
    try {
      context = await browserMod.launchBrowser();
      const page = await browserMod.getActivePage(context);

      for (const item of params.listings) {
        if (this.isTaskCancelled(params.taskId)) {
          outcomes.push({
            jobId: item.jobId,
            applicationUrl: item.applicationUrl,
            company: item.company,
            role: item.title,
            category: item.category,
            crawlJobResult: 'skippedError',
            status: 'SKIPPED',
            verified: false,
            reason: 'Cancelled by user.',
            screenshotPath: null,
          });
          continue;
        }

        const existingApp = db
          .prepare(
            "SELECT status, verified_submission FROM applications WHERE user_id = ? AND job_id = ? AND status = 'APPLIED' AND verified_submission = 1",
          )
          .get(params.userId, item.jobId) as Record<string, unknown> | undefined;

        if (existingApp) {
          outcomes.push({
            jobId: item.jobId,
            applicationUrl: item.applicationUrl,
            company: item.company,
            role: item.title,
            category: item.category,
            crawlJobResult: 'alreadyApplied',
            status: 'ALREADY_APPLIED',
            verified: false,
            reason: 'Already applied in TalentLoop database.',
            screenshotPath: null,
          });
          continue;
        }

        try {
          await page.goto(item.applicationUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
          await page.waitForTimeout(800);

          if (await isJobsMod.isAlreadyApplied(page)) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'alreadyApplied',
              status: 'ALREADY_APPLIED',
              verified: false,
              reason: 'Already applied on Internshala page.',
              screenshotPath: null,
            });
            continue;
          }

          if (await isJobsMod.isVisible(page.locator(isSelMod.IS.captcha))) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'skippedCaptcha',
              status: 'SKIPPED',
              verified: false,
              reason: 'CAPTCHA detected on Internshala page.',
              screenshotPath: null,
            });
            continue;
          }

          const apply = page.locator(isSelMod.IS.applyButton).first();
          if (!(await isJobsMod.isVisible(apply))) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'skippedError',
              status: 'SKIPPED',
              verified: false,
              reason: 'No Apply Now button found on page.',
              screenshotPath: null,
            });
            continue;
          }

          await apply.click();
          await page.waitForTimeout(1200);

          // Check if Internshala opened a login modal or redirected to /login
          const loginModalOrUrl =
            page.url().includes('/login') ||
            (await page
              .locator('#login-modal, form#modal-login-form, input#modal_email')
              .first()
              .isVisible()
              .catch(() => false));

          if (loginModalOrUrl) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'skippedError',
              status: 'SKIPPED',
              verified: false,
              reason:
                'Internshala login required in local crawlJob browser profile (.crawljob/browser-profile-*). Log in once via `crawlJob run --site internshala` to authorize your session.',
              screenshotPath: null,
            });
            continue;
          }

          if (!isSelMod.INTERNSHALA_DOMAIN_RE.test(new URL(page.url()).hostname)) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'skippedExternal',
              status: 'SKIPPED',
              verified: false,
              reason: 'External application outside internshala.com.',
              screenshotPath: null,
            });
            continue;
          }

          if (await isJobsMod.isVisible(page.locator(isSelMod.IS.success))) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'applied',
              status: 'APPLIED',
              verified: true,
              reason: 'Verified via IS.success confirmation in local Playwright browser.',
              screenshotPath: null,
            });
            continue;
          }

          if (await isJobsMod.isVisible(page.locator(isSelMod.IS.resumeHeading))) {
            const continued = await isJobsMod.continueFromResume(page);
            if (!continued) {
              outcomes.push({
                jobId: item.jobId,
                applicationUrl: item.applicationUrl,
                company: item.company,
                role: item.title,
                category: item.category,
                crawlJobResult: 'skippedError',
                status: 'SKIPPED',
                verified: false,
                reason: 'Internshala resume continuation step required manual review.',
                screenshotPath: null,
              });
              continue;
            }
            if (await isJobsMod.isVisible(page.locator(isSelMod.IS.success))) {
              outcomes.push({
                jobId: item.jobId,
                applicationUrl: item.applicationUrl,
                company: item.company,
                role: item.title,
                category: item.category,
                crawlJobResult: 'applied',
                status: 'APPLIED',
                verified: true,
                reason: 'Verified via IS.success right after resume continuation.',
                screenshotPath: null,
              });
              continue;
            }
          }

          const agentRes = await agentMod.handleRequiredFields(page.locator('body'), {
            url: item.applicationUrl,
            listing: `${item.title} — ${item.company}`,
            company: item.company,
            role: item.title,
            platform: 'Internshala',
          });

          if (agentRes !== 'filled') {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'skippedQuestions',
              status: 'SKIPPED',
              verified: false,
              reason:
                agentRes === 'review_required'
                  ? 'Required questions drafted in review mode — requires manual review.'
                  : 'Required custom application question could not be safely filled.',
              screenshotPath: null,
            });
            continue;
          }

          const submit = page.locator(isSelMod.IS.submitButton).first();
          if (!(await isJobsMod.isVisible(submit))) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'skippedError',
              status: 'SKIPPED',
              verified: false,
              reason: 'No safe Submit Application button visible (login or custom form required).',
              screenshotPath: null,
            });
            continue;
          }

          await submit.click();
          const confirmed = await Promise.race([
            page
              .locator(isSelMod.IS.success)
              .first()
              .waitFor({ state: 'visible', timeout: 10000 })
              .then(() => true)
              .catch(() => false),
            (async () => {
              await page.waitForTimeout(3000);
              return (
                (await isJobsMod.isAlreadyApplied(page)) ||
                /student\/dashboard|application.*submitted|thank/i.test(page.url())
              );
            })(),
          ]);

          if (confirmed) {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'applied',
              status: 'APPLIED',
              verified: true,
              reason: 'Verified via IS.success confirmation in local Playwright browser.',
              screenshotPath: null,
            });
          } else {
            outcomes.push({
              jobId: item.jobId,
              applicationUrl: item.applicationUrl,
              company: item.company,
              role: item.title,
              category: item.category,
              crawlJobResult: 'skippedError',
              status: 'SKIPPED',
              verified: false,
              reason: 'Submission was not confirmed by IS.success selector.',
              screenshotPath: null,
            });
          }
        } catch (err) {
          outcomes.push({
            jobId: item.jobId,
            applicationUrl: item.applicationUrl,
            company: item.company,
            role: item.title,
            category: item.category,
            crawlJobResult: 'skippedError',
            status: 'FAILED',
            verified: false,
            reason: (err as Error).message,
            screenshotPath: null,
          });
        }
      }
    } finally {
      globalForCompanion.__talentLoopBrowserBusy = false;
      if (context) {
        await browserMod.closeBrowser(context).catch(() => undefined);
      }
    }

    return outcomes;
  }
}

export const localCompanionService = new LocalCompanionService();
