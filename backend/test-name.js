const { extractName } = require('./src/voice/conversation-manager/conversationManager');

const tests = [
  'Sarah Johnson',
  'My name is Sarah Johnson',
  'I am Sarah Johnson',
  'Sarah',
  'John Smith',
  'Dr. Smith',
  'hello world'
];

console.log('=== Testing extractName ===\n');
tests.forEach(input => {
  const result = extractName(input);
  console.log(`Input: "${input}" -> Result: "${result || 'null'}"`);
});
