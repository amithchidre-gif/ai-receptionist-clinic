const { detectIntent } = require('./src/voice/intent-detection/intentService');

async function test() {
  console.log('=== Full Intent Test Suite ===\n');
  const tests = [
    { text: 'Book an appointment', expected: 'book_appointment' },
    { text: 'Cancel my appointment', expected: 'cancel_appointment' },
    { text: 'I need to reschedule', expected: 'reschedule_appointment' },
    { text: 'What are your hours?', expected: 'clinic_question' },
    { text: 'Hello', expected: 'unknown' },
  ];
  
  let passed = 0;
  for (const t of tests) {
    const r = await detectIntent(t.text, 'test-final', 'clinic-1');
    if (r.intent === t.expected) {
      console.log('✅', t.text, '→', r.intent);
      passed++;
    } else {
      console.log('❌', t.text, '→', r.intent, '(expected:', t.expected, ')');
    }
  }
  console.log('\n' + passed + '/' + tests.length + ' passed');
}
test().catch(console.error);
