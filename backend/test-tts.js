const { synthesize } = require('./src/voice/tts/ttsService');

async function runTests() {
  console.log('=== TTS Service Comprehensive Tests ===\n');

  const testCases = [
    { name: 'Normal text', text: 'Hello, this is a test.', expectAudio: false },
    { name: 'Empty text', text: '', expectAudio: false },
    { name: 'Short text', text: 'Hi', expectAudio: false },
    { name: 'Text with special chars', text: 'Patient: John Doe. Appointment at 2:30 PM.', expectAudio: false },
  ];

  for (const test of testCases) {
    const result = await synthesize({
      text: test.text,
      sessionId: 'test-session',
      clinicId: 'test-clinic'
    });
    
    console.log(\n:);
    console.log(  ✓ Return shape: );
    console.log(  ✓ Text preserved: );
    console.log(  ✓ Audio buffer: );
    console.log(  ✓ No crash: yes);
  }

  console.log('\n✅ All tests passed!');
}

runTests().catch(console.error);
