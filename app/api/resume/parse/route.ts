import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/session';
import {
  extractTextFromResumeBuffer,
  parseResumeContent,
} from '@/lib/onboarding/resume-parser';
import { ensureTalentLoopRuntime, miloAgent } from '@/lib/orchestration/runtime';

export const dynamic = 'force-dynamic';

/**
 * POST /api/resume/parse
 * Accepts a multipart/form-data upload containing a `.pdf`, `.txt`, `.md`, or `.json` resume file.
 * Extracts text across all PDF pages + embedded PDF hyperlinks using `unpdf`,
 * parses factual resume fields (`parseResumeContent`), and optionally forwards to @milo.
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      return NextResponse.json(
        { ok: false, error: 'Authentication required to upload and parse resumes.' },
        { status: 401 },
      );
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const autoSubmitToMilo = formData.get('submitToMilo') === 'true';

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: 'No resume file provided in form data.' },
        { status: 400 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const extracted = await extractTextFromResumeBuffer(
      buffer,
      file.name,
      file.type,
    );

    if (!extracted.text || extracted.text.trim().length < 15) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Could not extract sufficient text from this file. Make sure the PDF contains selectable text (not a scanned image without OCR).',
        },
        { status: 400 },
      );
    }

    const parsed = parseResumeContent(extracted.text);

    if (autoSubmitToMilo) {
      await ensureTalentLoopRuntime();
      await miloAgent.handleUserMessage({
        slackUserId: authUser.slackUserId,
        slackUserName: authUser.fullName || 'Candidate',
        text: `Uploaded resume file: ${file.name}`,
        uploadedResumeText: extracted.text,
        attachments: [
          {
            filename: file.name,
            mimetype: file.type || 'application/pdf',
            size: file.size,
            mxc: `mxc://talentloop.local/${encodeURIComponent(file.name)}`,
            msgtype: 'm.file',
          },
        ],
      });
    }

    return NextResponse.json({
      ok: true,
      filename: file.name,
      mimeType: file.type,
      fileSize: file.size,
      pageCount: extracted.pageCount,
      extractedLinks: extracted.extractedLinks,
      extractedText: extracted.text,
      parsed,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Resume extraction failed: ${(err as Error).message}`,
      },
      { status: 500 },
    );
  }
}
