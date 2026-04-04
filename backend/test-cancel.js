require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');

const clinicId = 'bbb44629-da9b-480a-91a2-6cff9c8c891c';
const sessionId = 'cancel-test-' + Date.now();

async function testCancel() {
  console.log('=== Cancel Flow Detailed Test ===\n');
  
  // Turn 1: Greeting
  let result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('T1: State:', result.state);
  
  // Turn 2: Cancel intent
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I need to cancel my appointment' });
  console.log('T2: Intent:', result.intent, 'State:', result.state);
  
  // Turn 3: Name
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'John Smith' });
  console.log('T3: State:', result.state);
  
  // Turn 4: DOB
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'January 5 1990' });
  console.log('T4: State:', result.state);
  
  // Turn 5: Phone
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '555 987 6543' });
  console.log('T5: State:', result.state);
  console.log('T5 Response:', result.responseText);
  
  // Turn 6: Additional turn to see if it completes
  if (result.state === 'cancel_flow') {
    console.log('\n--- Sending empty turn to move from cancel_flow to completed ---');
    result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
    console.log('T6: State:', result.state);
    console.log('T6 Response:', result.responseText);
  }
  
  console.log('\n✅ Final State:', result.state);
  process.exit(0);
}

testCancel().catch(console.error);
