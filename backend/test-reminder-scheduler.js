/**
 * Reminder Scheduler Integration Test
 *
 * Steps:
 *   1. Insert a test appointment for tomorrow (using an existing patient)
 *   2. Call sendPendingReminders() directly (no server restart needed)
 *   3. Assert reminder_sent = true in DB
 *   4. Show recent sms_logs for confirmation
 *   5. Clean up the test appointment
 */

require('dotenv').config();

const { Pool } = require('pg');
const { sendPendingReminders } = require('./src/services/reminderScheduler');
// Import the internal pool used by the scheduler/models so we can drain it on exit
const { pool: dbPool } = require('./src/config/db');

const CLINIC_ID = '78de52b5-3895-4824-b970-2676eb668293';

let testAppointmentId = null;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(label) { console.log(`  ✅ PASS: ${label}`); }
function fail(label, detail = '') { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); }

async function cleanup() {
  if (testAppointmentId) {
    try {
      await pool.query(
        `DELETE FROM appointments WHERE id = $1 AND clinic_id = $2`,
        [testAppointmentId, CLINIC_ID],
      );
      console.log(`\n🧹 Cleaned up test appointment: ${testAppointmentId}`);
    } catch (err) {
      console.warn(`  ⚠️  Cleanup failed: ${err.message}`);
    }
  }
  try { await pool.end(); } catch { /* ignore pool close errors */ }
  try { await dbPool.end(); } catch { /* ignore internal pool close errors */ }
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function runTest() {
  let passed = 0;
  let failed = 0;

  console.log('=== Reminder Scheduler Integration Test ===\n');

  // ── Step 0: Show Node.js vs DB date so skew is immediately visible ────────
  const nodeToday = new Date().toISOString().slice(0, 10);
  const nodeTomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
  const dbDateRes = await pool.query(`SELECT CURRENT_DATE::TEXT AS db_today`);
  const dbToday = dbDateRes.rows[0].db_today;
  console.log('Date alignment check:');
  console.log(`   Node.js today    : ${nodeToday}  (scheduler uses this)`);
  console.log(`   Node.js tomorrow : ${nodeTomorrow}  (appointments must match this)`);
  console.log(`   PostgreSQL today : ${dbToday}`);
  if (nodeToday !== dbToday) {
    console.log(`   ⚠️  WARNING: Node.js and PostgreSQL dates differ by ${Math.round((new Date(nodeToday) - new Date(dbToday)) / 86400000)} day(s).`);
    console.log('      The scheduler now uses Node.js date as the source of truth.');
  } else {
    console.log('   ✅ Dates aligned.');
  }
  console.log();

  // ── Step 1: Find an existing patient for this clinic ─────────────────────
  console.log('1. Looking up a patient for the test clinic...');
  const patientRes = await pool.query(
    `SELECT id, name, phone FROM patients WHERE clinic_id = $1 LIMIT 1`,
    [CLINIC_ID],
  );

  if (patientRes.rows.length === 0) {
    console.error('   ❌ No patients found for clinic. Seed a patient first and re-run.');
    await pool.end();
    process.exit(1);
  }

  const patient = patientRes.rows[0];
  console.log(`   Patient found: id=${patient.id} (name and phone redacted)\n`);

  // ── Step 2: Insert test appointment for tomorrow ───────────────────────
  console.log('2. Inserting test appointment for tomorrow (reminder_sent = false)...');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD

  const apptRes = await pool.query(
    `INSERT INTO appointments
       (clinic_id, patient_id, appointment_date, appointment_time, status, reminder_sent, created_via)
     VALUES ($1, $2, $3, '10:00', 'scheduled', false, 'test')
     RETURNING id`,
    [CLINIC_ID, patient.id, tomorrowStr],
  );

  testAppointmentId = apptRes.rows[0].id;
  console.log(`   Inserted appointment id=${testAppointmentId} for ${tomorrowStr}\n`);

  // ── Step 3: Run the scheduler ──────────────────────────────────────────
  console.log('3. Running sendPendingReminders()...');
  try {
    await sendPendingReminders();
    pass('sendPendingReminders() completed without throwing');
    passed++;
  } catch (err) {
    fail('sendPendingReminders() threw unexpectedly', err.message);
    failed++;
    await cleanup();
    process.exit(1);
  }

  // ── Step 4: Assert reminder_sent = true ───────────────────────────────
  console.log('\n4. Verifying reminder_sent flag in DB...');
  const checkRes = await pool.query(
    `SELECT reminder_sent FROM appointments WHERE id = $1 AND clinic_id = $2`,
    [testAppointmentId, CLINIC_ID],
  );

  if (checkRes.rows.length === 0) {
    fail('Appointment row not found after scheduler run');
    failed++;
  } else if (checkRes.rows[0].reminder_sent === true) {
    pass('reminder_sent = true');
    passed++;
  } else {
    fail('reminder_sent is still false — SMS may have failed or patient phone not set');
    failed++;
  }

  // ── Step 5: Show recent SMS logs ──────────────────────────────────────
  console.log('\n5. Recent sms_logs for this clinic (last 5 rows):');
  const smsRes = await pool.query(
    `SELECT message_type, to_number, status, telnyx_message_id, created_at
     FROM sms_logs
     WHERE clinic_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [CLINIC_ID],
  );

  if (smsRes.rows.length === 0) {
    fail('No SMS log rows found — reminder SMS was not persisted');
    failed++;
  } else {
    pass(`Found ${smsRes.rows.length} SMS log row(s)`);
    passed++;
    console.log('\n   Type               | To Number        | Status  | Telnyx ID                            | Time');
    console.log('   -------------------|------------------|---------|--------------------------------------|--------------------');
    for (const row of smsRes.rows) {
      const type   = (row.message_type ?? '').padEnd(19);
      const to     = (row.to_number ?? '').padEnd(16);
      const status = (row.status ?? '').padEnd(7);
      const id     = (row.telnyx_message_id ?? '').padEnd(36);
      const time   = row.created_at?.toISOString?.() ?? '';
      console.log(`   ${type} | ${to} | ${status} | ${id} | ${time}`);
    }
  }

  // ── Step 6: Assert tomorrow's appointments all have reminder_sent = true
  console.log('\n6. Cross-checking all tomorrow\'s scheduled appointments...');
  const allTomorrowRes = await pool.query(
    `SELECT id, reminder_sent
     FROM appointments
     WHERE clinic_id = $1
       AND appointment_date = $2
       AND status = 'scheduled'`,
    [CLINIC_ID, tomorrowStr],
  );

  const notSent = allTomorrowRes.rows.filter((r) => r.reminder_sent !== true);
  if (notSent.length === 0) {
    pass('All tomorrow\'s scheduled appointments have reminder_sent = true');
    passed++;
  } else {
    fail(`${notSent.length} appointment(s) still have reminder_sent = false`, notSent.map((r) => r.id).join(', '));
    failed++;
  }

  // ── Summary ─────────────────────────────────────────────────────────
  await cleanup();

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('\n🎉 All checks passed! Reminder scheduler is working correctly.');
    console.log('   • SMS was sent (check logs above for Telnyx message ID)');
    console.log('   • DB reminder_sent flag updated to true');
  } else {
    console.log('\n⚠️  Some checks failed. Review output above for details.');
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTest().catch(async (err) => {
  console.error('\nFatal error:', err.message);
  await cleanup().catch(() => {});
  process.exit(1);
});
