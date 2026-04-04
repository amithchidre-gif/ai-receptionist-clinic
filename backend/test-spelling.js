require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');

const clinicId = 'bbb44629-da9b-480a-91a2-6cff9c8c891c';
const sessionId = 'spell-test-' + Date.now();

async function test() {
  console.log('=== Name Spelling Test ===\n');
  
  // Turn 1: Greeting
  let result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('Turn 1: Greeting sent');
  
  // Turn 2: Book intent
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  console.log('Turn 2: Booking intent detected');
  
  // Turn 3: Name
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Sarah Johnson' });
  console.log('\n=== AI Response ===');
  console.log(result.responseText);
  console.log('\n=== Expected ===');
  console.log('Should contain: "S - A - R - A - H, Johnson: J - O - H - N - S - O - N"');
  
  if (result.responseText.includes('S - A - R - A - H')) {
    console.log('\n✅ Name spelling confirmation is WORKING!');
  } else {
    console.log('\n⚠️ Name spelling not detected. Check server logs for errors.');
  }
  
  process.exit(0);
}

test().catch(console.error);
