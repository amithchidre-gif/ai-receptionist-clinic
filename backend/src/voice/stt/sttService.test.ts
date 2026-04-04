/**
 * sttService integration test script
 * Tests both functions, PHI discipline, error handling, and return shapes.
 * Run: npx ts-node src/voice/stt/sttService.test.ts
 */

import { ingestTranscriptText, SttResult } from './sttService';

// ─── test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const logs: { level: string; output: string }[] = [];

// Capture all console output so we can assert PHI policies
const origLog = console.log.bind(console);
const origError = console.error.bind(console);

console.log = (...args: any[]) => {
  const str = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logs.push({ level: 'info', output: str });
  origLog(...args);
};
console.error = (...args: any[]) => {
  const str = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logs.push({ level: 'error', output: str });
  origError(...args);
};

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    origLog(`  PASS  ${label}`);
    passed++;
  } else {
    origError(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failed++;
  }
}

function assertNoPhiInLogs(transcriptText: string, label: string) {
  const leakedLog = logs.find(l => l.output.includes(transcriptText));
  assert(!leakedLog, label,
    leakedLog ? `Transcript text found in log: ${leakedLog.output}` : undefined
  );
}

// ─── SECTION 1: ingestTranscriptText ──────────────────────────────────────────
origLog('\n=== Section 1: ingestTranscriptText ===\n');

const SAMPLE_TEXT = 'I have chest pain and need an appointment today';
const SESSION_A = 'session-ingest-001';

logs.length = 0; // reset log capture
const ingestResult: SttResult = ingestTranscriptText(SESSION_A, SAMPLE_TEXT);

assert(typeof ingestResult === 'object',                    '1.1  Returns an object');
assert(ingestResult.text === SAMPLE_TEXT,                   '1.2  text field equals input');
assert(ingestResult.confidence === 1.0,                     '1.3  confidence is 1.0');
assert(ingestResult.sessionId === SESSION_A,                '1.4  sessionId matches');

// PHI check — transcript text must NOT appear in any log
assertNoPhiInLogs(SAMPLE_TEXT, '1.5  Transcript text NOT logged (PHI rule)');

// Log structure check — must include charCount not text
const ingestLog = logs.find(l => {
  try { const p = JSON.parse(l.output); return p.event === 'stt_text_ingested'; } catch { return false; }
});
assert(!!ingestLog,                                         '1.6  Log entry emitted for ingest');
if (ingestLog) {
  const parsed = JSON.parse(ingestLog.output);
  assert(parsed.charCount === SAMPLE_TEXT.length,           '1.7  Log contains charCount = correct length');
  assert(!('text' in parsed),                               '1.8  Log does NOT contain text field');
  assert(!('transcript' in parsed),                         '1.9  Log does NOT contain transcript field');
}

// Edge: empty string
logs.length = 0;
const emptyResult = ingestTranscriptText('session-empty', '');
assert(emptyResult.text === '',                             '1.10 Empty string: text is empty');
assert(emptyResult.confidence === 1.0,                     '1.11 Empty string: confidence still 1.0');

// ─── SECTION 2: transcribeAudioBuffer — missing API key path ──────────────────
origLog('\n=== Section 2: transcribeAudioBuffer (missing API key) ===\n');

// Dynamically import so we can delete the env var before the call
async function testMissingApiKey() {
  delete process.env.DEEPGRAM_API_KEY;

  // Re-import after env change (ts-node caches modules — use direct call instead)
  // Since module is already loaded, call the exported function directly
  const { transcribeAudioBuffer } = await import('./sttService');

  logs.length = 0;
  const fakeBuffer = Buffer.from('fake audio data');
  const result = await transcribeAudioBuffer(fakeBuffer, 'session-nokey-001');

  assert(result.text === '',                                '2.1  No API key: text is empty string');
  assert(result.confidence === 0,                          '2.2  No API key: confidence is 0');
  assert(result.sessionId === 'session-nokey-001',         '2.3  No API key: sessionId preserved');

  const errLog = logs.find(l => {
    try { const p = JSON.parse(l.output); return p.event === 'stt_config_error'; } catch { return false; }
  });
  assert(!!errLog,                                          '2.4  Error logged for missing API key');
  if (errLog) {
    const parsed = JSON.parse(errLog.output);
    assert(parsed.level === 'error',                        '2.5  Log level is "error"');
    assert(parsed.sessionId === 'session-nokey-001',        '2.6  sessionId in error log');
    assert(!('text' in parsed),                             '2.7  No text field in error log (PHI)');
  }
  // PHI: even in error path, no audio/transcript leakage
  assert(!logs.some(l => l.output.includes('fake audio')), '2.8  Audio buffer content NOT logged (PHI)');
}

// ─── SECTION 3: transcribeAudioBuffer — Deepgram API error path ───────────────
origLog('\n=== Section 3: transcribeAudioBuffer (mocked API error) ===\n');

async function testApiError() {
  // Monkey-patch createClient to simulate a Deepgram API error response
  const sdkModule = require('@deepgram/sdk');
  const originalCreateClient = sdkModule.createClient;

  sdkModule.createClient = () => ({
    listen: {
      prerecorded: {
        transcribeFile: async () => ({
          result: null,
          error: { message: 'Invalid API key' },
        }),
      },
    },
  });

  // Force module re-eval by deleting cache entry and reimporting
  const modulePath = require.resolve('./sttService');
  delete require.cache[modulePath];
  const { transcribeAudioBuffer: transcribeWithMock } = require('./sttService');

  process.env.DEEPGRAM_API_KEY = 'mock-key-for-test';
  logs.length = 0;

  const result = await transcribeWithMock(Buffer.from('audio'), 'session-apierror-001');

  assert(result.text === '',                               '3.1  API error: text is empty');
  assert(result.confidence === 0,                         '3.2  API error: confidence is 0');
  assert(result.sessionId === 'session-apierror-001',     '3.3  API error: sessionId preserved');

  const errLog = logs.find(l => {
    try { const p = JSON.parse(l.output); return p.event === 'stt_api_error'; } catch { return false; }
  });
  assert(!!errLog,                                         '3.4  API error logged');
  if (errLog) {
    const parsed = JSON.parse(errLog.output);
    assert(parsed.message === 'Invalid API key',           '3.5  Error message captured');
    assert(parsed.sessionId === 'session-apierror-001',   '3.6  sessionId in error log');
  }

  sdkModule.createClient = originalCreateClient;
  delete require.cache[modulePath];
}

// ─── SECTION 4: transcribeAudioBuffer — successful response path ──────────────
origLog('\n=== Section 4: transcribeAudioBuffer (mocked success) ===\n');

async function testSuccess() {
  const MOCK_TRANSCRIPT = 'Hello I would like to book an appointment';
  const sdkModule = require('@deepgram/sdk');
  const originalCreateClient = sdkModule.createClient;

  sdkModule.createClient = () => ({
    listen: {
      prerecorded: {
        transcribeFile: async () => ({
          result: {
            results: {
              channels: [{
                alternatives: [{
                  transcript: MOCK_TRANSCRIPT,
                  confidence: 0.98,
                }],
              }],
            },
          },
          error: null,
        }),
      },
    },
  });

  const modulePath = require.resolve('./sttService');
  delete require.cache[modulePath];
  const { transcribeAudioBuffer: transcribeSuccess } = require('./sttService');

  process.env.DEEPGRAM_API_KEY = 'mock-key-for-test';
  logs.length = 0;

  const result = await transcribeSuccess(Buffer.from('real audio'), 'session-success-001');

  assert(result.text === MOCK_TRANSCRIPT,                  '4.1  Success: text matches transcript');
  assert(result.confidence === 0.98,                      '4.2  Success: confidence matches');
  assert(result.sessionId === 'session-success-001',      '4.3  Success: sessionId preserved');

  // PHI: transcript must NOT appear in any log
  assertNoPhiInLogs(MOCK_TRANSCRIPT,                       '4.4  Transcript NOT logged (PHI rule)');

  const successLog = logs.find(l => {
    try { const p = JSON.parse(l.output); return p.event === 'stt_transcribed'; } catch { return false; }
  });
  assert(!!successLog,                                     '4.5  Success log entry emitted');
  if (successLog) {
    const parsed = JSON.parse(successLog.output);
    assert(parsed.charCount === MOCK_TRANSCRIPT.length,   '4.6  Log has charCount');
    assert(parsed.confidence === 0.98,                    '4.7  Log has confidence');
    assert(!('text' in parsed),                           '4.8  Log has NO text field (PHI)');
    assert(!('transcript' in parsed),                     '4.9  Log has NO transcript field (PHI)');
  }

  sdkModule.createClient = originalCreateClient;
  delete require.cache[modulePath];
}

// ─── SECTION 5: SttResult shape validation ────────────────────────────────────
origLog('\n=== Section 5: SttResult shape ===\n');

function validateShape(result: SttResult, label: string) {
  assert(typeof result.text === 'string',           `${label} — text is string`);
  assert(typeof result.confidence === 'number',     `${label} — confidence is number`);
  assert(typeof result.sessionId === 'string',      `${label} — sessionId is string`);
  assert(result.confidence >= 0 && result.confidence <= 1, `${label} — confidence in [0,1]`);
}

validateShape(ingestTranscriptText('s1', 'hello'),  '5.1 ingest normal');
validateShape(ingestTranscriptText('s2', ''),       '5.2 ingest empty');

// ─── RUN ALL ASYNC TESTS ───────────────────────────────────────────────────────
(async () => {
  try {
    await testMissingApiKey();
    await testApiError();
    await testSuccess();
  } catch (e: any) {
    origError('Unhandled test error:', e.message);
    failed++;
  }

  origLog('\n════════════════════════════════════════');
  origLog(`  ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
  origLog('════════════════════════════════════════\n');

  if (failed > 0) {
    origError(`${failed} test(s) failed.`);
    process.exit(1);
  } else {
    origLog('All assertions passed ✓');
  }
})();
