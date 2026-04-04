require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');

const clinicId = 'bbb44629-da9b-480a-91a2-6cff9c8c891c';
const sessionId = 'cancel-test2-' + Date.now();

async function testCancel() {
  console.log('=== Cancel Flow Test (checking nextState) ===\n');
  
  let result;
  
  // Turn 1: Greeting
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('T1: nextState:', result.nextState);
  
  // Turn 2: Cancel intent
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I need to cancel my appointment' });
  console.log('T2: intent:', result.intent, 'nextState:', result.nextState);
  
  // Turn 3: Name
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'John Smith' });
  console.log('T3: nextState:', result.nextState);
  
  // Turn 4: DOB
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'January 5 1990' });
  console.log('T4: nextState:', result.nextState);
  
  // Turn 5: Phone
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '555 987 6543' });
  console.log('T5: nextState:', result.nextState);
  console.log('T5 response:', result.responseText);
  
  console.log('\n✅ Final nextState:', result.nextState);
  console.log('Expected: completed');
  process.exit(0);
}

testCancel().catch(console.error);
