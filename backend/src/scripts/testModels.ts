import dotenv from 'dotenv';
dotenv.config();

import { upsertPatient } from '../models/patientModel';
import { createAppointment, getAppointments, cancelAppointment } from '../models/appointmentModel';

const CLINIC_ID = '78de52b5-3895-4824-b970-2676eb668293';

function pass(msg: string) { console.log(`  PASS  ${msg}`); }
function fail(msg: string) { console.error(`  FAIL  ${msg}`); process.exitCode = 1; }

async function run() {
  console.log('\n=== Patient & Appointment Model Tests ===\n');

  // ── Test 1: upsertPatient — creates new patient ─────────────────────────
  console.log('--- Test 1: upsertPatient (new) ---');
  const result1 = await upsertPatient({
    clinicId: CLINIC_ID,
    name: 'Test Patient',
    phone: '5550001234',
  });

  if (result1.isNew === true || result1.isNew === false) {
    pass(`upsertPatient returned isNew=${result1.isNew}`);
  } else {
    fail('upsertPatient did not return isNew');
  }
  if (result1.patient?.id) {
    pass(`Patient ID: ${result1.patient.id.substring(0, 8)}...`);
  } else {
    fail('No patient ID returned');
    process.exit(1);
  }

  const patientId = result1.patient.id;

  // ── Test 2: upsertPatient — returns existing on second call ─────────────
  console.log('\n--- Test 2: upsertPatient (existing) ---');
  const result2 = await upsertPatient({
    clinicId: CLINIC_ID,
    name: 'Test Patient',
    phone: '5550001234',
  });

  if (result2.isNew === false) {
    pass('Second upsert returned isNew=false (existing)');
  } else {
    fail(`Expected isNew=false, got isNew=${result2.isNew}`);
  }
  if (result2.patient.id === patientId) {
    pass('Returned the same patient ID');
  } else {
    fail(`ID mismatch: got ${result2.patient.id.substring(0,8)} expected ${patientId.substring(0,8)}`);
  }

  // ── Test 3: createAppointment ─────────────────────────────────────────────
  console.log('\n--- Test 3: createAppointment ---');
  const appt = await createAppointment({
    clinicId: CLINIC_ID,
    patientId,
    appointmentDate: '2026-06-01',
    appointmentTime: '10:00',
    createdVia: 'voice',
  });

  if (appt.id) {
    pass(`Appointment ID: ${appt.id.substring(0, 8)}...`);
  } else {
    fail('No appointment ID returned');
    process.exit(1);
  }
  if (appt.status === 'scheduled') {
    pass(`status = '${appt.status}'`);
  } else {
    fail(`Expected status='scheduled', got '${appt.status}'`);
  }
  if (appt.patientName === 'Test Patient') {
    pass(`patientName = '${appt.patientName}' (JOIN works)`);
  } else {
    fail(`patientName = '${appt.patientName}' (expected 'Test Patient')`);
  }
  if (appt.clinicId === CLINIC_ID) {
    pass('clinic_id is correct');
  } else {
    fail(`clinic_id mismatch: ${appt.clinicId}`);
  }

  const apptId = appt.id;

  // ── Test 4: getAppointments — list ────────────────────────────────────────
  console.log('\n--- Test 4: getAppointments ---');
  const list = await getAppointments(CLINIC_ID);

  if (list.length >= 1) {
    pass(`getAppointments returned ${list.length} row(s)`);
  } else {
    fail(`Expected >= 1 appointments, got ${list.length}`);
  }
  const found = list.find(a => a.id === apptId);
  if (found) {
    pass('Created appointment appears in list');
  } else {
    fail('Created appointment not found in list');
  }

  // ── Test 5: getAppointments with filter ───────────────────────────────────
  console.log('\n--- Test 5: getAppointments (date filter) ---');
  const filtered = await getAppointments(CLINIC_ID, { date: '2026-06-01' });
  if (filtered.length >= 1 && filtered.every(a => a.appointmentDate === '2026-06-01')) {
    pass(`Date filter returned ${filtered.length} row(s), all on 2026-06-01`);
  } else {
    fail(`Date filter returned unexpected results: ${JSON.stringify(filtered.map(a => a.appointmentDate))}`);
  }

  // ── Test 6: cancelAppointment ─────────────────────────────────────────────
  console.log('\n--- Test 6: cancelAppointment ---');
  const cancelled = await cancelAppointment(CLINIC_ID, apptId);
  if (cancelled.status === 'cancelled') {
    pass(`status = 'cancelled'`);
  } else {
    fail(`Expected 'cancelled', got '${cancelled.status}'`);
  }

  // ── Test 7: cancelAppointment — wrong clinic_id throws ────────────────────
  console.log('\n--- Test 7: cancelAppointment (wrong clinic_id = 403) ---');
  try {
    await cancelAppointment('00000000-0000-0000-0000-000000000000', apptId);
    fail('Expected error but none thrown');
  } catch (e: unknown) {
    const err = e as Error & { statusCode?: number };
    if (err.statusCode === 403) {
      pass('Correctly threw 403 for wrong clinic_id');
    } else {
      fail(`Threw error but wrong statusCode: ${err.statusCode} — ${err.message}`);
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  // Remove test data so re-runs stay idempotent
  const { query } = await import('../config/db');
  await query('DELETE FROM appointments WHERE patient_id = $1', [patientId]);
  await query('DELETE FROM patients WHERE id = $1 AND clinic_id = $2', [patientId, CLINIC_ID]);
  console.log('\n  (test data cleaned up)');

  const exitCode = process.exitCode ?? 0;
  console.log(`\n=== ${exitCode === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} ===\n`);
  process.exit(exitCode);
}

run().catch((e: unknown) => {
  console.error('Fatal:', (e as Error).message);
  process.exit(1);
});
