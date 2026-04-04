import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load env
require('dotenv').config({ path: new URL('../../.env', import.meta.url).pathname.replace(/^\//, '') });

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CLINIC_ID = '78de52b5-3895-4824-b970-2676eb668293';
const PHONE_TO = '+15550002222';
const PHONE_FROM = '+15550001111';
const CALL_CONTROL_ID = 'test-call-1';
const BASE_URL = 'http://localhost:4000';

function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg) { console.error(`  FAIL  ${msg}`); process.exitCode = 1; }

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function dbRow() {
  const r = await pool.query(
    'SELECT status, duration_seconds FROM call_logs WHERE call_control_id = $1',
    [CALL_CONTROL_ID],
  );
  return r.rows[0] ?? null;
}

async function cleanup() {
  await pool.query('DELETE FROM call_logs WHERE call_control_id = $1', [CALL_CONTROL_ID]);
  await pool.query(
    "UPDATE clinic_settings SET telnyx_phone_number = $1 WHERE clinic_id = $2",
    [PHONE_TO, CLINIC_ID],
  );
}

async function run() {
  console.log('\n=== Telnyx Webhook Integration Tests ===\n');

  // Seed phone number
  await pool.query(
    'UPDATE clinic_settings SET telnyx_phone_number = $1 WHERE clinic_id = $2',
    [PHONE_TO, CLINIC_ID],
  );
  console.log(`Seeded ${PHONE_TO} -> clinic ${CLINIC_ID}`);

  // Clean up any leftover row from a previous run
  await pool.query('DELETE FROM call_logs WHERE call_control_id = $1', [CALL_CONTROL_ID]);

  // ────────────────────────────────────────────────────────────────
  // Test 1: call.initiated creates a call_log row
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- Test 1: call.initiated ---');
  const status1 = await post('/voice/telnyx/webhook', {
    data: {
      event_type: 'call.initiated',
      payload: {
        call_control_id: CALL_CONTROL_ID,
        from: PHONE_FROM,
        to: PHONE_TO,
      },
    },
  });

  if (status1 === 200) {
    pass(`Webhook responded 200`);
  } else {
    fail(`Webhook responded ${status1} (expected 200)`);
  }

  // Give async processing a moment
  await new Promise(r => setTimeout(r, 400));

  const row1 = await dbRow();
  if (row1) {
    pass(`DB row created for call_control_id='${CALL_CONTROL_ID}'`);
  } else {
    fail(`No DB row found for call_control_id='${CALL_CONTROL_ID}'`);
  }

  if (row1?.status === 'in_progress') {
    pass(`status = 'in_progress'`);
  } else {
    fail(`status = '${row1?.status}' (expected 'in_progress')`);
  }

  // ────────────────────────────────────────────────────────────────
  // Test 2: call.hangup marks it completed
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- Test 2: call.hangup ---');

  // Ensure at least 1 second elapsed so duration_seconds >= 1
  await new Promise(r => setTimeout(r, 1100));

  const status2 = await post('/voice/telnyx/webhook', {
    data: {
      event_type: 'call.hangup',
      payload: { call_control_id: CALL_CONTROL_ID },
    },
  });

  if (status2 === 200) {
    pass(`Webhook responded 200`);
  } else {
    fail(`Webhook responded ${status2} (expected 200)`);
  }

  await new Promise(r => setTimeout(r, 400));

  const row2 = await dbRow();
  if (row2?.status === 'completed') {
    pass(`status = 'completed'`);
  } else {
    fail(`status = '${row2?.status}' (expected 'completed')`);
  }

  if (typeof row2?.duration_seconds === 'number' && row2.duration_seconds >= 1) {
    pass(`duration_seconds = ${row2.duration_seconds} (>= 1)`);
  } else {
    fail(`duration_seconds = ${row2?.duration_seconds} (expected integer >= 1)`);
  }

  // ────────────────────────────────────────────────────────────────
  // Test 3: unknown phone number is handled gracefully (no crash)
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- Test 3: unknown phone number ---');
  const status3 = await post('/voice/telnyx/webhook', {
    data: {
      event_type: 'call.initiated',
      payload: {
        call_control_id: 'test-unknown-phone',
        from: '+19999999999',
        to: '+10000000000',
      },
    },
  });

  if (status3 === 200) {
    pass(`Webhook still returns 200 for unknown phone`);
  } else {
    fail(`Webhook returned ${status3} (expected 200)`);
  }

  await pool.end();

  const exitCode = process.exitCode ?? 0;
  console.log(`\n=== ${exitCode === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} ===\n`);
}

run().catch(e => {
  console.error('Fatal:', e.message);
  pool.end();
  process.exit(1);
});
