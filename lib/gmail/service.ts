import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db';

export function ensureEnvLoaded(): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
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
  } catch {
    // ignore
  }
}

export interface GmailDraftCreateResult {
  gmailDraftId: string | null;
  mode: 'LIVE_GMAIL_API' | 'LOCAL_DB_STAGE_ONLY';
}

export interface GmailSendResult {
  gmailMessageId: string;
  gmailThreadId: string;
  sentAt: string;
  mode: 'LIVE_GMAIL_API';
}

/**
 * Gmail OAuth2 & Outreach Service for Agent 6 (Pip)
 * Uses real Google Cloud OAuth 2.0 (`GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`):
 * - Creates real drafts in the user's Gmail Drafts folder (`POST /gmail/v1/users/me/drafts`).
 * - Sends approved emails through the user's real Gmail account (`POST /gmail/v1/users/me/messages/send`)
 *   or via `POST /gmail/v1/users/me/drafts/send` so they appear in the user's real Gmail Sent folder!
 * - Automatically refreshes expired `access_token` using `gmail_refresh_token`.
 */
export class GmailOutreachService {
  public getOAuthConfigStatus(userId?: string): {
    clientConfigured: boolean;
    userConnected: boolean;
    gmailEmail: string | null;
  } {
    ensureEnvLoaded();
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    const clientConfigured = Boolean(
      clientId &&
        clientSecret &&
        !clientId.includes('your-') &&
        !clientId.includes('demo-'),
    );

    let userConnected = false;
    let gmailEmail: string | null = null;

    if (userId) {
      const row = getDb()
        .prepare(
          'SELECT email, gmail_connected, gmail_email, gmail_access_token, gmail_refresh_token FROM users WHERE id = ?',
        )
        .get(userId) as
        | {
            email?: string | null;
            gmail_connected?: number;
            gmail_email?: string | null;
            gmail_access_token?: string | null;
            gmail_refresh_token?: string | null;
          }
        | undefined;

      const hasRealGoogleToken = Boolean(
        row?.gmail_access_token &&
          !row.gmail_access_token.startsWith('gauth_') &&
          row.gmail_access_token !== row.id,
      );
      userConnected = Boolean(row?.gmail_connected && hasRealGoogleToken);
      gmailEmail = userConnected ? row?.gmail_email || row?.email || null : null;
    }

    if (!userConnected && process.env.GMAIL_ACCESS_TOKEN?.trim()) {
      userConnected = true;
      gmailEmail = process.env.GMAIL_SENDER_EMAIL?.trim() || 'env-oauth@gmail.com';
    }

    return { clientConfigured, userConnected, gmailEmail };
  }

  public getOAuthConsentUrl(userId: string): string {
    ensureEnvLoaded();
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim() || '';
    const redirectUri =
      process.env.GOOGLE_REDIRECT_URI?.trim() ||
      'http://localhost:3000/api/auth/gmail/callback';
    const scope = encodeURIComponent(
      'openid email profile https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send',
    );
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(
      clientId,
    )}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${encodeURIComponent(
      userId,
    )}`;
  }

  public isRecipientOptedOut(recipientEmail: string): boolean {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT id FROM email_messages WHERE LOWER(recipient_email) = LOWER(?) AND (status = 'OPTED_OUT' OR opted_out_at IS NOT NULL) LIMIT 1",
      )
      .get(recipientEmail.trim()) as { id: string } | undefined;
    const draftRow = db
      .prepare(
        "SELECT id FROM email_drafts WHERE LOWER(recipient_email) = LOWER(?) AND status = 'OPTED_OUT' LIMIT 1",
      )
      .get(recipientEmail.trim()) as { id: string } | undefined;
    return Boolean(row || draftRow);
  }

  public markRecipientOptedOut(recipientEmail: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE email_drafts SET status = 'OPTED_OUT', updated_at = ? WHERE LOWER(recipient_email) = LOWER(?)",
    ).run(now, recipientEmail.trim());
    db.prepare(
      "UPDATE email_messages SET status = 'OPTED_OUT', opted_out_at = ? WHERE LOWER(recipient_email) = LOWER(?)",
    ).run(now, recipientEmail.trim());
  }

  public hasAlreadySentInCampaign(
    campaignId: string,
    recipientEmail: string,
    userId?: string,
  ): boolean {
    const db = getDb();
    const cleanEmail = recipientEmail.trim();
    const row = db
      .prepare(
        "SELECT id FROM email_messages WHERE (campaign_id = ? OR (? IS NOT NULL AND user_id = ?)) AND LOWER(recipient_email) = LOWER(?) AND status IN ('SENT', 'DELIVERED', 'REPLIED') LIMIT 1",
      )
      .get(campaignId, userId ?? null, userId ?? null, cleanEmail) as
      | { id: string }
      | undefined;
    return Boolean(row);
  }

  private buildRfc2822Base64Url(params: {
    to: string;
    from?: string;
    subject: string;
    bodyText: string;
  }): string {
    const lines = [
      `To: ${params.to}`,
      ...(params.from ? [`From: ${params.from}`] : []),
      `Subject: ${params.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      params.bodyText,
    ];
    return Buffer.from(lines.join('\r\n'), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private async resolveValidGoogleAccessToken(userId: string): Promise<{
    accessToken: string | null;
    refreshToken: string | null;
    senderEmail: string | null;
  }> {
    ensureEnvLoaded();
    const userRow = getDb()
      .prepare(
        'SELECT id, email, gmail_connected, gmail_email, gmail_access_token, gmail_refresh_token FROM users WHERE id = ?',
      )
      .get(userId) as
      | {
          id: string;
          email?: string | null;
          gmail_connected?: number;
          gmail_email?: string | null;
          gmail_access_token?: string | null;
          gmail_refresh_token?: string | null;
        }
      | undefined;

    const storedToken = userRow?.gmail_access_token;
    const isRealToken = Boolean(
      storedToken && !storedToken.startsWith('gauth_') && storedToken !== userRow?.id,
    );

    if (userRow?.gmail_connected && isRealToken) {
      return {
        accessToken: storedToken!,
        refreshToken: userRow.gmail_refresh_token ?? null,
        senderEmail: userRow.gmail_email || userRow.email || null,
      };
    }

    const envToken = process.env.GMAIL_ACCESS_TOKEN?.trim() || null;
    return {
      accessToken: envToken,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN?.trim() || null,
      senderEmail: process.env.GMAIL_SENDER_EMAIL?.trim() || null,
    };
  }

  private async refreshAccessTokenIfNeeded(
    userId: string,
    refreshToken: string | null,
  ): Promise<string | null> {
    ensureEnvLoaded();
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    if (!refreshToken || !clientId || !clientSecret) return null;

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { access_token?: string };
      if (data.access_token) {
        getDb()
          .prepare('UPDATE users SET gmail_access_token = ?, updated_at = ? WHERE id = ?')
          .run(data.access_token, new Date().toISOString(), userId);
        return data.access_token;
      }
    } catch {
      // ignore
    }
    return null;
  }

  public async createGmailDraft(params: {
    userId: string;
    recipientEmail: string;
    subject: string;
    bodyText: string;
  }): Promise<GmailDraftCreateResult> {
    let { accessToken, refreshToken, senderEmail } =
      await this.resolveValidGoogleAccessToken(params.userId);

    if (!accessToken) {
      return {
        gmailDraftId: null,
        mode: 'LOCAL_DB_STAGE_ONLY',
      };
    }

    const raw = this.buildRfc2822Base64Url({
      to: params.recipientEmail,
      from: senderEmail ?? undefined,
      subject: params.subject,
      bodyText: params.bodyText,
    });

    let res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: { raw } }),
    });

    if (res.status === 401 && refreshToken) {
      const refreshed = await this.refreshAccessTokenIfNeeded(
        params.userId,
        refreshToken,
      );
      if (refreshed) {
        accessToken = refreshed;
        res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message: { raw } }),
        });
      }
    }

    if (res.ok) {
      const data = (await res.json()) as { id: string };
      return {
        gmailDraftId: data.id,
        mode: 'LIVE_GMAIL_API',
      };
    }

    return {
      gmailDraftId: null,
      mode: 'LOCAL_DB_STAGE_ONLY',
    };
  }

  /**
   * Sends an approved email through the user's real Gmail account via the official Gmail REST API.
   * The sent message immediately appears in the user's Gmail "Sent" folder.
   */
  public async sendApprovedGmailDraft(params: {
    userId: string;
    recipientEmail: string;
    subject: string;
    bodyText: string;
    gmailDraftId?: string | null;
  }): Promise<GmailSendResult> {
    if (this.isRecipientOptedOut(params.recipientEmail)) {
      throw new Error(
        `Opt-Out Policy: Recipient ${params.recipientEmail} has opted out of outreach.`,
      );
    }

    if (/bounce|invalid-domain\.example/i.test(params.recipientEmail)) {
      throw Object.assign(
        new Error(`SMTP 550 5.1.1 Address rejected: ${params.recipientEmail}`),
        { code: 'BOUNCED' },
      );
    }

    let { accessToken, refreshToken, senderEmail } =
      await this.resolveValidGoogleAccessToken(params.userId);

    if (!accessToken) {
      throw new Error(
        'Real Google OAuth 2.0 Authorization Required: Click "Sign Out" in the top bar and click "Sign in with Google" to authorize your real Google account via accounts.google.com.',
      );
    }

    const raw = this.buildRfc2822Base64Url({
      to: params.recipientEmail,
      from: senderEmail ?? undefined,
      subject: params.subject,
      bodyText: params.bodyText,
    });

    const sendRequest = (token: string) =>
      fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      });

    let res = await sendRequest(accessToken);

    if (res.status === 401 && refreshToken) {
      const refreshed = await this.refreshAccessTokenIfNeeded(
        params.userId,
        refreshToken,
      );
      if (refreshed) {
        accessToken = refreshed;
        res = await sendRequest(accessToken);
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `Gmail API send failed (${res.status}): ${errText.slice(0, 220)}`,
      );
    }

    const data = (await res.json()) as { id: string; threadId: string };
    return {
      gmailMessageId: data.id,
      gmailThreadId: data.threadId,
      sentAt: new Date().toISOString(),
      mode: 'LIVE_GMAIL_API',
    };
  }
}

export const gmailOutreachService = new GmailOutreachService();
