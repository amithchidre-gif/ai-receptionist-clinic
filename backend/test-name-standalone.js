// Standalone extractName function for testing
function extractName(text) {
  try {
    const patterns = [
      /my name is\s+(.+)/i,
      /this is\s+(.+)/i,
      /i'm\s+(.+)/i,
      /i am\s+(.+)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const raw = match[1]
          .replace(/[.,!?]+$/, '')
          .trim();
        if (raw.length === 0) continue;
        // Capitalize each word
        return raw.split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
      }
    }
    // If no pattern matches, check if the entire text looks like a name (2-3 words, all letters)
    const words = text.trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 3 && words.every(w => /^[A-Za-z]+$/.test(w))) {
      return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    return null;
  } catch {
    return null;
  }
}

console.log('=== Testing extractName ===\n');

const tests = [
  { input: 'Sarah Johnson', expected: 'Sarah Johnson' },
  { input: 'My name is Sarah Johnson', expected: 'Sarah Johnson' },
  { input: 'This is Sarah Johnson', expected: 'Sarah Johnson' },
  { input: "I'm Sarah Johnson", expected: 'Sarah Johnson' },
  { input: 'I am Sarah Johnson', expected: 'Sarah Johnson' },
  { input: 'Sarah', expected: 'Sarah' },
  { input: 'hello', expected: null },
  { input: 'John Smith', expected: 'John Smith' },
  { input: 'dr smith', expected: 'Dr Smith' },
];

let passed = 0;
tests.forEach(test => {
  const result = extractName(test.input);
  const status = result === test.expected ? '✅' : '❌';
  if (result === test.expected) passed++;
  console.log(`${status} "${test.input}" → ${result || 'null'} (expected: ${test.expected || 'null'})`);
});

console.log(`\n${passed}/${tests.length} tests passed`);
