/**
 * Full 8-turn booking conversation integration test.
 *
 * Runs `runPipelineTurn` 8 times with pre-baked transcripts,
 * then verifies the appointment row in DB and the Google Calendar event.
 *
 * Usage:  npx tsx --env-file .env src/scripts/testBookingFlow.ts
 */

import { randomUUID } from 'crypto';
import { runPipelineTurn, getSession, clearSession } from '../voice/conversation-manager/conversationManager';
import { query } from '../config/db';
import { cancelCalendarEvent } from '../services/googleCalendarService';

const TEST_CLINIC_ID = '78de52b5-3895-4824-b970-2676eb668293';
const SESSION_ID = `test-booking-${randomUUID()}`;

// Use a date ~7 days in the future to avoid conflicts
const futureDate = new Date();
futureDate.setDate(futureDate.getDate() + 7);
const month = String(futureDate.getMonth() + 1).padStart(2, '0');
const day = String(futureDate.getDate()).padStart(2, '0');
const year = futureDate.getFullYear();
const DATE_TRANSCRIPT = `${month}/${day}/${year}`;   // e.g. "04/01/2026"
const EXPECTED_ISO_DATE = `${year}-${month}-${day}`;  // e.g. "2026-04-01"

let pass = 0;
let fail = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); }
}

// The 8 turns of the conversation
const turns: { transcript: string; expectState: string; expectNextState: string; label: string }[] = [
  {
    transcript: '',
    expectState: 'greeting',
    expectNextState: 'intent_detection',
    label: 'Turn 1: Greeting',
  },
  {
    transcript: 'I would like to book an appointment please',
    expectState: 'intent_detection',
    expectNextState: 'identity_verification',
    label: 'Turn 2: Intent → book_appointment',
  },
  {
    transcript: 'My name is Test Patient',
    expectState: 'identity_verification',
    expectNextState: 'identity_verification',
    label: 'Turn 3: Provide name',
  },
  {
    transcript: '01/15/1990',
    expectState: 'identity_verification',
    expectNextState: 'identity_verification',
    label: 'Turn 4: Provide DOB',
  },
  {
    transcript: '555-000-1234',
    expectState: 'identity_verification',
    expectNextState: 'booking_flow',
    label: 'Turn 5: Provide phone → identity verified',
  },
  {
    transcript: DATE_TRANSCRIPT,
    expectState: 'booking_flow',
    expectNextState: 'awaiting_time',
    label: 'Turn 6: Provide date',
  },
  {
    transcript: '10:00 AM',
    expectState: 'awaiting_time',
    expectNextState: 'awaiting_time',
    label: 'Turn 7: Provide time → awaiting confirmation',
  },
  {
    transcript: 'yes',
    expectState: 'awaiting_time',
    expectNextState: 'completed',
    label: 'Turn 8: Confirm booking',
  },
];

async function cleanup(createdPatientId: string | null, googleEventId: string | null) {
  try {
    // Delete test appointment
    await query(`DELETE FROM appointments WHERE clinic_id = $1 AND patient_id = $2`, [TEST_CLINIC_ID, createdPatientId]);
  } catch { /* ignore */ }
  try {
    // Delete conversation_sessions
    await query(`DELETE FROM conversation_sessions WHERE session_id = $1`, [SESSION_ID]);
  } catch { /* ignore */ }
  try {
    // Delete test patient
    if (createdPatientId) {
      await query(`DELETE FROM patients WHERE id = $1 AND clinic_id = $2`, [createdPatientId, TEST_CLINIC_ID]);
    }
  } catch { /* ignore */ }
  try {
    // Clean up calendar event
    if (googleEventId) {
      await cancelCalendarEvent(TEST_CLINIC_ID, googleEventId);
      console.log(`\n  Cleaned up Google Calendar event: ${googleEventId}`);
    }
  } catch { /* ignore */ }
  clearSession(SESSION_ID);
}

async function main() {
  console.log('\n=== Full 8-Turn Booking Conversation Integration Test ===\n');
  console.log(`  Session ID : ${SESSION_ID}`);
  console.log(`  Clinic ID  : ${TEST_CLINIC_ID}`);
  console.log(`  Date input : ${DATE_TRANSCRIPT}  →  expected ISO: ${EXPECTED_ISO_DATE}`);
  console.log('');

  let createdPatientId: string | null = null;
  let googleEventId: string | null = null;

  try {
    // ─── Run all 8 turns ────────────────────────────────────────────────
    for (const turn of turns) {
      console.log(`--- ${turn.label} ---`);
      const result = await runPipelineTurn({
        sessionId: SESSION_ID,
        clinicId: TEST_CLINIC_ID,
        transcriptFragment: turn.transcript,
      });

      assert(`state was ${turn.expectState}`, result.state === turn.expectState,
        `got ${result.state}`);
      assert(`nextState is ${turn.expectNextState}`, result.nextState === turn.expectNextState,
        `got ${result.nextState}`);
      assert('responseText is non-empty', result.responseText.length > 0);

      console.log(`  Response: "${result.responseText.slice(0, 100)}${result.responseText.length > 100 ? '...' : ''}"`);
      console.log('');
    }

    // ─── Verify session state ───────────────────────────────────────────
    console.log('--- Post-conversation session checks ---');
    const session = getSession(SESSION_ID);
    assert('session exists', !!session);
    assert('bookingConfirmed = true', session?.bookingConfirmed === true);
    assert('verifiedPatientId is set', !!session?.verifiedPatientId);
    assert('lastAppointmentId is set', !!session?.lastAppointmentId);
    createdPatientId = session?.verifiedPatientId ?? null;
    console.log('');

    // ─── Verify DB appointment ──────────────────────────────────────────
    console.log('--- DB appointment verification ---');
    const dbResult = await query(
      `SELECT id, status, google_event_id, appointment_date, appointment_time, created_via
       FROM appointments
       WHERE clinic_id = $1 AND id = $2`,
      [TEST_CLINIC_ID, session?.lastAppointmentId],
    );
    const row = dbResult.rows[0];
    assert('Appointment row exists', !!row);

    if (row) {
      assert('status = scheduled', row.status === 'scheduled', `got ${row.status}`);
      assert(`appointment_date = ${EXPECTED_ISO_DATE}`, row.appointment_date === EXPECTED_ISO_DATE,
        `got ${row.appointment_date}`);
      assert('appointment_time = 10:00', row.appointment_time === '10:00',
        `got ${row.appointment_time}`);
      assert('google_event_id is populated', !!row.google_event_id,
        row.google_event_id ? `eventId = ${row.google_event_id}` : 'NULL');
      assert('created_via = voice', row.created_via === 'voice', `got ${row.created_via}`);
      googleEventId = row.google_event_id as string | null;

      console.log('');
      console.log('  DB Row:');
      console.log(`    id              : ${row.id}`);
      console.log(`    status          : ${row.status}`);
      console.log(`    appointment_date: ${row.appointment_date}`);
      console.log(`    appointment_time: ${row.appointment_time}`);
      console.log(`    google_event_id : ${row.google_event_id}`);
      console.log(`    created_via     : ${row.created_via}`);
    }
    console.log('');

    // ─── Verify Google Calendar event ─────────────────────────────────
    console.log('--- Google Calendar verification ---');
    if (googleEventId) {
      console.log(`  Google Calendar event created: ${googleEventId}`);
      console.log('  → Check your Google Calendar for the "Appointment" event');
      console.log(`    on ${EXPECTED_ISO_DATE} at 10:00 UTC`);
      assert('Google Calendar event was created', true);
    } else {
      assert('Google Calendar event was created', false, 'google_event_id is NULL');
    }
    console.log('');

  } catch (err: unknown) {
    console.error('\n  FATAL ERROR:', (err as Error).message);
    console.error((err as Error).stack);
  } finally {
    // ─── Cleanup ──────────────────────────────────────────────────────
    console.log('--- Cleanup ---');
    await cleanup(createdPatientId, googleEventId);
    console.log('  Test data cleaned up.');
  }

  // ─── Summary ────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${pass}/${pass + fail} passed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
