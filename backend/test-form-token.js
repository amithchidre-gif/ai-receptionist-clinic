/**
 * Form Token Integration Test
 *
 * Steps:
 *   1. Fetch a real clinic/appointment/patient from DB
 *   2. Create a form token via formTokenService
 *   3. Validate the token via GET /form/:token (HTTP)
 *   4. Report results and print the token for saving to context.md
 */

require('dotenv').config();

const { Pool } = require('pg');
const http = require('http');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SERVER_URL = process.env.BACKEND_URL || 'http://localhost:4000';

function pass(label) { console.log(`  ✅ PASS: ${label}`); }
function fail(label, detail) { console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body });
      });
    }).on('error', reject);
  });
}

async function cleanup() {
  try { await pool.end(); } catch {}
}

async function runTest() {
  let passed = 0;
  let failed = 0;

  console.log('=== Form Token Integration Test ===\n');

  // ── Step 1: Fetch IDs from DB ──────────────────────────────────────────
  console.log('1. Fetching clinic / appointment / patient from DB...');

  const clinicRes = await pool.query(
    'SELECT id FROM clinics LIMIT 1'
  );
  if (clinicRes.rows.length === 0) {
    console.error('   ❌ No clinics found. Run migrations and seed data first.');
    await cleanup();
    process.exit(1);
  }
  const clinicId = clinicRes.rows[0].id;

  const apptRes = await pool.query(
    "SELECT id FROM appointments WHERE clinic_id = $1 AND status = 'scheduled' ORDER BY created_at DESC LIMIT 1",
    [clinicId]
  );
  if (apptRes.rows.length === 0) {
    console.error('   ❌ No scheduled appointments found for clinic. Create one first.');
    await cleanup();
    process.exit(1);
  }
  const appointmentId = apptRes.rows[0].id;

  const patientRes = await pool.query(
    'SELECT id FROM patients WHERE clinic_id = $1 LIMIT 1',
    [clinicId]
  );
  if (patientRes.rows.length === 0) {
    console.error('   ❌ No patients found for clinic.');
    await cleanup();
    process.exit(1);
  }
  const patientId = patientRes.rows[0].id;

  console.log(`   clinic_id      : ${clinicId}`);
  console.log(`   appointment_id : ${appointmentId}`);
  console.log(`   patient_id     : ${patientId}`);
  console.log();

  // ── Step 2: Create form token ──────────────────────────────────────────
  console.log('2. Creating form token...');
  let token;
  try {
    const { createFormToken } = require('./src/services/formTokenService');
    token = await createFormToken({ clinicId, appointmentId, patientId });
    console.log(`   TOKEN: ${token}`);
    pass('createFormToken() returned a token');
    passed++;
  } catch (err) {
    fail('createFormToken() threw', err.message);
    failed++;
    await cleanup();
    process.exit(1);
  }

  // ── Step 3: Verify token row in DB ────────────────────────────────────
  console.log('\n3. Verifying token row in DB...');
  const tokenRow = await pool.query(
    'SELECT id, used, expires_at FROM form_tokens WHERE token = $1',
    [token]
  );
  if (tokenRow.rows.length === 0) {
    fail('Token row not found in form_tokens table');
    failed++;
  } else {
    const row = tokenRow.rows[0];
    pass('Token row exists in DB');
    passed++;
    console.log(`   used       : ${row.used}`);
    console.log(`   expires_at : ${row.expires_at}`);
    if (row.used === false) { pass('Token is not yet used'); passed++; }
    else { fail('Token already marked used'); failed++; }
  }

  // ── Step 4: Validate via HTTP ─────────────────────────────────────────
  console.log('\n4. Validating token via GET /form/:token ...');
  try {
    const url = `${SERVER_URL}/form/${token}`;
    console.log(`   GET ${url}`);
    const { statusCode, body } = await httpGet(url);
    console.log(`   HTTP ${statusCode}`);

    if (statusCode === 200) {
      const parsed = JSON.parse(body);
      if (parsed.success === true && parsed.data) {
        pass('HTTP 200 with { success: true, data: ... }');
        passed++;
        const d = parsed.data;
        console.log('\n   Prefill data returned:');
        console.log(`     clinicName      : ${d.clinicName}`);
        console.log(`     patientName     : ${d.patientName}`);
        console.log(`     patientDob      : ${d.patientDob}`);
        console.log(`     appointmentDate : ${d.appointmentDate}`);
        console.log(`     appointmentTime : ${d.appointmentTime}`);
        if (d.clinicName && d.appointmentDate) {
          pass('Prefill data fields populated');
          passed++;
        } else {
          fail('Some prefill fields are empty', JSON.stringify(d));
          failed++;
        }
      } else {
        fail('Response body unexpected', body.slice(0, 200));
        failed++;
      }
    } else if (statusCode === 404 || statusCode === 503) {
      console.log('   ⚠️  Server not running or /form/:token not mounted.');
      console.log('   Start the server with: npm run dev, then re-run this test.');
      failed++;
    } else {
      fail(`HTTP ${statusCode}`, body.slice(0, 200));
      failed++;
    }
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.log('\n   ⚠️  Server not reachable at ' + SERVER_URL);
      console.log('   Token was created successfully (Step 2 passed).');
      console.log('   Start the server and re-run, or test the URL manually:');
      console.log(`   Invoke-RestMethod -Uri "${SERVER_URL}/form/${token}"`);
    } else {
      fail('HTTP request failed', err.message);
      failed++;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  await cleanup();
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (token) {
    console.log('\n📋 Save this to context.md as TEST_FORM_TOKEN:');
    console.log(`   TEST_FORM_TOKEN=${token}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

runTest().catch(async (err) => {
  console.error('Fatal:', err.message);
  await cleanup().catch(() => {});
  process.exit(1);
});
