# AI Receptionist Platform — Architecture Reference
# This file describes HOW the system is built. Read before designing any new component.

---

## SYSTEM OVERVIEW

```
┌──────────────────────────────────────────────────────────┐
│                    PATIENT LAYER                          │
│         Phone Call          SMS          Web Form         │
└────────────┬────────────────┬───────────────┬────────────┘
						 │                │               │
						 ▼                │               │
┌────────────────────┐        │               │
│   TELNYX GATEWAY   │        │               │
│  (Calls + SMS out) │        │               │
└────────────┬───────┘        │               │
						 │ webhook        │               │
						 ▼                │               │
┌──────────────────────────────────────────────────────────┐
│                     BACKEND (Express + Node.js)           │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              VOICE PIPELINE                          │ │
│  │                                                      │ │
│  │  Emergency ──► STT (Deepgram) ──► Intent (OpenAI)  │ │
│  │     Detector        │                   │            │ │
│  │        │            ▼                   ▼            │ │
│  │        │     Conversation Manager (State Machine)   │ │
│  │        │            │                               │ │
│  │        └───────────►▼                               │ │
│  │                    TTS (ElevenLabs) ──► Audio out  │ │
│  └─────────────────────┬───────────────────────────────┘ │
│                         │                                 │
│  ┌──────────────────────▼───────────────────────────────┐ │
│  │             WORKFLOW LAYER (direct function calls)    │ │
│  │                                                       │ │
│  │  Google Calendar ── SMS Service ── Form Token Gen    │ │
│  └──────────────────────┬────────────────────────────────┘ │
│                          │                                 │
│  ┌───────────────────────▼──────────────────────────────┐ │
│  │              DATA LAYER                               │ │
│  │   PostgreSQL (pg) ────────── Redis (ioredis)         │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
						 │                                  ▲
						 │ REST API                         │
						 ▼                                  │
┌──────────────────────────────────────────────────────────┐
│                  FRONTEND (Next.js)                       │
│   Dashboard / Appointments / Patients / Calls / Forms     │
└──────────────────────────────────────────────────────────┘
```

---

## VOICE PIPELINE — DETAILED

### How a single conversation turn works:

```typescript
// 1. Telnyx sends webhook with transcript text
POST /voice/telnyx/webhook
	payload.event_type = 'call.transcription'
	payload.transcription_data.transcript = "I want to book an appointment"

// 2. voiceController extracts data, calls pipeline
const result = await runPipelineTurn({
	sessionId: callControlId,
	clinicId,            // looked up from phone number
	transcriptFragment: transcript
});

// 3. Inside runPipelineTurn():
//    a. Emergency check (always first)
if (detectEmergency(transcript)) {
	return { responseText: EMERGENCY_RESPONSE, state: 'handoff' };
}

//    b. Get/create session
const session = await getOrCreateSession(sessionId, clinicId);

//    c. Detect intent (only in intent_detection state)
if (session.state === 'intent_detection') {
	const intent = await detectIntent(transcript, sessionId, clinicId);
	session.intent = intent.intent;
	session.state = transitionFromIntent(intent);
}

//    d. State machine processes current state
const responseText = await processState(session, transcript);

//    e. Synthesize response
const ttsResult = await synthesize({ text: responseText, sessionId, clinicId });

//    f. Save session to DB
await saveSession(session);

//    g. Return
return { responseText, state: session.state, ttsResult };
```

### Session State Object (in memory + DB):

```typescript
interface ConversationSession {
	sessionId: string;
	clinicId: string;
	callLogId: string | null;
	state: ConversationState;
	intent: IntentType | null;
	turnCount: number;
	failedIntentAttempts: number;

	// Identity collection
	collectedData: {
		name?: string;
		dateOfBirth?: string;
		phone?: string;
	};
	identityVerified: boolean;
	verifiedPatientId: string | null;
	verificationAttempts: number;

	// Booking
	bookingDate: string | null;   // "2026-05-01"
	bookingTime: string | null;   // "10:00"
	bookingConfirmed: boolean;
	lastAppointmentId: string | null;

	// Meta
	createdAt: Date;
	updatedAt: Date;
}
```

---

## MULTI-TENANCY ARCHITECTURE

### How clinic isolation works:

```
Telnyx number "+15550001111"
		→ clinic_settings.telnyx_phone_number = "+15550001111"
		→ clinic_settings.clinic_id = "uuid-for-clinic-A"
		→ All data for this call uses clinic_id = "uuid-for-clinic-A"

JWT token payload: { userId, clinicId, role }
		→ Every authenticated request: req.user.clinicId
		→ Every DB query: WHERE clinic_id = req.user.clinicId
		→ Cross-clinic access: impossible by design
```

### DB row example:
```sql
-- Clinic A patient
INSERT INTO patients (id, clinic_id, name, phone)
VALUES (gen_random_uuid(), 'clinic-A-uuid', 'Sarah Johnson', '+15551234567');

-- Clinic B patient (same phone number — different clinic)
INSERT INTO patients (id, clinic_id, name, phone)
VALUES (gen_random_uuid(), 'clinic-B-uuid', 'Sarah Johnson', '+15551234567');

-- These are completely separate records — correct by design
-- A query for clinic A will NEVER return clinic B's patient
```

---

## AUTHENTICATION FLOW

```
POST /api/auth/register
	body: { email, password, clinicName }
	1. Hash password (bcrypt, rounds=12)
	2. INSERT into clinics: { name: clinicName }
	3. INSERT into users: { email, passwordHash, clinicId }
	4. INSERT into clinic_settings: { clinicId } (defaults)
	5. Sign JWT: { userId, clinicId, role: 'admin' }
	6. Return: { token, clinicId }

POST /api/auth/login
	body: { email, password }
	1. SELECT user by email
	2. bcrypt.compare(password, user.passwordHash)
	3. Sign JWT
	4. Return: { token, clinicId, email }

All protected routes:
	Authorization: Bearer <token>
	→ auth middleware verifies JWT
	→ attaches req.user = { userId, clinicId, role }
	→ controller uses req.user.clinicId for all queries
```

---

## GOOGLE CALENDAR INTEGRATION

### Setup per clinic:
1. Clinic shares their Google Calendar with the service account email
2. Clinic admin adds calendar ID to settings page
3. Backend uses service account to read/write that calendar

```typescript
// Auth pattern
const auth = new google.auth.GoogleAuth({
	keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
	scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// Create event
await calendar.events.insert({
	calendarId: clinic.googleCalendarId,
	requestBody: {
		summary: `Appointment — ${patientName}`,
		start: { dateTime: startISO, timeZone: 'UTC' },
		end: { dateTime: endISO, timeZone: 'UTC' },
	}
});
```

### Conflict checking:
```typescript
// Check if slot is free
const events = await calendar.events.list({
	calendarId: clinicCalendarId,
	timeMin: slotStart.toISOString(),
	timeMax: slotEnd.toISOString(),
	singleEvents: true,
});
const hasConflict = events.data.items.length > 0;
```

---

## SMS FLOW (Telnyx Messaging)

```typescript
// Send SMS
const response = await telnyx.messages.create({
	from: clinicTelnyxNumber,   // from clinic_settings
	to: patientPhone,
	text: message,
});

// After booking confirmed, two SMS messages are sent:
// 1. Confirmation: "Your appointment is confirmed for [date] at [time]..."
// 2. Form link: "Please complete your intake form: [URL]"

// After booking, one scheduled job:
// Reminder: runs every 30 min, finds appointments for tomorrow,
//           sends reminder SMS, marks reminder_sent = true
```

---

## FORM TOKEN SYSTEM

```
Booking confirmed
		↓
createFormToken({ clinicId, appointmentId, patientId })
		→ generates crypto.randomBytes(32).toString('hex')
		→ stores in form_tokens with expires_at = appointment_date - 1 day
		→ returns token string
		↓
Send SMS: FRONTEND_URL + '/intake/' + token
		↓
Patient opens link
		↓
GET /form/:token (backend)
		→ validates token (exists, not expired, not used)
		→ returns prefill: { patientName, dob, appointmentDate, appointmentTime }
		↓
Patient submits form
		↓
POST /api/forms/submit
		→ re-validates token
		→ saves to form_responses (JSONB)
		→ marks token used
		→ generates PDF (pdfkit)
		→ saves PDF to /tmp/forms/appointmentId.pdf
		→ marks appointment.form_completed = true
```

---

## REMINDER SCHEDULER

```typescript
// Runs every 30 minutes
// Finds appointments WHERE:
//   status = 'scheduled'
//   AND appointment_date = CURRENT_DATE + 1
//   AND reminder_sent = false

// For each: send SMS reminder, mark reminder_sent = true
// This is a simple setInterval — no complex queue for MVP
```

---

## FRONTEND PAGE MAP

```
/login              — public, email + password form
/dashboard          — protected, stats + recent calls
/appointments       — protected, list + cancel action
/patients           — protected, list + search + detail panel
/calls              — protected, call logs table
/forms              — protected, submitted forms + PDF download
/settings           — protected, clinic configuration
/intake/[token]     — public, patient intake form (no login)
```

---

## GCP PRODUCTION SETUP

```
Cloud Run:     backend service (stateless — session state in Redis + DB)
Cloud SQL:     PostgreSQL 15 (private IP, VPC connector)
Cloud Storage: form PDFs (replace /tmp in production)
Secret Manager: all API keys + DB credentials
Cloud Logging:  structured JSON logs
Cloud Run URL:  set as BACKEND_URL in Telnyx webhook config
```

---

## LOCAL DEVELOPMENT SETUP

```yaml
# docker-compose.yml
services:
	postgres:
		image: postgres:15
		environment:
			POSTGRES_DB: ai_receptionist
			POSTGRES_USER: postgres
			POSTGRES_PASSWORD: localpassword
		ports:
			- "5432:5432"

	redis:
		image: redis:7-alpine
		ports:
			- "6379:6379"
```

```bash
# Expose local backend to Telnyx
npx ngrok http 4000
# Copy HTTPS URL → Telnyx dashboard → Voice API → Webhook URL
```

---

## COST ESTIMATE (per clinic per month)

| Service | Usage assumption | Cost |
|---|---|---|
| Telnyx (calls) | 500 min/month at $0.004/min | ~$2 |
| Telnyx (SMS) | 200 SMS at $0.004 | ~$0.80 |
| Deepgram | 500 min at $0.0059/min | ~$3 |
| ElevenLabs | 50k chars at $0.30/1k | ~$15 |
| OpenAI GPT-4o-mini | 500 calls × 300 tokens | ~$0.10 |
| GCP Cloud Run | Low traffic | ~$5 |
| GCP Cloud SQL | db-f1-micro | ~$10 |
| **Total** | | **~$36/clinic/month** |

Charge clinics $200–500/month → healthy margin from day one.

---

## KNOWN LIMITATIONS AT LAUNCH

1. **Streaming audio:** We use batch transcription (Telnyx sends full utterance). Real-time streaming is v2.
2. **Multi-doctor scheduling:** MVP assumes one calendar per clinic. Multi-doctor in v2.
3. **Timezone:** All times stored as clinic-local strings. Proper timezone handling in v2.
4. **PDF storage:** Local /tmp in development. Needs GCS before production.
5. **Session recovery:** If backend restarts, in-memory sessions are lost. Redis-backed sessions in v2.
6. **Form expiry:** Currently expires_at is 48h. Should be tied to appointment date for accuracy.
