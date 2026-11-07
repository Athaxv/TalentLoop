import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/outreach/draft
 * Allows the user to customize an individual email draft's subject & body
 * OR apply a custom subject pattern (e.g., "Legal notice: {company}...", "unsolicited tape for {name}") across all pending drafts.
 */
export async function PATCH(req: NextRequest) {
  try {
    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      return NextResponse.json(
        { ok: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const body = (await req.json()) as {
      draftId?: string;
      subject?: string;
      bodyText?: string;
      bulkSubjectTemplate?: string;
    };

    const db = getDb();
    const now = new Date().toISOString();

    if (body.bulkSubjectTemplate?.trim()) {
      const template = body.bulkSubjectTemplate.trim();
      const drafts = db
        .prepare(
          "SELECT id, recipient_name, company_name FROM email_drafts WHERE user_id = ? AND status = 'PENDING_APPROVAL'",
        )
        .all(authUser.id) as Array<{
        id: string;
        recipient_name: string;
        company_name: string;
      }>;

      for (const d of drafts) {
        const firstName = d.recipient_name.split(' ')[0];
        const rendered = template
          .replace(/\{company\}/gi, d.company_name)
          .replace(/\{name\}/gi, firstName)
          .replace(/\{founder\}/gi, d.recipient_name);
        db.prepare(
          'UPDATE email_drafts SET subject = ?, updated_at = ? WHERE id = ?',
        ).run(rendered, now, d.id);
      }

      return NextResponse.json({ ok: true, updatedCount: drafts.length });
    }

    if (!body.draftId) {
      return NextResponse.json(
        { ok: false, error: 'draftId is required' },
        { status: 400 },
      );
    }

    db.prepare(`
      UPDATE email_drafts SET
        subject = COALESCE(?, subject),
        body_text = COALESCE(?, body_text),
        updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      body.subject?.trim() || null,
      body.bodyText?.trim() || null,
      now,
      body.draftId,
      authUser.id,
    );

    return NextResponse.json({ ok: true, draftId: body.draftId });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
