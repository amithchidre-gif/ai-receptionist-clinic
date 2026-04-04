/**
 * Quick test: verify collectedData is persisted in conversation_sessions.
 * Runs 3 turns (greeting → intent → name), then checks the DB row.
 */
import { randomUUID } from 'crypto';
import { runPipelineTurn, clearSession } from '../voice/conversation-manager/conversationManager';
import { query } from '../config/db';

const CLINIC_ID = '78de52b5-3895-4824-b970-2676eb668293';
const SID = `verify-cd-${randomUUID()}`;

async function main() {
  console.log('\n=== Verify collectedData Persistence ===\n');

  // Turn 1 — greeting
  await runPipelineTurn({ sessionId: SID, clinicId: CLINIC_ID, transcriptFragment: '' });
  // Turn 2 — intent
  await runPipelineTurn({ sessionId: SID, clinicId: CLINIC_ID, transcriptFragment: 'I want to book an appointment' });
  // Turn 3 — provide name
  await runPipelineTurn({ sessionId: SID, clinicId: CLINIC_ID, transcriptFragment: 'My name is Jane Doe' });

  // Check DB
  const r = await query(
    'SELECT session_data FROM conversation_sessions WHERE session_id = $1',
    [SID],
  );
  const data = r.rows[0]?.session_data;
  console.log('session_data:', JSON.stringify(data, null, 2));

  const hasCollectedData = data && typeof data.collectedData === 'object';
  const hasName = data?.collectedData?.name != null;

  console.log(`\n  collectedData present in DB: ${hasCollectedData ? 'YES' : 'NO'}`);
  console.log(`  collectedData.name set:      ${hasName ? 'YES — ' + data.collectedData.name : 'NO'}`);
  console.log(`\n  ${hasCollectedData && hasName ? 'PASS' : 'FAIL'}`);

  // Cleanup
  await query('DELETE FROM conversation_sessions WHERE session_id = $1', [SID]);
  clearSession(SID);
  process.exit(hasCollectedData && hasName ? 0 : 1);
}

main();
