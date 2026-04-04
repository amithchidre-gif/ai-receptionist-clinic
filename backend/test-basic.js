const { detectIntent } = require('./src/voice/intent-detection/intentService');

async function test() {
  console.log('=== Basic Intent Tests ===\n');
  
  const tests = [
    { text: 'I want to book an appointment please', expected: 'book_appointment' },
    { text: 'I need to cancel my appointment', expected: 'cancel_appointment' },
    { text: 'hello', expected: 'unknown' }
  ];
  
  for (const t of tests) {
    const r = await detectIntent(t.text, 'test-1', 'clinic-1');
    const status = r.intent === t.expected ? '✅' : '❌';
    console.log(status + ' "' + t.text + '" → ' + r.intent + ' (' + r.confidence + ')');
  }
  
  console.log('\nBasic tests complete!');
}

test().catch(console.error);
