import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { dbRepo, getDb } from '../db';
import type { UserRecord } from '../db/schema';

export const SESSION_COOKIE_NAME = 'tl_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

export function createSessionForUser(userId: string): {
  rawSessionToken: string;
  expiresAt: string;
} {
  const db = getDb();
  const id = `ses_${crypto.randomUUID().slice(0, 12)}`;
  const rawSessionToken = `tls_${crypto.randomBytes(32).toString('hex')}`;
  const tokenHash = crypto
    .createHash('sha256')
    .update(rawSessionToken)
    .digest('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, tokenHash, expiresAt, now.toISOString());

  return { rawSessionToken, expiresAt };
}

export function revokeSessionToken(rawSessionToken: string): void {
  const tokenHash = crypto
    .createHash('sha256')
    .update(rawSessionToken.trim())
    .digest('hex');
  getDb()
    .prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
    .run(tokenHash);
}

export function getUserFromSessionToken(rawSessionToken: string | null | undefined): UserRecord | null {
  if (!rawSessionToken) return null;
  const tokenHash = crypto
    .createHash('sha256')
    .update(rawSessionToken.trim())
    .digest('hex');

  const row = getDb()
    .prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?')
    .get(tokenHash) as { user_id: string; expires_at: string } | undefined;

  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    getDb()
      .prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
      .run(tokenHash);
    return null;
  }

  return dbRepo.getUserById(row.user_id);
}

/**
 * Extracts and validates the authenticated user from a NextRequest (cookie or Bearer header).
 */
export function getAuthenticatedUser(req: NextRequest): UserRecord | null {
  const cookieToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (cookieToken) {
    const user = getUserFromSessionToken(cookieToken);
    if (user) return user;
  }

  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const user = getUserFromSessionToken(token);
    if (user) return user;
  }

  return null;
}

/**
 * Registers a new user account with email, password, full name, and optional Slack ID.
 */
export function registerUserAccount(params: {
  fullName: string;
  email: string;
  password: string;
  slackUserId?: string;
}): { user: UserRecord; rawSessionToken: string; expiresAt: string } {
  const db = getDb();
  const cleanEmail = params.email.trim().toLowerCase();
  const cleanName = params.fullName.trim();

  if (!cleanName || cleanName.length < 2) {
    throw new Error('Full name is required (at least 2 characters).');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Please enter a valid email address.');
  }
  if (!params.password || params.password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const existingByEmail = dbRepo.getUserByEmail(cleanEmail);
  if (existingByEmail) {
    throw new Error('An account with this email already exists. Please sign in.');
  }

  const generatedSlackId =
    params.slackUserId?.trim() ||
    `U_${cleanName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}_${crypto
      .randomBytes(3)
      .toString('hex')
      .toUpperCase()}`;

  const id = `usr_${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  const passwordHash = hashPassword(params.password);

  db.prepare(`
    INSERT INTO users (
      id, slack_user_id, slack_username, switch_participant_id,
      email, full_name, password_hash,
      role_selection, onboarding_stage, onboarding_completed, gmail_connected,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'UNSELECTED', 'WELCOME', 0, 0, ?, ?)
  `).run(
    id,
    generatedSlackId,
    cleanName.toLowerCase().replace(/\s+/g, '.'),
    `@switch-user-${generatedSlackId.toLowerCase()}:talentloop.local`,
    cleanEmail,
    cleanName,
    passwordHash,
    now,
    now,
  );

  const user = dbRepo.getUserById(id)!;
  const session = createSessionForUser(user.id);
  return { user, ...session };
}

/**
 * Authenticates an existing user with email and password.
 */
export function authenticateUserAccount(params: {
  email: string;
  password: string;
}): { user: UserRecord; rawSessionToken: string; expiresAt: string } {
  const user = dbRepo.getUserByEmail(params.email.trim());
  if (!user || !verifyPassword(params.password, user.passwordHash)) {
    throw new Error('Invalid email or password.');
  }
  const session = createSessionForUser(user.id);
  return { user, ...session };
}

/**
 * Creates or signs in a user authenticated via Google OAuth 2.0
 * and stores their Gmail OAuth tokens so @pip is authorized in one step.
 */
export function upsertGoogleAuthenticatedUser(params: {
  email: string;
  fullName: string;
  googleSub?: string;
  accessToken: string;
  refreshToken?: string | null;
}): {
  user: UserRecord;
  rawSessionToken: string;
  expiresAt: string;
  isNewUser: boolean;
} {
  const db = getDb();
  const cleanEmail = params.email.trim().toLowerCase();
  const cleanName = params.fullName.trim() || cleanEmail.split('@')[0];
  const now = new Date().toISOString();

  const existing = dbRepo.getUserByEmail(cleanEmail);
  if (existing) {
    db.prepare(`
      UPDATE users SET
        full_name = COALESCE(full_name, ?),
        gmail_connected = 1,
        gmail_email = ?,
        gmail_access_token = ?,
        gmail_refresh_token = COALESCE(?, gmail_refresh_token),
        updated_at = ?
      WHERE id = ?
    `).run(
      cleanName,
      cleanEmail,
      params.accessToken,
      params.refreshToken ?? null,
      now,
      existing.id,
    );

    const updated = dbRepo.getUserById(existing.id)!;
    const session = createSessionForUser(updated.id);
    return { user: updated, ...session, isNewUser: false };
  }

  const generatedSlackId = `U_${cleanName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8)}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const id = `usr_${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO users (
      id, slack_user_id, slack_username, switch_participant_id,
      email, full_name, role_selection, onboarding_stage,
      onboarding_completed, gmail_connected, gmail_email,
      gmail_access_token, gmail_refresh_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'UNSELECTED', 'WELCOME', 0, 1, ?, ?, ?, ?, ?)
  `).run(
    id,
    generatedSlackId,
    cleanName.toLowerCase().replace(/\s+/g, '.'),
    `@switch-user-${generatedSlackId.toLowerCase()}:talentloop.local`,
    cleanEmail,
    cleanName,
    cleanEmail,
    params.accessToken,
    params.refreshToken ?? null,
    now,
    now,
  );

  const created = dbRepo.getUserById(id)!;
  const session = createSessionForUser(created.id);
  return { user: created, ...session, isNewUser: true };
}
