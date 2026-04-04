require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');
const { Pool } = require('pg');

const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
const sessionId = 'sms-final-' + Date.now();

async function runFinalTest() {
  console.log('=== Final SMS Test with New Date ===\n');
  
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
  
  // Turn 5: Phone
  console.log('\n5. Providing phone: +19255497652');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '+19255497652' });
  console.log('   Response:', result.responseText);
  
  // Turn 6: Date (April 19, 2026 - NEW DATE)
  console.log('\n6. Date: April 19, 2026');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'April 19 2026' });
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
  
  // Check if booking succeeded
  if (result.nextState === 'completed') {
    console.log('\n✅ Booking completed successfully!');
    
    // Check SMS logs
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const smsResult = await pool.query(`
      SELECT message_type, to_number, status, telnyx_message_id, created_at 
      FROM sms_logs 
      WHERE message_type = 'appointment_confirmation' 
      ORDER BY created_at DESC 
      LIMIT 1
    `);
    
    if (smsResult.rows.length > 0) {
      console.log('\n📱 Latest confirmation SMS:');
      console.log(`   To: ${smsResult.rows[0].to_number}`);
      console.log(`   Status: ${smsResult.rows[0].status}`);
      console.log(`   Message ID: ${smsResult.rows[0].telnyx_message_id}`);
      console.log(`   Time: ${smsResult.rows[0].created_at}`);
    }
    
    await pool.end();
  } else {
    console.log('\n❌ Booking failed - nextState:', result.nextState);
  }
  
  process.exit(0);
}

runFinalTest().catch(console.error);
