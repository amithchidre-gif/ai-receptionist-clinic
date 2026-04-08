import { query } from '../config/db';

export interface ConversationTurn {
  id: string;
  callLogId: string | null;
  clinicId: string;
  sessionId: string;
  turnNumber: number;
  state: string;
  transcriptText: string | null;
  responseText: string | null;
  sttMs: number | null;
  llmMs: number | null;
  ttsWaitMs: number | null;
  logicMs: number | null;
  ttsSerialMs: number | null;
  totalMs: number | null;
  createdAt: Date;
}

export interface InsertTurnParams {
  callLogId: string | null;
  clinicId: string;
  sessionId: string;
  turnNumber: number;
  state: string;
  transcriptText: string | null;  // only set when STORE_TRANSCRIPTS=true
  responseText: string | null;    // only set when STORE_TRANSCRIPTS=true
  sttMs: number;
  llmMs: number;
  ttsWaitMs: number;
  logicMs: number;
  ttsSerialMs: number;
  totalMs: number;
}

export async function insertConversationTurn(params: InsertTurnParams): Promise<void> {
  await query(
    `INSERT INTO conversation_turns
       (call_log_id, clinic_id, session_id, turn_number, state,
        transcript_text, response_text,
        stt_ms, llm_ms, tts_wait_ms, logic_ms, tts_serial_ms, total_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      params.callLogId,
      params.clinicId,
      params.sessionId,
      params.turnNumber,
      params.state,
      params.transcriptText,
      params.responseText,
      params.sttMs,
      params.llmMs,
      params.ttsWaitMs,
      params.logicMs,
      params.ttsSerialMs,
      params.totalMs,
    ],
  );
}

export async function getTurnsByCallLogId(
  callLogId: string,
  clinicId: string,
): Promise<ConversationTurn[]> {
  const result = await query(
    `SELECT id, call_log_id, clinic_id, session_id, turn_number, state,
            transcript_text, response_text,
            stt_ms, llm_ms, tts_wait_ms, logic_ms, tts_serial_ms, total_ms, created_at
     FROM conversation_turns
     WHERE call_log_id = $1 AND clinic_id = $2
     ORDER BY turn_number ASC`,
    [callLogId, clinicId],
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    callLogId: (row.call_log_id as string) ?? null,
    clinicId: row.clinic_id as string,
    sessionId: row.session_id as string,
    turnNumber: row.turn_number as number,
    state: row.state as string,
    transcriptText: (row.transcript_text as string) ?? null,
    responseText: (row.response_text as string) ?? null,
    sttMs: (row.stt_ms as number) ?? null,
    llmMs: (row.llm_ms as number) ?? null,
    ttsWaitMs: (row.tts_wait_ms as number) ?? null,
    logicMs: (row.logic_ms as number) ?? null,
    ttsSerialMs: (row.tts_serial_ms as number) ?? null,
    totalMs: (row.total_ms as number) ?? null,
    createdAt: new Date(row.created_at as string),
  }));
}
