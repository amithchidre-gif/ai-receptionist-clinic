require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');

const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
const sessionId = 'debug-name-' + Date.now();

async function debugNameExtraction() {
  console.log('=== Debugging Name Extraction ===\n');
  
  // Turn 1: Greeting
  console.log('1. Greeting');
  let result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('   State:', result.state);
  
  // Turn 2: Book appointment
  console.log('\n2. Book appointment');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  console.log('   Intent:', result.intent);
  console.log('   State:', result.state);
  
  // Turn 3: Name - try different formats
  console.log('\n3. Name input: "Sarah Johnson"');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Sarah Johnson' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  // Check session data after name input
  const { getSession } = require('./src/voice/conversation-manager/conversationManager');
  // Note: getSession might not be exported. Let's check what's exported.
  
  console.log('\n✅ Debug complete');
  process.exit(0);
}

debugNameExtraction().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
