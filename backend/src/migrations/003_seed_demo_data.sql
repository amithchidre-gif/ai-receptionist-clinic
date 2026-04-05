-- 003_seed_demo_data.sql
-- Seeds the demo clinic, clinic settings, and admin user for production.
-- Safe to run multiple times (ON CONFLICT DO NOTHING).

-- Demo Clinic
INSERT INTO clinics (id, name, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Demo Clinic',
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Clinic settings: maps Telnyx phone number to this clinic
INSERT INTO clinic_settings (
  id,
  clinic_id,
  telnyx_phone_number,
  ai_enabled,
  created_at,
  updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  '+19257097010',
  TRUE,
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Admin user: email=admin@demo.com  password=admin123
-- Hash generated with bcrypt rounds=12
INSERT INTO users (
  id,
  clinic_id,
  email,
  password_hash,
  role,
  created_at
)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000001',
  'admin@demo.com',
  '$2b$12$9M9hP7lzuPFheJ/c99kdWuEePl00kU8cFMNvoLMiY2FL0biDITuo.',
  'admin',
  NOW()
)
ON CONFLICT (id) DO NOTHING;
