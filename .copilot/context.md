# AI Receptionist Platform — Project Context
# Update this file at the END of each phase with what was built and what IDs/values to carry forward.
# Every model reads this before starting work.

---

## PROJECT IDENTITY

**Product name:** AI Receptionist Platform
**Type:** Multi-tenant B2B SaaS
**Target customer:** Medical clinics (1–5 doctors)
**Core promise:** Replace the human receptionist for inbound calls, booking, and intake forms

**Monetisation:** Manual invoicing for first 5 clinics. Stripe comes later.
**Launch target:** First real clinic onboarded, not public launch.

---

## CURRENT BUILD STATUS

Update this section at the end of every phase.

```
Phase 0 — Scaffolding:          [x] COMPLETE
Phase 1 — Voice Pipeline:       [ ] NOT STARTED
Phase 2 — Calendar + Booking:   [ ] NOT STARTED
Phase 3 — SMS:                  [ ] NOT STARTED
Phase 4 — Intake Forms:         [ ] NOT STARTED
Phase 5 — Dashboard:            [ ] NOT STARTED
```

---

## ACTIVE CREDENTIALS (fill in as you create accounts)

```
TELNYX_PHONE_NUMBER=         (the number patients call)
TEST_CLINIC_ID=78de52b5-3895-4824-b970-2676eb668293
TEST_USER_EMAIL=admin@testclinic.com
TEST_JWT_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIzN2Q4ODRhMi01NTY3LTRhMzItODExMy00Y2VmODQ1NzJjZTAiLCJjbGluaWNJZCI6Ijc4ZGU1MmI1LTM4OTUtNDgyNC1iOTcwLTI2NzZlYjY2ODI5MyIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc3NDM4ODQxNSwiZXhwIjoxNzc0OTkzMjE1fQ.eoz3P6V8HQrZc42Z1uUYKfEZUnbbafN16EizfpIPX3w
TEST_PATIENT_ID=e3556ee7-66f4-4858-b389-990f50137f1a
TEST_APPOINTMENT_ID=74330ed7-bea9-408d-acb3-4655f3b9459c
TEST_FORM_TOKEN=c761c22c22af46f24e24e8e1bb5f10806d53c2e83e975245232d71654d751801
GOOGLE_CALENDAR_ID=          (fill from Google Calendar settings)
```

---

## DECISIONS MADE (don't re-debate these)

| Decision | Choice | Reason |
|---|---|---|
| LLM for intent | GPT-4o-mini | Cheapest model that reliably returns structured JSON |
| STT | Deepgram nova-2 | Best accuracy/price for medical conversations |
| TTS | ElevenLabs | Most natural voice for receptionist use case |
| Calendar | Google Calendar | GCP ecosystem, HIPAA BAA available |
| SMS + Voice | Telnyx | Cheaper than Twilio, good streaming API |
| ORM | None — raw pg | Keep it simple, full SQL control |
| State storage | In-memory Map + PostgreSQL | Memory for speed, DB for persistence/restart recovery |
| Frontend routing | Next.js pages router | Simpler than app router for this use case |
| PDF | pdfkit | Already a dependency, no external service needed |

---

## KNOWN ISSUES / WATCH OUT FOR

Update this as you discover problems during builds.

```
[OPEN]  Google Calendar: service account needs to be shared on each clinic's calendar
[OPEN]  Telnyx: webhook URL must be publicly accessible (use ngrok for local dev)
[OPEN]  ElevenLabs: free tier has character limits — upgrade before first clinic demo
[OPEN]  Deepgram: streaming vs batch — we use batch for MVP (streaming in v2)
[FIXED] PostgreSQL port: Windows has PG16 on :5432 and PG18 on :5433 — Docker mapped to :5435 to avoid conflict
```

---

## API ENDPOINTS (fill in as each phase completes)

### Auth
```
POST /api/auth/register     — create clinic + admin user
POST /api/auth/login        — returns JWT token
```

### Voice (no auth — called by Telnyx)
```
POST /voice/telnyx/webhook  — receives all Telnyx call events
POST /voice/pipeline/turn   — manual pipeline turn (for testing)
```

### Appointments (auth required)
```
GET  /api/appointments      — list with optional ?status= ?date= filters
PATCH /api/appointments/:id/cancel
```

### Patients (auth required)
```
GET  /api/patients          — list with optional ?search= filter
GET  /api/patients/:id      — single patient with appointment history
```

### Call Logs (auth required)
```
GET  /api/call-logs         — list, last 100, most recent first
```

### Forms (mixed auth)
```
GET  /form/:token           — public, validates token, returns prefill data
POST /api/forms/submit      — public, submits form response
GET  /api/forms             — auth required, list submitted forms
GET  /api/forms/:id/pdf     — auth required, download PDF
```

### Dashboard (auth required)
```
GET  /api/dashboard         — stats summary
```

### Settings (auth required)
```
GET  /api/settings
PUT  /api/settings
```

---

## DATA FLOW (how data moves through the system)

```
Patient calls Telnyx number
	→ Telnyx fires webhook to /voice/telnyx/webhook
	→ call.initiated: create call_log, find clinic from phone number
	→ call.answered: start session, run greeting turn
	→ call.transcription: run pipeline turn per utterance
		→ Emergency check (returns immediately if detected)
		→ STT (if audio chunk) or passthrough (if text)
		→ Intent detection via GPT-4o-mini
		→ State machine processes intent
		→ If booking confirmed:
			→ Upsert patient in DB
			→ Check Google Calendar slot
			→ Create Calendar event
			→ Create appointment in DB
			→ Send confirmation SMS (Telnyx)
			→ Send form link SMS (Telnyx)
		→ TTS synthesizes response (ElevenLabs)
		→ Audio returned to Telnyx
	→ call.hangup: update call_log, clear session
    
Patient receives SMS with form link
	→ Opens /intake/:token in browser
	→ Frontend validates token with backend
	→ Patient fills form, submits
	→ Backend saves to form_responses
	→ Backend generates PDF
	→ Appointment marked form_completed = true

Clinic admin opens dashboard
	→ Sees today's calls, appointments, patients
	→ Can cancel appointments
	→ Can download intake PDFs
	→ Can configure settings (Telnyx number, calendar ID)
```

---

## VOICE CONVERSATION STATE MACHINE

```
START
  │
  ▼
greeting ──────────────────────────────────────────────► intent_detection
															  │
						┌─────────────────────────────────────┤
						│         │              │             │
						▼         ▼              ▼             ▼
				   book_appt  cancel_appt  reschedule    clinic_question
						│         │              │
						▼         ▼              ▼
				  identity_verification (all 3 need ID)
						│
						▼
				   booking_flow ◄── awaiting_date ◄── awaiting_time
						│
						▼
					completed ──► (new input resets to intent_detection)
                    
Any state ──► handoff (staff transfer, after 3 failures, or on request)
Any utterance ──► emergency (highest priority, always checked first)
```

---

## DATABASE TABLES (fill in row counts as you build)

```
clinics                 — one row per subscribed clinic
users                   — admin users for each clinic
clinic_settings         — config per clinic (phone, calendar, AI toggle)
patients                — one row per unique caller per clinic
appointments            — every booked appointment
call_logs               — every inbound call
sms_logs                — every SMS sent
form_tokens             — one-time tokens for intake form links
form_responses          — submitted form data (JSONB)
conversation_sessions   — voice session state (persisted for recovery)
```

---

## ENVIRONMENT VARIABLES NEEDED

```bash
# backend/.env
DATABASE_URL=postgresql://postgres:localpassword@localhost:5435/ai_receptionist
JWT_SECRET=minimum-32-character-secret-key-here
TELNYX_API_KEY=KEY0...
TELNYX_PUBLIC_KEY=...
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
OPENAI_API_KEY=sk-...
GOOGLE_APPLICATION_CREDENTIALS=./google-calendar-sa.json
FRONTEND_URL=http://localhost:3000
PORT=4000
REDIS_URL=redis://localhost:6379
NODE_ENV=development

# frontend/.env.local
NEXT_PUBLIC_API_URL=http://localhost:4000
```

---

## LOCAL DEV SETUP

```bash
# Start dependencies
docker-compose up -d    # starts postgres + redis

# Backend
cd backend
npm install
npm run dev             # starts on port 4000

# Frontend
cd frontend
npm install
npm run dev             # starts on port 3000

# For Telnyx webhooks during local dev:
npx ngrok http 4000     # copy the https URL to Telnyx webhook settings
```

---

## PHASE COMPLETION LOG

Fill this in as you complete each phase:

### Phase 0 Complete — 2026-03-25
- What was built: Full monorepo scaffold, DB schema (10 tables), Express server + middleware, JWT auth system (register/login)
- Test result: POST /api/auth/register → 201 { success: true, data: { token, clinicId } } ✓
- TEST_CLINIC_ID: 78de52b5-3895-4824-b970-2676eb668293
- TEST_JWT_TOKEN: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIzN2Q4ODRhMi01NTY3LTRhMzItODExMy00Y2VmODQ1NzJjZTAiLCJjbGluaWNJZCI6Ijc4ZGU1MmI1LTM4OTUtNDgyNC1iOTcwLTI2NzZlYjY2ODI5MyIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc3NDM4ODQxNSwiZXhwIjoxNzc0OTkzMjE1fQ.eoz3P6V8HQrZc42Z1uUYKfEZUnbbafN16EizfpIPX3w

### Phase 1 Complete — [DATE]
- What was built:
- Test result (full 8-turn conversation):
- TEST_PATIENT_ID:

### Phase 2 Complete — [DATE]
- What was built:
- Test result (appointment in calendar + DB):
- TEST_APPOINTMENT_ID:

### Phase 3 Complete — [DATE]
- What was built:
- Test result (SMS received):

### Phase 4 Complete — [DATE]
- What was built:
- Test result (form submitted, PDF generated):
- TEST_FORM_TOKEN:

### Phase 5 Complete — [DATE]
- What was built:
- Test result (full E2E flow):
