#!/usr/bin/env node
import { dbRepo } from '../lib/db';
import { localCompanionService } from '../lib/companion/service';
import { wallyAgent } from '../lib/agents/wally';
import { inkyAgent } from '../lib/agents/inky';

/**
 * TalentLoop Local Companion CLI Daemon
 * Runs on the user's machine, owns the local `.crawljob/browser-profile-*` session,
 * syncs `.crawljob/profile.json`, and executes approved Wally (Wellfound) and Inky (Internshala) tasks.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'status';

  const users = dbRepo.listUsers();
  const primaryUser = users[0];

  if (cmd === 'register') {
    if (!primaryUser) {
      console.error('No user found in database yet. Complete Slack onboarding with @milo first.');
      process.exit(1);
    }
    const result = localCompanionService.registerDevice({
      userId: primaryUser.id,
      deviceName: args[1] || 'Desktop Playwright Companion',
    });
    console.log('=== TalentLoop Local Companion Registered ===');
    console.log(`Device ID    : ${result.device.id}`);
    console.log(`Device Token : ${result.rawDeviceToken}`);
    console.log(`crawlJob Dir : ${result.device.crawlJobPath}`);
    console.log(`Profile JSON : ${result.device.profilePath}`);
    console.log(`Status       : ${result.device.status}`);
    return;
  }

  if (cmd === 'pause' || cmd === 'resume') {
    const devices = localCompanionService.listDevices(primaryUser?.id);
    if (devices.length === 0) {
      console.error('No registered companion device found.');
      process.exit(1);
    }
    const targetStatus = cmd === 'pause' ? 'PAUSED' : 'ONLINE';
    const updated = localCompanionService.setDeviceStatus(devices[0].id, targetStatus);
    console.log(`Device ${updated.id} status updated to: ${updated.status}`);
    return;
  }

  // Default: status & pending task inspection
  const devices = localCompanionService.listDevices(primaryUser?.id);
  console.log('=== TalentLoop Local Companion Status ===');
  if (devices.length === 0) {
    console.log('No devices registered yet. Run `npx tsx scripts/companion-runner.ts register` after onboarding.');
  } else {
    for (const d of devices) {
      console.log(
        `• ${d.deviceName} (${d.id}) — Status: ${d.status} | Browser Ready: ${d.browserReady} | Profile: ${d.profilePath}`,
      );
    }
  }

  wallyAgent.registerWithSwitch();
  inkyAgent.registerWithSwitch();
}

main().catch((err) => {
  console.error('Companion error:', err);
  process.exit(1);
});
