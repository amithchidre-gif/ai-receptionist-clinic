-- 002_call_log_latency.sql
-- Adds latency measurement columns to call_logs for voice pipeline testing.

ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS avg_latency_ms INTEGER;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS turn_count     INTEGER DEFAULT 0;
