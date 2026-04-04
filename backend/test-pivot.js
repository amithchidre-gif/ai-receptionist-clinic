require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');

const clinicId = 'bbb44629-da9b-480a-91a2-6cff9c8c891c';
const sessionId = 'pivot-test-' + Date.now();

async function testPivot() {
  console.log('=== Pivot Flow Detailed Test ===\n');
  
  // Turn 1: Greeting
  let result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('T1: State:', result.state);
  
  // Turn 2: Book intent
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  console.log('T2: Intent:', result.intent, 'State:', result.state);
  
  // Turn 3: Pivot to cancel
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Actually wait I need to cancel instead' });
  console.log('T3: Intent:', result.intent, 'State:', result.state);
  
  // Turn 4: Check if intent changed
  console.log('\n✅ Intent changed to cancel:', result.intent === 'cancel_appointment');
  process.exit(0);
}

testPivot().catch(console.error);
