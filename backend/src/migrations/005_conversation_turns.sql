-- 005_conversation_turns.sql
-- Per-turn debugging table for the voice pipeline.
--
-- transcript_text and response_text are PHI — they are only populated when
-- STORE_TRANSCRIPTS=true is set in the environment (HIPAA opt-in).
-- All other columns (latency breakdown, state, turn_number) are always stored
-- and are safe to query for performance analysis without enabling transcripts.

CREATE TABLE IF NOT EXISTS conversation_turns (
  id              UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id     UUID      REFERENCES call_logs(id) ON DELETE CASCADE,
  clinic_id       UUID      NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  session_id      TEXT      NOT NULL,
  turn_number     INTEGER   NOT NULL,
  state           TEXT      NOT NULL,
  transcript_text TEXT,     -- NULL unless STORE_TRANSCRIPTS=true (PHI)
  response_text   TEXT,     -- NULL unless STORE_TRANSCRIPTS=true (PHI)
  stt_ms          INTEGER,
  llm_ms          INTEGER,
  tts_wait_ms     INTEGER,
  logic_ms        INTEGER,
  tts_serial_ms   INTEGER,
  total_ms        INTEGER,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_call_log_id ON conversation_turns(call_log_id);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_clinic_id   ON conversation_turns(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_id  ON conversation_turns(session_id);
