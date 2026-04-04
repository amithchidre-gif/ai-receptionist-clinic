import dotenv from 'dotenv';
dotenv.config();

import { spellName } from './conversationManager';

let pass = 0;
let fail = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== Conversation Manager — Helper Tests ===\n');

// --- spellName ---
console.log('--- spellName ---');
assert('single name', spellName('Sarah') === 'S - A - R - A - H');
assert('full name', spellName('John Smith') === 'J - O - H - N, \u2014 S - M - I - T - H');
assert('trimmed', spellName('  Amy  ') === 'A - M - Y');

console.log(`\n=== Results: ${pass}/${pass + fail} passed ===`);
if (fail > 0) process.exit(1);
