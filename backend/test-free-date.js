require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');

const clinicId = 'bbb44629-da9b-480a-91a2-6cff9c8c891c';
const sessionId = 'free-date-test-' + Date.now();

async function testFreeDate() {
  console.log('=== Testing with Free Date (April 20, 2026) ===\n');
  
  let result;
  
  // Turn 1: Greeting
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('T1: nextState:', result.nextState);
  
  // Turn 2: Book intent
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  console.log('T2: intent:', result.intent, 'nextState:', result.nextState);
  
  // Turn 3: Name
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Sarah Johnson' });
  console.log('T3: nextState:', result.nextState);
  
  // Turn 4: DOB
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'March 20 1985' });
  console.log('T4: nextState:', result.nextState);
  
  // Turn 5: Phone
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '555 123 4567' });
  console.log('T5: nextState:', result.nextState);
  
  // Turn 6: Date (April 20, 2026)
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'April 20 2026' });
  console.log('T6: nextState:', result.nextState);
  console.log('T6 response:', result.responseText);
  
  // Turn 7: Time
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '10am' });
  console.log('T7: nextState:', result.nextState);
  console.log('T7 response:', result.responseText);
  
  // Turn 8: Confirm
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'yes confirm' });
  console.log('T8: nextState:', result.nextState);
  console.log('T8 response:', result.responseText);
  
  console.log('\n✅ Final nextState:', result.nextState);
  process.exit(0);
}

testFreeDate().catch(console.error);
