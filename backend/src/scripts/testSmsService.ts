/**
 * SMS Service integration test.
 *
 * What it does:
 *   1. Seeds the Telnyx phone number into clinic_settings for TEST_CLINIC_ID
 *   2. Calls all 4 SMS senders with real Telnyx API
 *   3. Verifies sms_logs rows were created (4 total)
 *   4. Reports pass/fail and shows the sms_logs rows
 *   5. Cleans up test sms_logs rows
 *
 * Requires: TEST_TO_NUMBER env var (E.164 format, must differ from Telnyx FROM number)
 * Usage:
 *   $env:TEST_TO_NUMBER="+12125551234"; npx tsx --env-file .env src/scripts/testSmsService.ts
 */

import { query } from '../config/db';
import {
  sendConfirmationSms,
  sendFormLinkSms,
  sendReminderSms,
  sendCancellationSms,
} from '../services/smsService';

const CLINIC_ID     = '78de52b5-3895-4824-b970-2676eb668293';
const CLINIC_NAME   = 'Demo Clinic';
const FROM_NUMBER   = process.env.TELNYX_PHONE_NUMBER ?? '+19257097010';
// Required: set TEST_TO_NUMBER to your mobile (must differ from FROM_NUMBER)
// e.g.:  TEST_TO_NUMBER=+12125551234 npx tsx --env-file .env src/scripts/testSmsService.ts
const TEST_TO_NUMBER = process.env.TEST_TO_NUMBER ?? '';

const E164_RE = /^\+[1-9]\d{1,14}$/;

let pass = 0;
let fail = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) { pass++; console.log(`  PASS: ${label}`); }
  else           { fail++; console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  console.log('\n=== SMS Service Integration Test ===\n');

  if (!TEST_TO_NUMBER) {
    console.error('  ERROR: TEST_TO_NUMBER env var is not set.');
    console.error('');
    console.error('  Run as:');
    console.error('    $env:TEST_TO_NUMBER="+12125551234"; npx tsx --env-file .env src/scripts/testSmsService.ts');
    process.exit(1);
  }
  if (!E164_RE.test(TEST_TO_NUMBER)) {
    console.error('  ERROR: TEST_TO_NUMBER is not a valid E.164 phone number:', TEST_TO_NUMBER);
    console.error('         Format: +[country code][number], e.g. +12125551234 (no spaces or dashes)');
    process.exit(1);
  }
  if (TEST_TO_NUMBER === FROM_NUMBER) {
    console.error('  ERROR: TEST_TO_NUMBER must differ from the Telnyx FROM number.');
    console.error('         FROM:', FROM_NUMBER);
    console.error('         TO  :', TEST_TO_NUMBER);
    process.exit(1);
  }

  console.log(`  Clinic ID   : ${CLINIC_ID}`);
  console.log(`  From number : ${FROM_NUMBER}`);
  console.log(`  To number   : ${TEST_TO_NUMBER}`);
  console.log('');

  // ─── Step 1: Seed Telnyx number into clinic_settings ─────────────────────
  console.log('--- Step 1: Seed telnyx_phone_number into clinic_settings ---');
  await query(
    `UPDATE clinic_settings SET telnyx_phone_number = $1 WHERE clinic_id = $2`,
    [FROM_NUMBER, CLINIC_ID],
  );
  const settingsRow = await query(
    `SELECT telnyx_phone_number FROM clinic_settings WHERE clinic_id = $1`,
    [CLINIC_ID],
  );
  assert(
    `telnyx_phone_number set to ${FROM_NUMBER}`,
    settingsRow.rows[0]?.telnyx_phone_number === FROM_NUMBER,
    `got ${settingsRow.rows[0]?.telnyx_phone_number}`,
  );
  console.log('');

  // Count existing sms_logs rows before test
  const beforeCount = await query(
    `SELECT COUNT(*) FROM sms_logs WHERE clinic_id = $1`,
    [CLINIC_ID],
  );
  const before = Number(beforeCount.rows[0]?.count ?? 0);

  // ─── Step 2: Send confirmation SMS ───────────────────────────────────────
  console.log('--- Step 2: sendConfirmationSms ---');
  await sendConfirmationSms(CLINIC_ID, TEST_TO_NUMBER, 'Test Patient', 'June 1', '10:00 AM', CLINIC_NAME);
  // Allow a moment for DB write
  await new Promise(r => setTimeout(r, 300));
  const afterConfirm = await query(
    `SELECT * FROM sms_logs WHERE clinic_id = $1 AND message_type = $2 ORDER BY created_at DESC LIMIT 1`,
    [CLINIC_ID, 'appointment_confirmation'],
  );
  assert('sms_logs row created for appointment_confirmation', afterConfirm.rows.length > 0);
  if (afterConfirm.rows[0]) {
    console.log(`  message_type : ${afterConfirm.rows[0].message_type}`);
    console.log(`  status       : ${afterConfirm.rows[0].status}`);
    console.log(`  message_id   : ${afterConfirm.rows[0].telnyx_message_id}`);
  }
  console.log('');

  // ─── Step 3: sendReminderSms ──────────────────────────────────────────────
  console.log('--- Step 3: sendReminderSms ---');
  await sendReminderSms(CLINIC_ID, TEST_TO_NUMBER, 'June 1', '10:00 AM', CLINIC_NAME);
  await new Promise(r => setTimeout(r, 300));
  const afterReminder = await query(
    `SELECT * FROM sms_logs WHERE clinic_id = $1 AND message_type = $2 ORDER BY created_at DESC LIMIT 1`,
    [CLINIC_ID, 'appointment_reminder'],
  );
  assert('sms_logs row created for appointment_reminder', afterReminder.rows.length > 0);
  console.log('');

  // ─── Step 4: sendCancellationSms ─────────────────────────────────────────
  console.log('--- Step 4: sendCancellationSms ---');
  await sendCancellationSms(CLINIC_ID, TEST_TO_NUMBER, 'June 1', '10:00 AM', CLINIC_NAME);
  await new Promise(r => setTimeout(r, 300));
  const afterCancel = await query(
    `SELECT * FROM sms_logs WHERE clinic_id = $1 AND message_type = $2 ORDER BY created_at DESC LIMIT 1`,
    [CLINIC_ID, 'appointment_cancellation'],
  );
  assert('sms_logs row created for appointment_cancellation', afterCancel.rows.length > 0);
  console.log('');

  // ─── Step 5: sendFormLinkSms ──────────────────────────────────────────────
  console.log('--- Step 5: sendFormLinkSms ---');
  await sendFormLinkSms(CLINIC_ID, TEST_TO_NUMBER, 'https://example.com/intake/test-token');
  await new Promise(r => setTimeout(r, 300));
  const afterForm = await query(
    `SELECT * FROM sms_logs WHERE clinic_id = $1 AND message_type = $2 ORDER BY created_at DESC LIMIT 1`,
    [CLINIC_ID, 'intake_form_link'],
  );
  assert('sms_logs row created for intake_form_link', afterForm.rows.length > 0);
  console.log('');

  // ─── Step 6: Total row count check ───────────────────────────────────────
  console.log('--- Step 6: Total sms_logs rows ---');
  const afterCount = await query(
    `SELECT COUNT(*) FROM sms_logs WHERE clinic_id = $1`,
    [CLINIC_ID],
  );
  const after = Number(afterCount.rows[0]?.count ?? 0);
  assert(`sms_logs count increased by 4 (was ${before}, now ${after})`, after - before === 4,
    `delta = ${after - before}`);
  console.log('');

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`=== Results: ${pass}/${pass + fail} passed ===\n`);

  console.log(`  Check your phone (${TEST_TO_NUMBER}) for the test SMS messages.\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main();
