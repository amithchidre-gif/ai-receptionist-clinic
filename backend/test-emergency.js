const { detectEmergency, EMERGENCY_RESPONSE } = require('./src/voice/emergency/emergencyDetector.ts');

console.log('=== Emergency Detector Tests ===\n');

const testCases = [
  { text: 'I have chest pain', expected: true },
  { text: 'I want to book an appointment', expected: false },
  { text: 'she is having trouble breathing', expected: true },
  { text: "he's unconscious", expected: true },
  { text: '', expected: false },
  { text: "I'm calling about my prescription", expected: false },
  { text: 'I think I had a stroke', expected: true },
  { text: 'CHEST PAIN SINCE THIS MORNING', expected: true },
  { text: 'My heart is racing', expected: false },
  { text: 'I took too many pills', expected: true },
];

testCases.forEach((test, i) => {
  const result = detectEmergency(test.text);
  const status = result === test.expected ? '✅' : '❌';
  console.log(${status} Test : "" →  (expected: ));
});

console.log(\nEmergency Response: );
