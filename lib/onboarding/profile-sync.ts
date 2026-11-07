import fs from 'node:fs';
import path from 'node:path';
import { dbRepo } from '../db';
import type { CandidateContext } from '../agents/contracts';

/**
 * Formats a user's persisted TalentLoop profile into:
 * 1. The `CandidateContext` contract used across Switch agent tasks.
 * 2. The exact `.crawljob/profile.json` file schema used by `crawlJob` (including `jobPreferences` added in commit 98d59e0).
 */
export function buildCandidateContext(userId: string): CandidateContext | null {
  const bundle = dbRepo.getCandidateFullBundle(userId);
  if (!bundle.profile) return null;

  return {
    userId,
    fullName: bundle.profile.fullName,
    email: bundle.profile.email,
    phone: bundle.profile.phone,
    location: bundle.profile.location,
    experienceLevel: bundle.profile.experienceLevel,
    yearsOfExperience: bundle.profile.yearsOfExperience,
    skills: bundle.skills.map((s) => s.name),
    preferredRoles:
      bundle.profile.preferredRoles.length > 0
        ? bundle.profile.preferredRoles
        : ['Software Engineer', 'Full Stack Developer'],
    preferredLocations:
      bundle.profile.preferredLocations.length > 0
        ? bundle.profile.preferredLocations
        : ['any'],
    preferredJobTypes:
      bundle.profile.preferredJobTypes.length > 0
        ? bundle.profile.preferredJobTypes
        : ['full-time', 'internship'],
    workModePreference: bundle.profile.workModePreference,
    minSalaryText: bundle.profile.minSalaryText,
    links: {
      portfolio: bundle.profile.portfolioUrl,
      github: bundle.profile.githubUrl,
      linkedin: bundle.profile.linkedinUrl,
    },
    experiences: bundle.experiences.map((e) => ({
      company: e.company,
      role: e.role,
      description: e.description,
    })),
    projects: bundle.projects.map((p) => ({
      name: p.name,
      description: p.description,
      techStack: p.techStack,
      repoUrl: p.repoUrl,
    })),
  };
}

export interface CrawlJobProfileJson {
  name: string;
  email: string;
  phone?: string;
  location?: string;
  skills: string[];
  experience: string;
  projects: Array<{ name: string; description: string }>;
  links: Record<string, string>;
  expectedSalary?: string;
  jobPreferences: {
    roles: string[];
    jobTypes: Array<'full-time' | 'internship' | 'part-time' | 'contract' | 'any'>;
    experienceLevel: 'fresher' | 'entry' | 'mid' | 'senior' | 'any';
    yearsOfExperience: number | null;
    locationPreference: string;
  };
}

export function serializeToCrawlJobProfile(userId: string): CrawlJobProfileJson | null {
  const ctx = buildCandidateContext(userId);
  if (!ctx) return null;

  const experienceSummary =
    ctx.experiences.length > 0
      ? ctx.experiences
          .map((e) => `${e.role} at ${e.company}: ${e.description}`)
          .join(' | ')
      : 'Entry-level software engineering candidate with hands-on project experience.';

  const links: Record<string, string> = {};
  if (ctx.links.github) links.github = ctx.links.github;
  if (ctx.links.linkedin) links.linkedin = ctx.links.linkedin;
  if (ctx.links.portfolio) links.portfolio = ctx.links.portfolio;

  const locationPreference =
    ctx.workModePreference === 'remote'
      ? 'remote'
      : ctx.preferredLocations[0] &&
          ctx.preferredLocations[0].toLowerCase() !== 'any'
        ? ctx.preferredLocations[0]
        : 'any';

  return {
    name: ctx.fullName,
    email: ctx.email,
    ...(ctx.phone ? { phone: ctx.phone } : {}),
    ...(ctx.location ? { location: ctx.location } : {}),
    skills: ctx.skills,
    experience: experienceSummary,
    projects: ctx.projects.map((p) => ({
      name: p.name,
      description: p.description,
    })),
    links,
    ...(ctx.minSalaryText ? { expectedSalary: ctx.minSalaryText } : {}),
    jobPreferences: {
      roles: ctx.preferredRoles,
      jobTypes: ctx.preferredJobTypes,
      experienceLevel: ctx.experienceLevel,
      yearsOfExperience: ctx.yearsOfExperience ?? 0,
      locationPreference,
    },
  };
}

/**
 * Syncs the user's verified TalentLoop profile to a local `.crawljob/profile.json` file
 * so `crawlJob`'s `isProfileConfigured()`, `screenJob()`, and `handleRequiredFields()` work seamlessly.
 */
export function syncCandidateProfileToCrawlJobDisk(
  userId: string,
  targetFilePath?: string,
): { filePath: string; profile: CrawlJobProfileJson } {
  const profileData = serializeToCrawlJobProfile(userId);
  if (!profileData) {
    throw new Error(`Cannot sync crawlJob profile: no CandidateProfile found for user ${userId}`);
  }

  const defaultPath =
    process.env.CRAWLJOB_PROFILE_PATH?.trim() ||
    path.resolve(process.cwd(), '.talentloop', 'crawljob-profiles', `${userId}-profile.json`);
  const resolved = targetFilePath ? path.resolve(targetFilePath) : path.resolve(defaultPath);

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(profileData, null, 2)}\n`, 'utf8');

  return { filePath: resolved, profile: profileData };
}
