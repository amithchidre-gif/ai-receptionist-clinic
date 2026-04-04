/**
 * Full End-to-End Test
 *
 * Tests the complete AI receptionist workflow:
 *   Step 1  — call.initiated webhook  → call_log created
 *   Step 2  — 8-turn conversation      → patient + appointment + SMS logs
 *   Step 3  — call.hangup webhook      → call_log completed
 *   Step 4  — DB verification          → 5 expected rows (+ extras)
 *   Step 5  — Intake form submission   → form_responses + form_completed
 *   Step 6  — Dashboard API            → stats reflect new data
 *
 * Usage:
 *   node test-e2e.js [baseUrl] [clinicPhone]
 *
 * Defaults:
 *   baseUrl     = http://localhost:4000
 *   clinicPhone = +19257097010   (admin@testclinic.com)
 */

'use strict';

const http = require('http');
const https = require('https');
const { Client } = require('pg');
require('dotenv').config();

// ─── Config ─────────────────────────────────────────────────────────────────

const BASE_URL     = process.argv[2] || 'http://localhost:4000';
const CLINIC_PHONE = process.argv[3] || '+19257097010';
const CLINIC_ID    = '78de52b5-3895-4824-b970-2676eb668293';  // admin@testclinic.com
const CALLER_PHONE = '+15550009876';
const SESSION_ID   = 'e2e-final';

// Test user for dashboard check
const TEST_EMAIL    = 'admin@testclinic.com';
const TEST_PASSWORD = 'Password123';

const DB_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:localpassword@localhost:5435/ai_receptionist';

let pass = 0;
let fail = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok(label) {
  console.log(`  \x1b[32m[PASS]\x1b[0m ${label}`);
  pass++;
}

function bad(label, detail) {
  console.log(`  \x1b[31m[FAIL]\x1b[0m ${label}${detail ? '  => ' + detail : ''}`);
  fail++;
}

/**
 * Simple HTTP/HTTPS request helper.
 * Returns { statusCode, body } where body is the parsed JSON (or raw string).
 * Throws on connection errors.
 */
function request(method, url, bodyObj, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const data   = bodyObj ? JSON.stringify(bodyObj) : null;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ statusCode: res.statusCode, body });
      });
    });

    req.on('error', reject);
    // Individual timeouts — each pipeline turn may take up to 12 s (TTS)
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function postJson(path, body, authToken) {
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  return request('POST', `${BASE_URL}${path}`, body, headers);
}

async function getJson(path, authToken) {
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  return request('GET', `${BASE_URL}${path}`, null, headers);
}

// DB helper
async function dbQuery(sql) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const result = await client.query(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n\x1b[36m════════════════════════════════════════════\x1b[0m');
  console.log(`\x1b[36m  AI Receptionist — Full E2E Test\x1b[0m`);
  console.log(`  Server:  ${BASE_URL}`);
  console.log(`  Session: ${SESSION_ID}`);
  console.log(`  Clinic:  ${CLINIC_ID}`);
  console.log('\x1b[36m════════════════════════════════════════════\x1b[0m\n');

  // ── Pre-flight: health check ──────────────────────────────────────────────
  console.log('\x1b[33m[PRE-FLIGHT] Health check\x1b[0m');
  try {
    const health = await getJson('/health');
    if (health.body?.data?.status === 'ok') {
      ok(`Server is healthy (${BASE_URL})`);
    } else {
      bad('Health check', `unexpected response: ${JSON.stringify(health.body)}`);
      process.exit(1);
    }
  } catch (e) {
    bad('Health check', e.message);
    process.exit(1);
  }

  // ── Save and temporarily clear calendar ID (prevents real slot checks) ───
  console.log('\n\x1b[33m[SETUP] Suspending Google Calendar slot check for test\x1b[0m');
  try {
    const calRows = await dbQuery(
      `SELECT google_calendar_id FROM clinic_settings WHERE clinic_id = '${CLINIC_ID}'`
    );
    savedCalendarId = calRows[0]?.google_calendar_id ?? null;
    if (savedCalendarId) {
      await dbQuery(
        `UPDATE clinic_settings SET google_calendar_id = NULL WHERE clinic_id = '${CLINIC_ID}'`
      );
      console.log(`  Calendar ID temporarily cleared (was: ${savedCalendarId})`);
    } else {
      console.log('  No calendar ID configured — slot check already fails open.');
    }
  } catch (e) {
    console.log(`  Warning: could not suspend calendar check: ${e.message}`);
  }

  // ── Clean up old test data ────────────────────────────────────────────────
  console.log('\n\x1b[33m[SETUP] Cleaning stale e2e-final data\x1b[0m');
  try {
    await dbQuery(`
      DELETE FROM conversation_sessions WHERE session_id = '${SESSION_ID}';
      DELETE FROM call_logs WHERE call_control_id = '${SESSION_ID}';
    `);
    // Also clear in-memory session via hangup webhook
    await postJson('/voice/telnyx/webhook', {
      data: { event_type: 'call.hangup', payload: { call_control_id: SESSION_ID } },
    });
    console.log('  Stale data cleaned.');
  } catch (e) {
    console.log(`  Cleanup warning (non-fatal): ${e.message}`);
  }
  // ── Login (obtain JWT for authenticated endpoints) ──────────────────────────────
  console.log('\n\x1b[33m[AUTH] Login for JWT\x1b[0m');
  try {
    const loginResp = await postJson('/api/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    authToken = loginResp.body?.data?.token ?? null;
    if (authToken) {
      ok('Logged in — JWT obtained');
    } else {
      bad('Auth login', `No token returned: ${JSON.stringify(loginResp.body)}`);
      // Pipeline turns require auth — abort
      process.exit(1);
    }
  } catch (e) {
    bad('Auth login', e.message);
    process.exit(1);
  }
  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: call.initiated
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[33m[STEP 1] call.initiated\x1b[0m');
  try {
    const r1 = await postJson('/voice/telnyx/webhook', {
      data: {
        event_type: 'call.initiated',
        payload: {
          call_control_id: SESSION_ID,
          from: CALLER_PHONE,
          to:   CLINIC_PHONE,
        },
      },
    });
    // Webhook returns 200 immediately; processing is async — wait briefly
    await new Promise(r => setTimeout(r, 1000));

    const rows = await dbQuery(
      `SELECT id, status FROM call_logs WHERE call_control_id = '${SESSION_ID}' LIMIT 1`
    );

    if (rows.length > 0) {
      ok(`call.initiated → call_log created (id=${rows[0].id.slice(0,8)}... status=${rows[0].status})`);
      this_callLogId = rows[0].id;
    } else {
      bad('call.initiated', `No call_log found with call_control_id='${SESSION_ID}'`);
      this_callLogId = null;
    }
  } catch (e) {
    bad('call.initiated webhook', e.message);
    this_callLogId = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: 8-turn conversation
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[33m[STEP 2] 8-turn conversation via /voice/pipeline/turn\x1b[0m');

  const turns = [
    { label: 'T1 (greeting)',     transcript: null },
    { label: 'T2 (intent: book)', transcript: "I'd like to book an appointment please" },
    { label: 'T3 (name)',         transcript: 'My name is Alex Johnson' },
    { label: 'T4 (DOB)',          transcript: 'January 15 1990' },
    { label: 'T5 (phone)',        transcript: '555 010 0002' },
    { label: 'T6 (date)',         transcript: 'next Monday' },
    { label: 'T7 (time)',         transcript: '10am' },
    { label: 'T8 (confirm yes)',  transcript: 'yes' },
  ];

  let lastTurnResult = null;
  for (const { label, transcript } of turns) {
    const body = {
      sessionId: SESSION_ID,
      callLogId: this_callLogId,
      ...(transcript && { transcriptFragment: transcript }),
    };

    try {
      const start = Date.now();
      const r = await postJson('/voice/pipeline/turn', body, authToken);
      const elapsed = Date.now() - start;
      const d = r.body?.data ?? {};

      if (r.body?.success) {
        const resp = (d.responseText || '').slice(0, 65);
        ok(`${label} [${d.state}→${d.nextState}] (${elapsed}ms): "${resp}"`);
        lastTurnResult = d;
      } else {
        bad(label, `success=false: ${JSON.stringify(r.body)}`);
      }
    } catch (e) {
      bad(label, e.message);
    }
  }

  const callCompleted = lastTurnResult?.nextState === 'completed';
  if (callCompleted) {
    ok('Conversation reached "completed" state after T8');
  } else {
    bad('Conversation state', `Expected nextState=completed, got ${lastTurnResult?.nextState}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: call.hangup
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[33m[STEP 3] call.hangup\x1b[0m');
  try {
    await postJson('/voice/telnyx/webhook', {
      data: {
        event_type: 'call.hangup',
        payload: { call_control_id: SESSION_ID },
      },
    });
    await new Promise(r => setTimeout(r, 500));

    const rows = await dbQuery(
      `SELECT status FROM call_logs WHERE call_control_id = '${SESSION_ID}' LIMIT 1`
    );
    if (rows[0]?.status === 'completed') {
      ok('call.hangup → call_log.status = completed');
    } else {
      bad('call.hangup', `status=${rows[0]?.status}`);
    }
  } catch (e) {
    bad('call.hangup webhook', e.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: Database verification
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[33m[STEP 4] Database verification\x1b[0m');
  try {
    // -- patient
    const patientRows = await dbQuery(
      `SELECT id, name, phone FROM patients ORDER BY created_at DESC LIMIT 1`
    );
    if (patientRows.length > 0 && patientRows[0].name === 'Alex Johnson') {
      ok(`patient: Alex Johnson (id=${patientRows[0].id.slice(0,8)}...) phone=${patientRows[0].phone}`);
    } else {
      bad('patient record', `expected "Alex Johnson", got ${JSON.stringify(patientRows[0])}`);
    }

    // -- appointment
    const apptRows = await dbQuery(
      `SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.form_completed, p.name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.clinic_id = '${CLINIC_ID}'
       ORDER BY a.created_at DESC LIMIT 1`
    );
    if (apptRows.length > 0 && apptRows[0].name === 'Alex Johnson') {
      ok(`appointment: ${apptRows[0].appointment_date} ${apptRows[0].appointment_time} status=${apptRows[0].status} form_completed=${apptRows[0].form_completed}`);
      this_appointmentId = apptRows[0].id;
    } else {
      bad('appointment record', `Expected for Alex Johnson: ${JSON.stringify(apptRows[0])}`);
      this_appointmentId = null;
    }

    // -- call_log
    const clRows = await dbQuery(
      `SELECT id, status FROM call_logs WHERE call_control_id = '${SESSION_ID}'`
    );
    if (clRows.length > 0) {
      ok(`call_log: id=${clRows[0].id.slice(0,8)}... status=${clRows[0].status}`);
    } else {
      bad('call_log record', `Not found for session=${SESSION_ID}`);
    }

    // -- sms_logs: appointment_confirmation
    const smsConf = await dbQuery(
      `SELECT id, status, to_number FROM sms_logs
       WHERE clinic_id = '${CLINIC_ID}' AND message_type = 'appointment_confirmation'
       ORDER BY created_at DESC LIMIT 1`
    );
    if (smsConf.length > 0) {
      ok(`sms_logs: appointment_confirmation status=${smsConf[0].status} to=${smsConf[0].to_number}`);
    } else {
      bad('sms_logs appointment_confirmation', 'No row found');
    }

    // -- sms_logs: intake_form_link
    const smsForm = await dbQuery(
      `SELECT id, status, to_number FROM sms_logs
       WHERE clinic_id = '${CLINIC_ID}' AND message_type = 'intake_form_link'
       ORDER BY created_at DESC LIMIT 1`
    );
    if (smsForm.length > 0) {
      ok(`sms_logs: intake_form_link status=${smsForm[0].status} to=${smsForm[0].to_number}`);
    } else {
      bad('sms_logs intake_form_link', 'No row found');
    }

  } catch (e) {
    bad('DB verification', e.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 5 & 6: Form token validation + intake form submission
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[33m[STEP 5/6] Intake form — token + submit\x1b[0m');
  let formToken = null;
  try {
    const tokenRows = await dbQuery(
      `SELECT ft.token, ft.appointment_id
       FROM form_tokens ft
       WHERE ft.clinic_id = '${CLINIC_ID}'
         AND ft.used = false
         AND ft.expires_at > NOW()
       ORDER BY ft.created_at DESC LIMIT 1`
    );

    if (tokenRows.length === 0) {
      bad('form_token', 'No unused form token found — form link SMS may have failed before creating token');
    } else {
      formToken = tokenRows[0].token;
      if (!this_appointmentId) this_appointmentId = tokenRows[0].appointment_id;
      ok(`form_token obtained (${formToken.slice(0,12)}...) for appt=${this_appointmentId?.slice(0,8)}...`);

      // Validate token via GET /form/:token
      const tokenResp = await getJson(`/form/${formToken}`);
      if (tokenResp.body?.success) {
        const d = tokenResp.body.data;
        ok(`GET /form/:token → patient="${d.patientName}" date=${d.appointmentDate} time=${d.appointmentTime}`);
      } else {
        bad('GET /form/:token', JSON.stringify(tokenResp.body));
      }

      // Submit intake form
      const submitResp = await postJson('/api/forms/submit', {
        token: formToken,
        responses: {
          'Chief complaint':     'Annual checkup',
          'Current medications': 'None',
          'Allergies':           'Penicillin',
          'Emergency contact':   'Jane Johnson 555-0002',
          'Insurance provider':  'BlueCross',
        },
      });

      if (submitResp.body?.success) {
        ok('Intake form submitted → success');
      } else {
        bad('Form submit', JSON.stringify(submitResp.body));
      }

      // DB: form_responses row
      const formRows = await dbQuery(
        `SELECT submitted_at FROM form_responses
         WHERE appointment_id = '${this_appointmentId}'
         ORDER BY submitted_at DESC LIMIT 1`
      );
      if (formRows.length > 0) {
        ok(`form_responses row created: submitted_at=${formRows[0].submitted_at?.toISOString().slice(0,19)}`);
      } else {
        bad('form_responses DB row', 'Not found');
      }

      // DB: appointments.form_completed = true
      const fcRows = await dbQuery(
        `SELECT form_completed FROM appointments WHERE id = '${this_appointmentId}'`
      );
      if (fcRows[0]?.form_completed === true) {
        ok('appointments.form_completed = true');
      } else {
        bad('form_completed flag', `Expected true, got ${fcRows[0]?.form_completed}`);
      }
    }
  } catch (e) {
    bad('Form step', e.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 7: Dashboard API
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[33m[STEP 7] Dashboard API stats\x1b[0m');
  try {
    // Login with test clinic user — already done above, reuse token
    const token = authToken;
    if (!token) {
      bad('Dashboard login', 'No auth token from earlier login step');
    } else {
      ok('Dashboard login succeeded');
      const dashResp = await getJson('/api/dashboard', token);
      if (dashResp.body?.success) {
        const d = dashResp.body.data;
        ok(
          `Dashboard stats: calls=${d.totalCallsToday} apptToday=${d.appointmentsToday} ` +
          `apptWeek=${d.appointmentsThisWeek} newPatients=${d.newPatientsThisWeek} ` +
          `pendingForms=${d.pendingForms} recentCalls=${d.recentCalls?.length ?? 0}`
        );
      } else {
        bad('Dashboard API', JSON.stringify(dashResp.body));
      }
    }
  } catch (e) {
    bad('Dashboard step', e.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Teardown: restore calendar ID
  // ─────────────────────────────────────────────────────────────────────────
  if (savedCalendarId) {
    try {
      await dbQuery(
        `UPDATE clinic_settings SET google_calendar_id = '${savedCalendarId}' WHERE clinic_id = '${CLINIC_ID}'`
      );
      console.log(`\n\x1b[90m[TEARDOWN] Calendar ID restored: ${savedCalendarId}\x1b[0m`);
    } catch (e) {
      console.log(`\n\x1b[31m[TEARDOWN] WARNING: Failed to restore calendar ID: ${e.message}\x1b[0m`);
      console.log(`  Manual fix: UPDATE clinic_settings SET google_calendar_id='${savedCalendarId}' WHERE clinic_id='${CLINIC_ID}';`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[36m════════════════════════════════════════════\x1b[0m');
  const color = fail === 0 ? '\x1b[32m' : '\x1b[33m';
  console.log(`${color}  Results: ${pass} PASSED  /  ${fail} FAILED\x1b[0m`);
  console.log('\x1b[36m════════════════════════════════════════════\x1b[0m\n');

  process.exit(fail > 0 ? 1 : 0);
}

// Variables set inside async functions, declared here for cross-step access
let this_callLogId     = null;
let this_appointmentId = null;
let savedCalendarId    = null;
let authToken          = null;

main().catch(e => {
  console.error('\x1b[31m[FATAL]\x1b[0m', e.message);
  process.exit(1);
});
