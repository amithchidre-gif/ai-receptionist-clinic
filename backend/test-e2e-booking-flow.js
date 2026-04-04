/**
 * E2E Booking Flow Test
 *
 * Covers the three expected outcomes after a booking is confirmed:
 *   1. Form-link SMS was delivered (verified via sms_logs table)
 *   2. Token returns prefilled patient/appointment data (GET /form/:token)
 *   3. Form submission writes to DB + generates a PDF (POST /api/forms/submit)
 *
 * Usage:
 *   node -r ts-node/register test-e2e-booking-flow.js
 *   -- or --
 *   node test-e2e-booking-flow.js        (plain JS, no TS compilation needed)
 */

require('dotenv').config();

const { Pool } = require('pg');
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const pool       = new Pool({ connectionString: process.env.DATABASE_URL });
const BACKEND    = process.env.BACKEND_URL   || 'http://localhost:4000';
const FRONTEND   = process.env.FRONTEND_URL  || 'http://localhost:3000';

// ── Tiny reporter ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const issues = [];

function pass(label) {
  passed++;
  console.log(`  ✅  ${label}`);
}
function fail(label, detail = '') {
  failed++;
  const msg = detail ? `${label} — ${detail}` : label;
  issues.push(msg);
  console.log(`  ❌  ${msg}`);
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
function httpRequest(rawUrl, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(rawUrl);
    const lib     = url.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname : url.hostname,
      port     : url.port || (url.protocol === 'https:' ? 443 : 80),
      path     : url.pathname + url.search,
      method   : options.method || 'GET',
      headers  : options.headers || {},
    };

    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      reqOpts.headers['Content-Type']   = 'application/json';
      reqOpts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() });
      });
    });

    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function httpGet(url)         { return httpRequest(url); }
async function httpPost(url, body)  { return httpRequest(url, { method: 'POST' }, body); }

// ── Main ───────────────────────────────────────────────────────────────────
async function runTest() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       E2E Booking Flow Test — Full Intake Form Pipeline      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Backend  : ${BACKEND}`);
  console.log(`  Frontend : ${FRONTEND}`);
  console.log(`  Time     : ${new Date().toISOString()}\n`);

  // ── 0. Backend health ────────────────────────────────────────────────────
  section('0 · Backend health check');
  try {
    const { statusCode } = await httpGet(`${BACKEND}/health`);
    if (statusCode === 200) pass('Backend is reachable');
    else fail('Backend /health returned non-200', String(statusCode));
  } catch (e) {
    fail('Backend is not reachable', e.message);
    console.log('\n  ⚠️  Start the backend: cd backend && npm run dev');
    await teardown(); return;
  }

  // ── 1. Fetch test data from DB ───────────────────────────────────────────
  section('1 · Fetch test clinic / appointment / patient from DB');

  const clinicRes = await pool.query('SELECT id, name FROM clinics LIMIT 1');
  if (!clinicRes.rows.length) {
    fail('No clinics in DB — run migrations and seed data first');
    await teardown(); return;
  }
  const clinicId   = clinicRes.rows[0].id;
  const clinicName = clinicRes.rows[0].name;

  // Pick the most recent scheduled appointment that has a linked patient
  const apptRes = await pool.query(
    `SELECT a.id, a.appointment_date, a.appointment_time, a.patient_id,
            p.name AS patient_name, p.phone AS patient_phone,
            p.date_of_birth AS patient_dob
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     WHERE a.clinic_id = $1
       AND a.status    = 'scheduled'
     ORDER BY a.created_at DESC
     LIMIT 1`,
    [clinicId],
  );
  if (!apptRes.rows.length) {
    fail('No scheduled appointments with a linked patient — create one first');
    await teardown(); return;
  }

  const appt          = apptRes.rows[0];
  const appointmentId = appt.id;
  const patientId     = appt.patient_id;
  const patientPhone  = appt.patient_phone;

  console.log(`  clinic_id        : ${clinicId}`);
  console.log(`  clinic_name      : ${clinicName}`);
  console.log(`  appointment_id   : ${appointmentId}`);
  console.log(`  appointment_date : ${appt.appointment_date}`);
  console.log(`  patient_id       : ${patientId}`);
  console.log(`  patient_name     : ${appt.patient_name}`);
  console.log(`  patient_phone    : ${patientPhone}`);
  pass('Test records found in DB');

  // ── 2. Create form token (simulates what confirmBooking does) ────────────
  section('2 · Create form token (simulating confirmBooking)');
  let token;
  try {
    // Require path is relative to backend root (cwd when running this script)
    const { createFormToken } = require('./src/services/formTokenService');
    token = await createFormToken({ clinicId, appointmentId, patientId });
    if (token && token.length === 64) {
      pass(`createFormToken() returned 64-char hex token`);
      console.log(`  token : ${token}`);
    } else {
      fail('Token has unexpected format', String(token));
    }
  } catch (e) {
    fail('createFormToken() threw', e.message);
    await teardown(); return;
  }

  // ── 3. Verify token row in DB ────────────────────────────────────────────
  section('3 · DB — form_tokens row verification');
  const tokenRow = await pool.query(
    'SELECT id, used, expires_at FROM form_tokens WHERE token = $1',
    [token],
  );
  if (!tokenRow.rows.length) {
    fail('Token row not found in form_tokens');
  } else {
    const row = tokenRow.rows[0];
    pass('Row exists in form_tokens');
    console.log(`  used       : ${row.used}`);
    console.log(`  expires_at : ${row.expires_at}`);
    row.used === false ? pass('Token not yet used') : fail('Token already marked used');
    const expires = new Date(row.expires_at);
    const hoursLeft = (expires - Date.now()) / 3_600_000;
    hoursLeft > 0 ? pass(`Token expires in ${hoursLeft.toFixed(1)} h`) : fail('Token is already expired');
  }

  // ── 4. Verify form-link SMS was logged ───────────────────────────────────
  section('4 · SMS log — form-link SMS (intake_form_link)');
  const smsRes = await pool.query(
    `SELECT id, status, telnyx_message_id, created_at
     FROM sms_logs
     WHERE clinic_id    = $1
       AND message_type = 'intake_form_link'
     ORDER BY created_at DESC
     LIMIT 1`,
    [clinicId],
  );
  if (!smsRes.rows.length) {
    fail(
      'No intake_form_link SMS row found in sms_logs — ' +
      'either SMS sending failed or Telnyx is not configured',
    );
    console.log('  ℹ️  Tip: check backend logs for smsService warnings');
  } else {
    const sms = smsRes.rows[0];
    pass('intake_form_link SMS row found in sms_logs');
    console.log(`  sms_log id     : ${sms.id}`);
    console.log(`  status         : ${sms.status}`);
    console.log(`  telnyx_msg_id  : ${sms.telnyx_message_id}`);
    console.log(`  created_at     : ${sms.created_at}`);
    if (sms.status && sms.status !== 'failed') {
      pass(`SMS status is "${sms.status}"`);
    } else {
      fail('SMS status indicates failure', sms.status);
    }
  }

  // ── 5. GET /form/:token — prefill data ───────────────────────────────────
  section('5 · GET /form/:token — prefill data returned');
  const formUrl = `${BACKEND}/form/${token}`;
  console.log(`  GET ${formUrl}`);
  try {
    const { statusCode, body } = await httpGet(formUrl);
    console.log(`  HTTP ${statusCode}`);
    if (statusCode === 200) {
      pass('HTTP 200 returned');
      let parsed;
      try { parsed = JSON.parse(body); } catch { fail('Response is not valid JSON', body.slice(0, 120)); }
      if (parsed) {
        const d = parsed.data || parsed;
        const expectFields = ['clinicName', 'patientName', 'appointmentDate', 'appointmentTime'];
        const missing = expectFields.filter((f) => !d[f]);
        if (missing.length === 0) {
          pass('All prefill fields populated');
        } else {
          fail('Missing prefill fields', missing.join(', '));
        }
        console.log('  Prefill data:');
        console.log(`    clinicName      : ${d.clinicName}`);
        console.log(`    patientName     : ${d.patientName}`);
        console.log(`    patientDob      : ${d.patientDob}`);
        console.log(`    appointmentDate : ${d.appointmentDate}`);
        console.log(`    appointmentTime : ${d.appointmentTime}`);
        if (d.clinicName === clinicName) pass('clinicName matches DB');
        else fail('clinicName mismatch', `got="${d.clinicName}" expected="${clinicName}"`);
      }
    } else if (statusCode === 410) {
      fail('GET /form/:token returned 410 — token expired or already used');
    } else {
      fail(`Unexpected HTTP ${statusCode}`, body.slice(0, 200));
    }
  } catch (e) {
    fail('GET /form/:token threw', e.message);
  }

  // ── 6. Frontend intake URL (smoke-check) ─────────────────────────────────
  section('6 · Frontend intake URL (presence check)');
  const intakeUrl = `${FRONTEND}/intake/${token}`;
  console.log(`  URL : ${intakeUrl}`);
  try {
    const { statusCode } = await httpGet(intakeUrl);
    console.log(`  HTTP ${statusCode}`);
    if (statusCode === 200) pass('Frontend intake page returns HTTP 200');
    else if (statusCode === 404) fail('Frontend intake page returned 404 — page not found or frontend not running');
    else fail(`Unexpected HTTP ${statusCode} from frontend`);
  } catch (e) {
    if (e.code === 'ECONNREFUSED') {
      console.log('  ⚠️  Frontend not running — skipping smoke-check');
      console.log(`  To start frontend: cd frontend && npm run dev -- --port 3000`);
    } else {
      fail('Frontend request threw', e.message);
    }
  }

  // ── 7. POST /api/forms/submit — submission + DB write + PDF ──────────────
  section('7 · POST /api/forms/submit — DB write + PDF generation');
  const submitUrl  = `${BACKEND}/api/forms/submit`;
  const submitBody = {
    token,
    responses: {
      fullName              : appt.patient_name || 'Test Patient',
      dob                   : appt.patient_dob  || '1980-01-01',
      phone                 : patientPhone       || '+10000000000',
      reason                : 'Annual checkup (E2E test)',
      medications           : 'None',
      allergies             : 'None',
      insuranceProvider     : 'Test Insurance Co.',
      insuranceMemberId     : 'TIC-00001',
      emergencyContactName  : 'Test Emergency Contact',
      emergencyContactPhone : '+10000000001',
    },
  };

  console.log(`  POST ${submitUrl}`);
  try {
    const { statusCode, body } = await httpPost(submitUrl, submitBody);
    console.log(`  HTTP ${statusCode}`);
    if (statusCode === 200) {
      pass('POST /api/forms/submit returned HTTP 200');
    } else {
      fail(`POST /api/forms/submit returned HTTP ${statusCode}`, body.slice(0, 300));
    }
  } catch (e) {
    fail('POST /api/forms/submit threw', e.message);
  }

  // ── 8. DB — form_responses row ───────────────────────────────────────────
  section('8 · DB — form_responses row written');
  const respRow = await pool.query(
    `SELECT id, submitted_at, pdf_path, response_data
     FROM form_responses
     WHERE appointment_id = $1
       AND clinic_id      = $2
     ORDER BY submitted_at DESC
     LIMIT 1`,
    [appointmentId, clinicId],
  );
  if (!respRow.rows.length) {
    fail('form_responses row not found after submission');
  } else {
    const row = respRow.rows[0];
    pass('form_responses row exists');
    console.log(`  form_response id : ${row.id}`);
    console.log(`  submitted_at     : ${row.submitted_at}`);
    console.log(`  pdf_path         : ${row.pdf_path}`);
    const data = typeof row.response_data === 'string'
      ? JSON.parse(row.response_data)
      : row.response_data;
    if (data && data.reason === 'Annual checkup (E2E test)') {
      pass('response_data.reason matches submitted value');
    } else {
      fail('response_data.reason does not match', JSON.stringify(data?.reason));
    }
  }

  // ── 9. DB — form_tokens.used = true ─────────────────────────────────────
  section('9 · DB — token marked used after submission');
  const usedRow = await pool.query(
    'SELECT used FROM form_tokens WHERE token = $1',
    [token],
  );
  if (!usedRow.rows.length) {
    fail('Token row disappeared from form_tokens');
  } else {
    usedRow.rows[0].used === true
      ? pass('form_tokens.used = true (token consumed)')
      : fail('form_tokens.used is still false — markTokenUsed() may not have run');
  }

  // ── 10. DB — appointment.form_completed = true ──────────────────────────
  section('10 · DB — appointment.form_completed flag');
  const apptFlagRow = await pool.query(
    'SELECT form_completed FROM appointments WHERE id = $1',
    [appointmentId],
  );
  if (!apptFlagRow.rows.length) {
    fail('Appointment row not found');
  } else {
    apptFlagRow.rows[0].form_completed === true
      ? pass('appointment.form_completed = true')
      : fail('appointment.form_completed is still false — markFormCompleted() may not have run');
  }

  // ── 11. PDF file on disk ─────────────────────────────────────────────────
  section('11 · PDF file on disk');
  const pdfPath = path.join(process.cwd(), 'tmp', 'forms', `${appointmentId}.pdf`);
  console.log(`  Expected path: ${pdfPath}`);
  if (fs.existsSync(pdfPath)) {
    const stat = fs.statSync(pdfPath);
    pass(`PDF exists on disk (${stat.size} bytes)`);
    if (stat.size > 1024) pass('PDF has non-trivial size (> 1 KB)');
    else fail('PDF is suspiciously small', `${stat.size} bytes`);
  } else {
    fail('PDF file not found on disk — PDF generation may have failed');
    console.log('  ℹ️  Check backend logs for PDF generation errors');
  }

  // ── 12. Verify token is now rejected (single-use) ───────────────────────
  section('12 · GET /form/:token — token now rejected (single-use)');
  try {
    const { statusCode, body } = await httpGet(`${BACKEND}/form/${token}`);
    console.log(`  HTTP ${statusCode}`);
    if (statusCode === 410) {
      pass('Second use of token correctly returns 410 Gone');
    } else if (statusCode === 200) {
      fail('Token is still valid after submission — it was not marked used');
    } else {
      fail(`Unexpected HTTP ${statusCode}`, body.slice(0, 120));
    }
  } catch (e) {
    fail('Request threw', e.message);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Results: ${passed} passed, ${failed} failed${' '.repeat(Math.max(0, 44 - String(passed).length - String(failed).length))}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (failed === 0) {
    console.log('\n  🎉  All checks passed!');
    console.log(`\n  Patient intake URL (open in browser to verify prefill):`);
    console.log(`  ${FRONTEND}/intake/${token}`);
    console.log('  (Note: token was consumed by step 7 — this link now shows "expired")');
  } else {
    console.log('\n  Issues:');
    issues.forEach((i, n) => console.log(`    ${n + 1}. ${i}`));
  }

  await teardown();
  process.exit(failed > 0 ? 1 : 0);
}

async function teardown() {
  try { await pool.end(); } catch {}
}

runTest().catch(async (err) => {
  console.error('\nUnhandled error:', err.message);
  await teardown();
  process.exit(1);
});
