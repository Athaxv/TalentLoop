import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/session';
import { localCompanionService } from '@/lib/companion/service';
import { syncCandidateProfileToCrawlJobDisk } from '@/lib/onboarding/profile-sync';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authUser = getAuthenticatedUser(req);
  if (!authUser) {
    return NextResponse.json(
      { ok: false, error: 'Authentication required' },
      { status: 401 },
    );
  }
  const devices = localCompanionService.listDevices(authUser.id);
  return NextResponse.json({ ok: true, devices });
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      return NextResponse.json(
        { ok: false, error: 'Authentication required to manage Local Companion devices.' },
        { status: 401 },
      );
    }

    const body = (await req.json()) as {
      action: 'register' | 'pause' | 'resume' | 'cancel_task' | 'sync_profile';
      deviceId?: string;
      deviceName?: string;
      crawlJobPath?: string;
      taskId?: string;
    };

    if (body.action === 'register') {
      if (!authUser.onboardingCompleted) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Complete candidate onboarding first before registering a Local Companion device.',
          },
          { status: 400 },
        );
      }
      const registered = localCompanionService.registerDevice({
        userId: authUser.id,
        deviceName: body.deviceName,
        crawlJobPath: body.crawlJobPath,
      });
      return NextResponse.json({ ok: true, ...registered });
    }

    if (body.action === 'pause' || body.action === 'resume') {
      if (!body.deviceId) {
        return NextResponse.json(
          { ok: false, error: 'deviceId is required' },
          { status: 400 },
        );
      }
      const updated = localCompanionService.setDeviceStatus(
        body.deviceId,
        body.action === 'pause' ? 'PAUSED' : 'ONLINE',
      );
      return NextResponse.json({ ok: true, device: updated });
    }

    if (body.action === 'cancel_task' && body.taskId) {
      localCompanionService.cancelTask(body.taskId);
      return NextResponse.json({ ok: true, cancelledTaskId: body.taskId });
    }

    if (body.action === 'sync_profile') {
      const synced = syncCandidateProfileToCrawlJobDisk(authUser.id);
      return NextResponse.json({ ok: true, ...synced });
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
