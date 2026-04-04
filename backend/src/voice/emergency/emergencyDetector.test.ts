import { detectEmergency, EMERGENCY_RESPONSE } from './emergencyDetector';

const tests: { input: string; expected: boolean; description: string }[] = [
  { input: "I have chest pain",                   expected: true,  description: "chest pain detected" },
  { input: "I want to book an appointment",        expected: false, description: "normal booking call" },
  { input: "she is having trouble breathing",      expected: true,  description: "trouble breathing detected" },
  { input: "he's unconscious",                     expected: true,  description: "unconscious detected" },
  { input: "",                                     expected: false, description: "empty string" },
  { input: "I'm calling about my prescription",   expected: false, description: "prescription call" },
  { input: "I think I had a stroke",               expected: true,  description: "stroke detected" },
  { input: "CHEST PAIN SINCE THIS MORNING",        expected: true,  description: "case insensitive match" },
  // Extra coverage
  { input: "heart attack",                         expected: true,  description: "heart attack" },
  { input: "cannot breathe",                       expected: true,  description: "cannot breathe" },
  { input: "shortness of breath",                  expected: true,  description: "shortness of breath" },
  { input: "severe bleeding",                      expected: true,  description: "severe bleeding" },
  { input: "face drooping and arm weakness",       expected: true,  description: "stroke symptoms" },
  { input: "unresponsive and not breathing",       expected: true,  description: "unresponsive" },
  { input: "choking on food",                      expected: true,  description: "choking" },
  { input: "I want to kill myself",                expected: true,  description: "suicide ideation" },
  { input: "I think I overdosed",                  expected: true,  description: "overdose" },
  { input: "can we reschedule my appointment",     expected: false, description: "reschedule — no emergency" },
];

let passed = 0;
let failed = 0;

console.log("=== emergencyDetector.ts test run ===\n");

for (const t of tests) {
  const result = detectEmergency(t.input);
  const ok = result === t.expected;
  if (ok) {
    console.log(`  PASS  [${t.description}]`);
    passed++;
  } else {
    console.error(`  FAIL  [${t.description}]`);
    console.error(`        input:    "${t.input}"`);
    console.error(`        expected: ${t.expected}`);
    console.error(`        got:      ${result}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);

console.log("\n--- EMERGENCY_RESPONSE constant ---");
console.log(EMERGENCY_RESPONSE);

if (failed > 0) process.exit(1);
