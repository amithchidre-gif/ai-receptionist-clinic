require('dotenv').config();
const { runPipelineTurn } = require('./src/voice/conversation-manager/conversationManager');
const { query } = require('./src/config/db');

const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
const sessionId = 'minimal-test-' + Date.now();

async function minimalTest() {
  console.log('=== Minimal Conversation Test ===\n');
  
  // Step through the conversation
  let result;
  
  // Turn 1: Greeting
  console.log('1. Greeting');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: '' });
  console.log('   State:', result.state);
  
  // Turn 2: Book appointment
  console.log('\n2. Book appointment');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'I want to book an appointment' });
  console.log('   State:', result.state);
  
  // Turn 3: Name
  console.log('\n3. Name: "Sarah Johnson"');
  result = await runPipelineTurn({ sessionId, clinicId, transcriptFragment: 'Sarah Johnson' });
  console.log('   State:', result.state);
  console.log('   Response:', result.responseText);
  
  // Check session data from database
  const sessionData = await query(`
    SELECT session_data FROM conversation_sessions WHERE session_id = $1
  `, [sessionId]);
  
  if (sessionData.rows.length > 0) {
    console.log('\n=== Session Data from DB ===');
    const data = sessionData.rows[0].session_data;
    console.log('   collectedData.name:', data.collectedData?.name);
    console.log('   state:', data.state);
  }
  
  process.exit(0);
}

minimalTest().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
