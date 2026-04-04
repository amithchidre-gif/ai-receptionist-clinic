require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');
const { query } = require('./src/config/db');

const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
const sessionId = 'sms-test-' + Date.now();

async function runSmsTest() {
  console.log('=== Testing SMS Integration in Booking Flow ===\n');
  
  // Turn 1: Greeting
  console.log('1. Greeting');
  let result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('   State:', result.state);
  
  // Turn 2: Book appointment
  console.log('\n2. Book appointment');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  console.log('   Intent:', result.intent);
  console.log('   State:', result.state);
  
  // Turn 3: Name
  console.log('\n3. Name');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Sarah Johnson' });
  console.log('   State:', result.state);
  
  // Turn 4: DOB
  console.log('\n4. DOB');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'January 15 1990' });
  console.log('   State:', result.state);
  
  // Turn 5: Phone
  console.log('\n5. Phone');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '555-123-4567' });
  console.log('   State:', result.state);
  
  // Turn 6: Date
  console.log('\n6. Date');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'next Tuesday' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  // Turn 7: Time
  console.log('\n7. Time');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '2pm' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  // Turn 8: Confirm
  console.log('\n8. Confirm');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'yes confirm' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  console.log('\n=== Conversation Complete ===');
  
  // Wait for SMS to be processed
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Check SMS logs for this session
  const smsLogs = await query(`
    SELECT message_type, to_number, status, created_at 
    FROM sms_logs 
    ORDER BY created_at DESC 
    LIMIT 5
  `);
  
  console.log('\n📱 SMS Logs:');
  if (smsLogs.rows.length > 0) {
    smsLogs.rows.forEach(log => {
      console.log(`   ${log.message_type}: ${log.status} - ${log.created_at}`);
    });
  } else {
    console.log('   No SMS logs found');
  }
  
  // Check if confirmation SMS was sent
  const confirmationSms = await query(`
    SELECT * FROM sms_logs WHERE message_type = 'appointment_confirmation' ORDER BY created_at DESC LIMIT 1
  `);
  
  if (confirmationSms.rows.length > 0) {
    console.log('\n✅ Confirmation SMS found!');
    console.log('   To:', confirmationSms.rows[0].to_number);
    console.log('   Status:', confirmationSms.rows[0].status);
    console.log('   Message ID:', confirmationSms.rows[0].telnyx_message_id);
  } else {
    console.log('\n❌ No confirmation SMS found');
  }
  
  process.exit(0);
}

runSmsTest().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
