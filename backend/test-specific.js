require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');

const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
const sessionId = 'specific-test-' + Date.now();

async function runSpecificTest() {
  console.log('=== Testing with Specific Date ===\n');
  
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
  console.log('\n3. Name: Sarah Johnson');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Sarah Johnson' });
  console.log('   State:', result.state);
  
  // Turn 4: DOB
  console.log('\n4. DOB: January 15 1990');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'January 15 1990' });
  console.log('   State:', result.state);
  
  // Turn 5: Phone
  console.log('\n5. Phone: 555-123-4567');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '555-123-4567' });
  console.log('   State:', result.state);
  
  // Turn 6: Date (specific date - April 15, 2026)
  console.log('\n6. Date: April 15, 2026');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'April 15 2026' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  // Turn 7: Time
  console.log('\n7. Time: 2pm');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '2pm' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  // Turn 8: Confirm
  console.log('\n8. Confirm: yes');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'yes confirm' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  if (result.state === 'completed') {
    console.log('\n✅ Booking completed successfully!');
  } else {
    console.log('\n❌ Booking failed - final state:', result.state);
  }
  
  process.exit(0);
}

runSpecificTest().catch(console.error);
