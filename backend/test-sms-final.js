require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');

const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
const sessionId = 'sms-final-' + Date.now();

async function runSmsFinalTest() {
  console.log('=== Testing SMS with Correct Phone Number ===\n');
  
  // Turn 1: Greeting
  console.log('1. Greeting');
  let result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  
  // Turn 2: Book appointment
  console.log('\n2. Book appointment');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  
  // Turn 3: Name
  console.log('\n3. Name: Sarah Johnson');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Sarah Johnson' });
  
  // Turn 4: DOB
  console.log('\n4. DOB: January 15 1990');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'January 15 1990' });
  
  // Turn 5: Phone (use actual US number in E.164 format)
  console.log('\n5. Phone: +19255497652');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '+19255497652' });
  console.log('   Response:', result.responseText);
  
  // Turn 6: Date
  console.log('\n6. Date: April 15, 2026');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'April 15 2026' });
  
  // Turn 7: Time
  console.log('\n7. Time: 2pm');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '2pm' });
  console.log('   Response:', result.responseText);
  
  // Turn 8: Confirm
  console.log('\n8. Confirm: yes');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'yes confirm' });
  console.log('   Response:', result.responseText);
  console.log('   Final State:', result.state);
  
  if (result.state === 'completed') {
    console.log('\n✅ Booking completed successfully!');
    console.log('   Check your phone for confirmation SMS');
  } else {
    console.log('\n❌ Booking failed - final state:', result.state);
  }
  
  process.exit(0);
}

runSmsFinalTest().catch(console.error);
