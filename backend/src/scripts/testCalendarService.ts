import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import {
  hasCalendarCredentials,
  getClinicCalendarId,
  checkSlotAvailable,
  createCalendarEvent,
  cancelCalendarEvent,
} from '../services/googleCalendarService';

const CLINIC_ID = '78de52b5-3895-4824-b970-2676eb668293';

function pass(msg: string) { console.log(`  PASS  ${msg}`); }
function fail(msg: string) { console.error(`  FAIL  ${msg}`); process.exitCode = 1; }
function info(msg: string) { console.log(`  INFO  ${msg}`); }

async function run() {
  console.log('\n=== Google Calendar Service Diagnostics ===\n');

  // ── Phase 1: Environment checks ─────────────────────────────────────────
  console.log('--- Phase 1: Environment ---');

  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credsPath) {
    pass(`GOOGLE_APPLICATION_CREDENTIALS is set: ${credsPath}`);
  } else {
    fail('GOOGLE_APPLICATION_CREDENTIALS is not set in .env');
  }

  if (credsPath) {
    const resolved = path.resolve(credsPath);
    if (fs.existsSync(resolved)) {
      pass(`Service account file exists: ${resolved}`);
      try {
        const sa = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as Record<string, unknown>;
        pass(`Service account type: ${sa.type ?? 'unknown'}`);
        info(`Client email: ${sa.client_email ?? 'not found'}`);
        info(`Project:      ${sa.project_id ?? 'not found'}`);
      } catch (e: unknown) {
        fail(`Could not parse service account JSON: ${(e as Error).message}`);
      }
    } else {
      fail(`Service account file NOT found at: ${resolved}`);
    }
  }

  if (hasCalendarCredentials()) {
    pass('hasCalendarCredentials() = true');
  } else {
    fail('hasCalendarCredentials() = false');
  }

  // ── Phase 2: Database — calendar ID lookup ───────────────────────────────
  console.log('\n--- Phase 2: Calendar ID in DB ---');

  let calendarId: string | null = null;
  try {
    calendarId = await getClinicCalendarId(CLINIC_ID);
    pass(`google_calendar_id = "${calendarId}"`);
    info('Make sure the service account has been shared on this calendar as Editor.');
  } catch (e: unknown) {
    fail(`getClinicCalendarId failed: ${(e as Error).message}`);
    info('Fix: go to Google Calendar → Settings → Share with specific people → add the service account client_email with "Make changes to events" permission.');
  }

  // ── Phase 3: checkSlotAvailable (live API call) ──────────────────────────
  console.log('\n--- Phase 3: checkSlotAvailable (live Google API) ---');

  if (calendarId) {
    console.log('  Calling checkSlotAvailable...');
    const available = await checkSlotAvailable(CLINIC_ID, {
      date: '2026-06-01',
      time: '10:00',
      durationMinutes: 30,
    });
    // checkSlotAvailable never throws — it logs warn and returns true if any error
    pass(`checkSlotAvailable returned: ${available}`);
    info(
      available
        ? 'Slot is available (or calendar returned no busy blocks — also happens if service account lacks read access)'
        : 'Slot is busy',
    );
  } else {
    info('Skipping API call — no calendar ID configured');
  }

  // ── Phase 4: createCalendarEvent and cancelCalendarEvent ────────────────
  console.log('\n--- Phase 4: createCalendarEvent + cancelCalendarEvent ---');

  if (calendarId) {
    console.log('  Creating test event...');
    try {
      const event = await createCalendarEvent({
        clinicId: CLINIC_ID,
        slot: { date: '2026-06-15', time: '14:00', durationMinutes: 30 },
        summary: 'AI Receptionist — Test Event',
        description: 'Created by testCalendarService.ts — safe to delete',
        timeZone: 'UTC',
      });
      pass(`Event created! ID: ${event.eventId}`);
      pass(`Calendar link: ${event.calendarLink}`);

      // Clean up immediately
      console.log('  Deleting test event...');
      await cancelCalendarEvent(CLINIC_ID, event.eventId);
      pass('Test event deleted successfully');
    } catch (e: unknown) {
      const err = e as Error & { code?: number; errors?: Array<{ message: string }> };
      const detail = err.errors?.[0]?.message ?? err.message;
      fail(`createCalendarEvent failed: ${detail}`);
      if (err.code === 403) {
        info('Fix: The service account does not have write access to this calendar.');
        info('  → Open Google Calendar → Settings for the calendar → "Share with specific people"');
        info('  → Add the service account email (from client_email above) with "Make changes to events"');
      }
    }
  } else {
    info('Skipping — no calendar ID configured in DB');
    info('Fix: run this SQL:');
    info(`  UPDATE clinic_settings SET google_calendar_id = 'your@calendar.id' WHERE clinic_id = '${CLINIC_ID}';`);
  }

  const exitCode = process.exitCode ?? 0;
  console.log(`\n=== ${exitCode === 0 ? 'ALL CHECKS PASSED' : 'ISSUES FOUND — see above'} ===\n`);
  process.exit(exitCode);
}

run().catch((e: unknown) => {
  console.error('Fatal:', (e as Error).message);
  process.exit(1);
});
