-- 004_add_indexes_for_latency.sql
-- Add indexes to optimize query latency for call_logs, patients, and appointments

CREATE INDEX IF NOT EXISTS idx_call_logs_clinic_created ON call_logs(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patients_clinic_phone ON patients(clinic_id, phone_number);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_date ON appointments(clinic_id, appointment_date);
