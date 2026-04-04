-- 001_initial_schema.sql
-- Full initial schema for AI Receptionist Platform
-- Run via: npm run migrate

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────
-- clinics
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- users  (admin accounts, one per clinic for MVP)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID      NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  email         TEXT      NOT NULL UNIQUE,
  password_hash TEXT      NOT NULL,
  role          TEXT      NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_clinic_id ON users(clinic_id);

-- ─────────────────────────────────────────
-- clinic_settings
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_settings (
  id                    UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             UUID      NOT NULL UNIQUE REFERENCES clinics(id) ON DELETE CASCADE,
  telnyx_phone_number   TEXT,
  google_calendar_id    TEXT,
  elevenlabs_voice_id   TEXT,
  ai_enabled            BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- patients
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patients (
  id            UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID      NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name          TEXT,
  phone         TEXT      NOT NULL,
  date_of_birth TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_patients_clinic_id ON patients(clinic_id);

-- ─────────────────────────────────────────
-- appointments
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        UUID    NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id       UUID    NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_date TEXT    NOT NULL,  -- "YYYY-MM-DD"
  appointment_time TEXT    NOT NULL,  -- "HH:MM"
  status           TEXT    NOT NULL DEFAULT 'scheduled'
                           CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  google_event_id  TEXT,
  reminder_sent    BOOLEAN NOT NULL DEFAULT FALSE,
  form_completed   BOOLEAN NOT NULL DEFAULT FALSE,
  created_via      TEXT    NOT NULL DEFAULT 'voice',
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_clinic_id          ON appointments(clinic_id);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_status_date ON appointments(clinic_id, status, appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_id         ON appointments(clinic_id, patient_id);

-- ─────────────────────────────────────────
-- call_logs
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_logs (
  id               UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        UUID      NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id       UUID      REFERENCES patients(id) ON DELETE SET NULL,
  call_control_id  TEXT,
  from_number      TEXT,
  to_number        TEXT,
  status           TEXT,
  duration_seconds INTEGER,
  started_at       TIMESTAMP,
  ended_at         TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_clinic_id  ON call_logs(clinic_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_created_at ON call_logs(clinic_id, created_at DESC);

-- ─────────────────────────────────────────
-- sms_logs
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_logs (
  id                UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID      NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id        UUID      REFERENCES patients(id) ON DELETE SET NULL,
  appointment_id    UUID      REFERENCES appointments(id) ON DELETE SET NULL,
  message_type      TEXT      NOT NULL,  -- 'confirmation' | 'reminder' | 'form_link'
  to_number         TEXT,
  status            TEXT,
  telnyx_message_id TEXT,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_logs_clinic_id     ON sms_logs(clinic_id);
CREATE INDEX IF NOT EXISTS idx_sms_logs_appointment_id ON sms_logs(clinic_id, appointment_id);

-- ─────────────────────────────────────────
-- form_tokens
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_tokens (
  id             UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID      NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id UUID      NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id     UUID      NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  token          TEXT      NOT NULL UNIQUE,
  expires_at     TIMESTAMP NOT NULL,
  used           BOOLEAN   NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_form_tokens_token          ON form_tokens(token);
CREATE INDEX IF NOT EXISTS idx_form_tokens_clinic_appt_id ON form_tokens(clinic_id, appointment_id);

-- ─────────────────────────────────────────
-- form_responses
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_responses (
  id             UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID      NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id UUID      NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id     UUID      NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  form_token_id  UUID      REFERENCES form_tokens(id) ON DELETE SET NULL,
  response_data  JSONB     NOT NULL DEFAULT '{}',
  pdf_path       TEXT,
  submitted_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_form_responses_clinic_id      ON form_responses(clinic_id);
CREATE INDEX IF NOT EXISTS idx_form_responses_appointment_id ON form_responses(clinic_id, appointment_id);

-- ─────────────────────────────────────────
-- conversation_sessions
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id           UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   TEXT      NOT NULL UNIQUE,
  clinic_id    UUID      NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  call_log_id  UUID      REFERENCES call_logs(id) ON DELETE SET NULL,
  state        TEXT      NOT NULL DEFAULT 'greeting',
  session_data JSONB     NOT NULL DEFAULT '{}',
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_session_id ON conversation_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_clinic_id  ON conversation_sessions(clinic_id);
