// Add this at the top of runTestScenarios.ts after the imports
function getFutureDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
/**
 * runTestScenarios.ts
 * Simulates standard call scripts against the live pipeline.
 *
 * Usage:
 *   npx ts-node src/scripts/runTestScenarios.ts
 *
 * Requires:
 *   - Backend running on http://localhost:4000
 *   - TEST_CLINIC_ID and TEST_JWT_TOKEN set in .env (or inherited environment)
 */

import dotenv from 'dotenv';
dotenv.config();

import axios, { AxiosError } from 'axios';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL       = process.env.TEST_BASE_URL ?? 'http://localhost:4000';
const CLINIC_ID      = process.env.TEST_CLINIC_ID ?? '';
const JWT_TOKEN      = process.env.TEST_JWT_TOKEN ?? '';
const TURN_DELAY_MS  = 500;

if (!CLINIC_ID) {
  console.error('TEST_CLINIC_ID is not set.');
  process.exit(1);
}
if (!JWT_TOKEN) {
  console.error('TEST_JWT_TOKEN is not set.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TurnResult {
  state: string;
  nextState: string;
  intent: string | null;
  responseText: string;
  callCompletedThisTurn: boolean;
}

interface ScenarioDefinition {
  name: string;
  turns: string[];
  expectedFinalState?: string;
  expectedResponseContains?: string;
  expectedIntentChange?: boolean;
  expectedSms?: boolean;   // informational — SMS is side-effect only, logged as note
}

interface ScenarioResult {
  name: string;
  passed: boolean;
  failReason?: string;
  durationMs: number;
  finalState?: string;
  finalIntent?: string | null;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Returns a date N days from today formatted as "Month D, YYYY" (e.g. "April 10, 2026"). */
function futureDateLabel(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Compute the booking date once so it's visible in debug output
const SCENARIO1_DATE = futureDateLabel(30);  // 30 days out — very unlikely to have existing bookings
const SCENARIO1_TIME = '3:15 PM';            // specific afternoon slot — low collision risk

const SCENARIOS: ScenarioDefinition[] = [
  {
    name: 'Normal booking (happy path)',
    turns: [
      '',
      'I want to book an appointment',
      'Sarah Johnson',
      'March 20 1985',
      '555 123 4567',
      SCENARIO1_DATE,
      SCENARIO1_TIME,
      'yes confirm',
    ],
    expectedFinalState: 'completed',
    expectedSms: true,
  },
  {
    name: 'Emergency detection',
    turns: [
      '',
      'I have severe chest pain and trouble breathing',
    ],
    expectedFinalState: 'handoff',
    expectedResponseContains: '911',
  },
  {
    name: 'Cancel appointment',
    turns: [
      '',
      'I need to cancel my appointment',
      'John Smith',
      'January 5 1990',
      '555 987 6543',
    ],
    expectedFinalState: 'completed',
  },
  {
    name: 'Unknown intent (3 strikes → handoff)',
    turns: [
      '',
      'um',
      'what',
      "I'm not sure",
    ],
    expectedFinalState: 'handoff',
  },
  {
    name: 'Mid-call pivot (book → cancel)',
    turns: [
      '',
      'I want to book an appointment',
      'Actually wait I need to cancel instead',
    ],
    expectedIntentChange: true,
  },
];

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postTurn(
  sessionId: string,
  transcriptFragment: string,
): Promise<TurnResult> {
  const body: Record<string, string> = { sessionId };
  // Empty string → greeting turn (no transcript)
  if (transcriptFragment !== '') {
    body.transcriptFragment = transcriptFragment;
  }

  const response = await axios.post<{ success: boolean; data: TurnResult }>(
    `${BASE_URL}/voice/pipeline/turn`,
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
      timeout: 30_000,
    },
  );

  if (!response.data.success) {
    throw new Error(`API returned success=false for turn "${transcriptFragment}"`);
  }
  return response.data.data;
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

async function runScenario(
  scenario: ScenarioDefinition,
  index: number,
): Promise<ScenarioResult> {
  const sessionId = `test-scenario-${index + 1}-${Date.now()}`;
  const startMs = Date.now();

  let lastResult: TurnResult | null = null;
  let firstIntent: string | null = null;
  let intentChanged = false;

  try {
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];

      if (i > 0) {
        await sleep(TURN_DELAY_MS);
      }

      lastResult = await postTurn(sessionId, turn);

      // Per-turn debug output
      const label = turn === '' ? '<greeting>' : `"${turn}"`;
      console.log(`    Turn ${i + 1}: ${label}`);
      console.log(`      → state=${lastResult.state}  nextState=${lastResult.nextState}  intent=${lastResult.intent ?? 'null'}`);
      console.log(`      → response: "${lastResult.responseText.slice(0, 80)}${lastResult.responseText.length > 80 ? '…' : ''}"`);

      // Track intent changes for scenario 5
      if (lastResult.intent !== null) {
        if (firstIntent === null) {
          firstIntent = lastResult.intent;
        } else if (lastResult.intent !== firstIntent) {
          intentChanged = true;
        }
      }

      // Stop early if pipeline already ended (e.g. emergency on turn 2)
      if (lastResult.callCompletedThisTurn && i < scenario.turns.length - 1) {
        break;
      }
    }
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;
    const message = err instanceof AxiosError
      ? `HTTP ${err.response?.status ?? '?'}: ${JSON.stringify(err.response?.data ?? err.message)}`
      : (err as Error).message;
    return {
      name: scenario.name,
      passed: false,
      failReason: `Request error — ${message}`,
      durationMs,
    };
  }

  const durationMs = Date.now() - startMs;
  const finalState   = lastResult?.nextState ?? lastResult?.state ?? 'unknown';
  const finalIntent  = lastResult?.intent ?? null;
  const responseText = lastResult?.responseText ?? '';

  // --- Assertions ---
  if (scenario.expectedFinalState && finalState !== scenario.expectedFinalState) {
    return {
      name: scenario.name,
      passed: false,
      failReason: `Expected final state "${scenario.expectedFinalState}" but got "${finalState}"`,
      durationMs,
      finalState,
      finalIntent,
    };
  }

  if (
    scenario.expectedResponseContains &&
    !responseText.toLowerCase().includes(scenario.expectedResponseContains.toLowerCase())
  ) {
    return {
      name: scenario.name,
      passed: false,
      failReason: `Expected response to contain "${scenario.expectedResponseContains}" but got: "${responseText}"`,
      durationMs,
      finalState,
      finalIntent,
    };
  }

  if (scenario.expectedIntentChange && !intentChanged) {
    return {
      name: scenario.name,
      passed: false,
      failReason: `Expected an intent change during the conversation but intent stayed "${firstIntent}"`,
      durationMs,
      finalState,
      finalIntent,
    };
  }

  return {
    name: scenario.name,
    passed: true,
    durationMs,
    finalState,
    finalIntent,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('');
  console.log('AI Receptionist — Test Scenario Runner');
  console.log(`Target:       ${BASE_URL}`);
  console.log(`Clinic:       ${CLINIC_ID}`);
  console.log(`Booking date: ${SCENARIO1_DATE}  at  ${SCENARIO1_TIME}`);
  console.log('──────────────────────────────────────────────────');

  const results: ScenarioResult[] = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    console.log(`\nScenario ${i + 1} — ${scenario.name}`);
    const result = await runScenario(scenario, i);
    results.push(result);
    console.log(result.passed ? '  → PASS' : `  → FAIL: ${result.failReason}`);
  }

  // ---------------------------------------------------------------------------
  // Summary table
  // ---------------------------------------------------------------------------

  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════');

  let passed = 0;
  let failed = 0;

  results.forEach((r, i) => {
    const label   = `Scenario ${i + 1} — ${r.name}`;
    const status  = r.passed ? 'PASS' : 'FAIL';
    const timing  = `(${(r.durationMs / 1000).toFixed(1)}s)`;
    const extra   = r.passed
      ? `state=${r.finalState}`
      : `REASON: ${r.failReason}`;

    const padded = label.padEnd(44);
    console.log(`  ${padded}  ${status}  ${timing}  ${extra}`);

    if (r.passed) passed++; else failed++;
  });

  console.log('──────────────────────────────────────────────────────────');
  console.log(`  Total: ${results.length}   PASS: ${passed}   FAIL: ${failed}`);
  console.log('══════════════════════════════════════════════════════════');
  console.log('');

  if (SCENARIOS.find((s) => s.expectedSms)) {
    console.log('  NOTE: SMS side-effects are not asserted — check Telnyx logs separately.');
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('Fatal error running test scenarios:', (err as Error).message);
  process.exit(1);
});
