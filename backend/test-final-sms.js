require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');
const { Pool } = require('pg');

const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
const sessionId = 'sms-final-' + Date.now();

async function runFinalTest() {
  console.log('=== Final SMS Test ===\n');
  
  // Turn 1: Greeting
  let result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('1. Greeting done');
  
  // Turn 2: Book appointment
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  console.log('2. Booking intent done');
  
  // Turn 3: Name
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Sarah Johnson' });
  console.log('3. Name captured');
  
  // Turn 4: DOB
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'January 15 1990' });
  console.log('4. DOB captured');
  
  // Turn 5: Phone (E.164 format with +)
  console.log('\n5. Providing phone: +19255497652');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '+19255497652' });
  console.log('   Response:', result.responseText);
  
  // Turn 6: Date
  console.log('\n6. Date: April 18, 2026');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'April 18 2026' });
  console.log('   Response:', result.responseText);
  
  // Turn 7: Time
  console.log('\n7. Time: 2pm');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '2pm' });
  console.log('   Response:', result.responseText);
  
  // Turn 8: Confirm
  console.log('\n8. Confirm: yes');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'yes confirm' });
  console.log('   Response:', result.responseText);
  console.log('   State (previous):', result.state);
  console.log('   Next State:', result.nextState);

  const bookingSucceeded = result.nextState === 'completed';

  if (bookingSucceeded) {
    console.log('\n✅ Booking completed!');
  } else {
    console.log('\n❌ Booking failed. nextState:', result.nextState);
  }

  // --- DB verification ---
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Check appointment was created
    const apptRes = await pool.query(
      `SELECT id, appointment_date, appointment_time, created_via
       FROM appointments
       WHERE clinic_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [clinicId]
    );
    if (apptRes.rows.length > 0) {
      const appt = apptRes.rows[0];
      console.log('\n📅 Latest appointment in DB:');
      console.log('   ID:   ', appt.id);
      console.log('   Date: ', appt.appointment_date);
      console.log('   Time: ', appt.appointment_time);
      console.log('   Via:  ', appt.created_via);
    } else {
      console.log('\n⚠️  No appointment found in DB for this clinic.');
    }

    // Check SMS log
    const smsRes = await pool.query(
      `SELECT message_type, to_number, status, telnyx_message_id, created_at
       FROM sms_logs
       WHERE clinic_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [clinicId]
    );
    if (smsRes.rows.length > 0) {
      console.log('\n📨 Recent SMS logs:');
      for (const row of smsRes.rows) {
        console.log(`   [${row.message_type}] to=${row.to_number} status=${row.status} id=${row.telnyx_message_id} at=${row.created_at}`);
      }
    } else {
      console.log('\n⚠️  No SMS logs found for this clinic.');
    }
  } finally {
    await pool.end();
  }

  process.exit(bookingSucceeded ? 0 : 1);
}

runFinalTest().catch(console.error);
