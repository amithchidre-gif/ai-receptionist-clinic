import { synthesize, TtsResult } from './ttsService';

// ─── test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const capturedLogs: string[] = [];

const origLog   = console.log.bind(console);
const origError = console.error.bind(console);

console.log = (...args: any[]) => {
  const str = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  capturedLogs.push(str);
  origLog(...args);
};
console.error = (...args: any[]) => {
  const str = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  capturedLogs.push(str);
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

function assertShapeValid(result: TtsResult, label: string) {
  assert(typeof result.text === 'string',                                  `${label}: text is string`);
  assert(result.audioBuffer === null || Buffer.isBuffer(result.audioBuffer), `${label}: audioBuffer is Buffer or null`);
  assert(result.durationMs === undefined || typeof result.durationMs === 'number', `${label}: durationMs is number or undefined`);
}

function assertNoTextInLogs(text: string, label: string) {
  const leaked = capturedLogs.find(l => l.includes(text));
  assert(!leaked, label, leaked ? `PHI leaked in log: ${leaked}` : undefined);
}

// ─── SECTION 1: Missing API key ───────────────────────────────────────────────
async function testMissingApiKey() {
  origLog('\n=== Section 1: Missing INWORLD_API_KEY ===\n');
  const saved = process.env.INWORLD_API_KEY;
  delete process.env.INWORLD_API_KEY;

  capturedLogs.length = 0;
  const r = await synthesize({ text: 'Hello, book me an appointment.', sessionId: 'sess-nokey', clinicId: 'clinic-1' });

  assert(r.audioBuffer === null,                  '1.1  audioBuffer is null');
  assert(r.text === 'Hello, book me an appointment.', '1.2  text is preserved');
  assert(r.durationMs === undefined,              '1.3  durationMs is undefined');

  const errLog = capturedLogs.find(l => {
    try { return JSON.parse(l).event === 'tts_config_error'; } catch { return false; }
  });
  assert(!!errLog,                                '1.4  Error log emitted');
  if (errLog) {
    const p = JSON.parse(errLog);
    assert(p.level === 'error',                   '1.5  Log level is "error"');
    assert(p.sessionId === 'sess-nokey',          '1.6  sessionId in log');
    assert(p.clinicId === 'clinic-1',             '1.7  clinicId in log');
  }
  assertNoTextInLogs('Hello, book me an appointment.', '1.8  PHI: text NOT in any log');

  process.env.INWORLD_API_KEY = saved ?? '';
}

// ─── SECTION 2: Empty text ────────────────────────────────────────────────────
async function testEmptyText() {
  origLog('\n=== Section 2: Empty text ===\n');
  const saved = process.env.INWORLD_API_KEY;
  delete process.env.INWORLD_API_KEY;  // force offline path for this test

  capturedLogs.length = 0;
  const r = await synthesize({ text: '', sessionId: 'sess-empty', clinicId: 'clinic-1' });

  assert(r.audioBuffer === null,   '2.1  null audio (no API key)');
  assert(r.text === '',            '2.2  empty text preserved');
  assertShapeValid(r,              '2.3  shape valid for empty text');

  process.env.INWORLD_API_KEY = saved ?? '';
}

// ─── SECTION 3: Special characters ───────────────────────────────────────────
async function testSpecialChars() {
  origLog('\n=== Section 3: Special characters in text ===\n');
  const saved = process.env.INWORLD_API_KEY;
  delete process.env.INWORLD_API_KEY;

  const specialText = "It's Dr. O'Brien's clinic — call (555) 123-4567 & press #2.";
  capturedLogs.length = 0;
  const r = await synthesize({ text: specialText, sessionId: 'sess-special', clinicId: 'clinic-2' });

  assert(r.audioBuffer === null,        '3.1  null audio (no API key)');
  assert(r.text === specialText,        '3.2  special char text preserved exactly');
  assertShapeValid(r,                   '3.3  shape valid');
  assertNoTextInLogs(specialText,       '3.4  PHI: special char text NOT in any log');

  process.env.INWORLD_API_KEY = saved ?? '';
}

// ─── SECTION 4: Mocked API success ───────────────────────────────────────────
async function testMockedSuccess() {
  origLog('\n=== Section 4: Mocked API success response ===\n');

  const axiosModule = require('axios');
  const original = axiosModule.post;
  const fakeAudioBytes = Buffer.alloc(1024, 0xff);

  axiosModule.post = async () => {
    const { Readable } = require('stream');
    const b64 = fakeAudioBytes.toString('base64');
    const ndjson = JSON.stringify({ result: { audio: b64 }, error: null }) + '\n';
    const stream = Readable.from([Buffer.from(ndjson)]);
    return { data: stream, status: 200 };
  };

  // Force module reload so it picks up the mock
  const modulePath = require.resolve('./ttsService');
  delete require.cache[modulePath];
  const { synthesize: synthesizeMocked } = require('./ttsService');

  process.env.INWORLD_API_KEY = 'mock-key-for-test';
  capturedLogs.length = 0;

  const r = await synthesizeMocked({ text: 'Say hello to the patient.', sessionId: 'sess-success', clinicId: 'clinic-3' });

  assert(Buffer.isBuffer(r.audioBuffer),                '4.1  audioBuffer is a Buffer');
  assert(r.audioBuffer!.length === 1024,                '4.2  audioBuffer has correct byte length');
  assert(r.text === 'Say hello to the patient.',        '4.3  text preserved');
  assert(typeof r.durationMs === 'number',              '4.4  durationMs is number');
  assertNoTextInLogs('Say hello to the patient.',       '4.5  PHI: text NOT in success log');

  const successLog = capturedLogs.find(l => {
    try { return JSON.parse(l).event === 'tts_synthesized'; } catch { return false; }
  });
  assert(!!successLog,                                  '4.6  Success log emitted');
  if (successLog) {
    const p = JSON.parse(successLog);
    assert(p.byteLength === 1024,                       '4.7  Log has byteLength');
    assert(!('text' in p),                              '4.8  Log has NO text field (PHI)');
    assert(p.sessionId === 'sess-success',              '4.9  sessionId in log');
  }

  axiosModule.post = original;
  delete require.cache[modulePath];
}

// ─── SECTION 5: Mocked API failure ───────────────────────────────────────────
async function testMockedApiFailure() {
  origLog('\n=== Section 5: Mocked API failure (500 error) ===\n');

  const axiosModule = require('axios');
  const original = axiosModule.post;

  axiosModule.post = async () => { throw new Error('Request failed with status code 500'); };

  const modulePath = require.resolve('./ttsService');
  delete require.cache[modulePath];
  const { synthesize: synthesizeMocked } = require('./ttsService');

  process.env.INWORLD_API_KEY = 'mock-key-for-test';
  capturedLogs.length = 0;

  const r = await synthesizeMocked({ text: 'Patient name is John.', sessionId: 'sess-apifail', clinicId: 'clinic-4' });

  assert(r.audioBuffer === null,                        '5.1  null audio on API failure');
  assert(r.text === 'Patient name is John.',            '5.2  text preserved on failure');

  const errLog = capturedLogs.find(l => {
    try { return JSON.parse(l).event === 'tts_synthesis_failed'; } catch { return false; }
  });
  assert(!!errLog,                                      '5.3  Failure log emitted');
  if (errLog) {
    const p = JSON.parse(errLog);
    assert(p.error.includes('500'),                     '5.4  Error message captured');
    assert(!('text' in p),                              '5.5  Log has NO text field (PHI)');
    assert(p.sessionId === 'sess-apifail',              '5.6  sessionId in log');
  }
  assertNoTextInLogs('Patient name is John.',           '5.7  PHI: text NOT in failure log');

  axiosModule.post = original;
  delete require.cache[modulePath];
}

// ─── SECTION 6: TypeScript compile check ─────────────────────────────────────
async function testTypeScriptCompile() {
  origLog('\n=== Section 6: TypeScript interface shape ===\n');

  // Structural checks on TtsResult at type level (verified at runtime)
  const ok: TtsResult = { audioBuffer: null, text: 'x' };
  assert(ok.audioBuffer === null,     '6.1  TtsResult allows audioBuffer: null');
  assert(ok.text === 'x',            '6.2  TtsResult has text field');
  assert(!('durationMs' in ok) || typeof ok.durationMs === 'number', '6.3  durationMs optional');

  const withAudio: TtsResult = { audioBuffer: Buffer.alloc(10), text: 'y', durationMs: 250 };
  assert(Buffer.isBuffer(withAudio.audioBuffer), '6.4  TtsResult allows audioBuffer: Buffer');
  assert(withAudio.durationMs === 250,           '6.5  durationMs number accepted');
}

// ─── RUN ALL ──────────────────────────────────────────────────────────────────
(async () => {
  origLog('====================================');
  origLog('  ttsService.ts — full test suite  ');
  origLog('====================================');

  await testMissingApiKey();
  await testEmptyText();
  await testSpecialChars();
  await testMockedSuccess();
  await testMockedApiFailure();
  await testTypeScriptCompile();

  origLog('\n════════════════════════════════════════');
  origLog(`  ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
  origLog('════════════════════════════════════════\n');

  if (failed > 0) {
    origError(`${failed} test(s) FAILED.`);
    process.exit(1);
  } else {
    origLog('All assertions passed ✓');
  }
})().catch(e => {
  origError('Unhandled test error:', e.message);
  process.exit(1);
});
