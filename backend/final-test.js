require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');
const { query } = require('./src/config/db');

const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
const sessionId = 'final-test-' + Date.now();

async function runFullConversation() {
  console.log('=== Complete Booking Flow Test ===\n');
  
  // Turn 1: Greeting
  console.log('1. Greeting');
  let result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText.substring(0, 60) + '...');
  
  // Turn 2: Book appointment
  console.log('\n2. Book appointment');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  console.log('   Intent:', result.intent);
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  // Turn 3: Name
  console.log('\n3. Name');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Sarah Johnson' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  // Turn 4: DOB
  console.log('\n4. DOB');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'January 15 1990' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  // Turn 5: Phone
  console.log('\n5. Phone');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '555-123-4567' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
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
  
  // Wait for DB writes
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Check the created appointment
  const appointment = await query(`
    SELECT id, status, google_event_id, appointment_date, appointment_time, patient_id, created_via
    FROM appointments 
    ORDER BY created_at DESC 
    LIMIT 1
  `);
  
  if (appointment.rows.length > 0) {
    console.log('\n✅ Appointment created:');
    console.log('   ID:', appointment.rows[0].id);
    console.log('   Status:', appointment.rows[0].status);
    console.log('   Date:', appointment.rows[0].appointment_date);
    console.log('   Time:', appointment.rows[0].appointment_time);
    console.log('   Google Event ID:', appointment.rows[0].google_event_id);
    console.log('   Created Via:', appointment.rows[0].created_via);
  } else {
    console.log('\n❌ No appointment created');
  }
  
  // Check the patient
  const patient = await query(`
    SELECT id, name, phone, date_of_birth 
    FROM patients 
    WHERE name = 'Sarah Johnson'
    ORDER BY created_at DESC 
    LIMIT 1
  `);
  
  if (patient.rows.length > 0) {
    console.log('\n✅ Patient found:');
    console.log('   ID:', patient.rows[0].id);
    console.log('   Name:', patient.rows[0].name);
    console.log('   Phone:', patient.rows[0].phone);
    console.log('   DOB:', patient.rows[0].date_of_birth);
  }
  
  process.exit(0);
}

runFullConversation().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
