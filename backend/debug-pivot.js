require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');

const clinicId = 'bbb44629-da9b-480a-91a2-6cff9c8c891c';
const sessionId = 'debug-pivot2-' + Date.now();

async function testPivot() {
  console.log('=== Pivot Flow Debug ===\n');
  
  let result;
  
  // Turn 1: Greeting
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('T1: nextState:', result.nextState);
  
  // Turn 2: Book intent
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  console.log('T2: intent:', result.intent, 'nextState:', result.nextState);
  
  // Turn 3: Pivot to cancel
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Actually wait I need to cancel instead' });
  console.log('T3: intent:', result.intent, 'nextState:', result.nextState);
  
  // Turn 4: Check if we're in cancel flow
  if (result.intent === 'cancel_appointment') {
    console.log('\n✅ Intent changed to cancel!');
  } else {
    console.log('\n❌ Intent still:', result.intent);
  }
  
  process.exit(0);
}

testPivot().catch(console.error);
