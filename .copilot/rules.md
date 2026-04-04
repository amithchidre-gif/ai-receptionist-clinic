
# AI Receptionist Platform — Master Rules
# Read this file before generating ANY code.
# These rules apply to EVERY model, EVERY phase, EVERY file.

---

## 1. WHAT WE ARE BUILDING

A multi-tenant SaaS platform where medical clinics subscribe and get an AI voice receptionist that:
- Answers inbound phone calls automatically
- Books, cancels, and reschedules appointments
- Sends SMS confirmations and reminders
- Sends intake form links via SMS
- Gives clinic admins a web dashboard

One codebase. Many clinics. Every clinic is isolated from every other.

---

## 2. TECH STACK (NEVER DEVIATE)

```
Backend:   Node.js + TypeScript + Express
Frontend:  Next.js 14 + React 18 + TailwindCSS
Database:  PostgreSQL (pg library — no ORM)
Cache:     Redis (ioredis)
Voice:     Telnyx (calls + SMS) + Deepgram (STT) + ElevenLabs (TTS)
LLM:       OpenAI GPT-4o-mini (intent detection only)
Calendar:  Google Calendar API (googleapis)
Cloud:     GCP (Cloud Run + Cloud SQL + Secret Manager)
Auth:      JWT (jsonwebtoken + bcrypt)
PDF:       pdfkit
```

---

## 3. MULTI-TENANCY — THE MOST CRITICAL RULE

### Every single database table MUST have clinic_id.
### Every single query MUST filter by clinic_id.
### clinic_id ALWAYS comes from the verified JWT token — NEVER from the request body.

```typescript
// ✅ CORRECT — clinic_id from JWT
const { clinicId } = req.user; // set by auth middleware
const result = await db.query('SELECT * FROM patients WHERE clinic_id = $1', [clinicId]);

// ❌ WRONG — clinic_id from body (security vulnerability)
const { clinicId } = req.body;
```

If a query touches patient/appointment/call data and does NOT filter by clinic_id: it is a critical bug.

---

## 4. API RESPONSE FORMAT (ALWAYS)

Every single API endpoint must return this exact format:

```typescript
// Success
{ "success": true, "data": <any> }

// Error
{ "success": false, "error": "Human-readable message" }
```

```typescript
// Use these helpers — never res.json() directly
sendSuccess(res, data, statusCode = 200)
sendError(res, message, statusCode = 400)
```

HTTP status codes:
- 200: success
- 201: created
- 400: bad request / validation error
- 401: not authenticated
- 403: authenticated but not authorized
- 404: not found
- 410: gone (expired form links)
- 500: server error (never expose internals)

---

## 5. TYPESCRIPT RULES

```typescript
// ✅ Always — explicit types everywhere
async function getPatient(clinicId: string, patientId: string): Promise<Patient | null>

// ❌ Never — no 'any'
async function getPatient(clinicId: any, patientId: any): Promise<any>

// ✅ Always — interfaces for all shapes
interface Patient {
	id: string;
	clinicId: string;
	name: string;
	phone: string;
	dateOfBirth: string | null;
	createdAt: Date;
}

// ✅ Always — try/catch on every async function
async function createAppointment(params: CreateAppointmentParams): Promise<Appointment> {
	try {
		// ... logic
	} catch (error) {
		logger.error('createAppointment failed', { clinicId: params.clinicId, error });
		throw error;
	}
}
```

---

## 6. LOGGING RULES — PHI PROTECTION

PHI = Protected Health Information. Includes: patient names, DOB, phone numbers, medical info.

```typescript
// ✅ CORRECT — log IDs and operation names only
logger.info('Appointment created', { clinicId, appointmentId, createdVia: 'voice' });
logger.error('SMS send failed', { clinicId, messageType, error: err.message });

// ❌ NEVER — do not log PHI
logger.info('Patient booked', { name: patient.name, phone: patient.phone }); // WRONG
logger.error('TTS failed for', { text: responseText }); // WRONG — responseText may contain name
```

Log structure for every entry:
```typescript
{
	level: 'info' | 'warn' | 'error',
	service: 'conversationManager' | 'appointmentModel' | etc,
	message: string,
	clinicId?: string,
	sessionId?: string,
	appointmentId?: string,
	timestamp: ISO string
}
```

---

## 7. ERROR HANDLING RULES

```typescript
// ✅ External API calls (Telnyx, OpenAI, Google, ElevenLabs, Deepgram):
// - Always wrap in try/catch
// - Always have timeout (10 seconds max)
// - Log failure with service name and clinicId
// - NEVER crash the main flow due to external API failure
// - Return null or default value on failure

// ✅ Database calls:
// - Always wrap in try/catch
// - Log query failures with clinicId (never log the query params — may contain PHI)
// - Re-throw for controller to handle

// ✅ Voice pipeline specifically:
// - Emergency detection failure → log and continue (don't block call)
// - TTS failure → return text only (call still works, just no audio)
// - Calendar failure → log warning, proceed with booking
// - SMS failure → log warning, booking still confirmed
```

---

## 8. DATABASE RULES

```sql
-- Every migration file named: NNN_description.sql (e.g. 001_initial_schema.sql)
-- Location: backend/src/migrations/
-- Never modify existing migrations — create new ones
-- Never drop columns — only ADD IF NOT EXISTS
-- All IDs: UUID with gen_random_uuid()
-- All timestamps: TIMESTAMP DEFAULT NOW()
-- All foreign keys: explicitly declared
-- All multi-column lookups: have indexes
```

```typescript
// Use parameterized queries ALWAYS
await db.query('SELECT * FROM patients WHERE clinic_id = $1 AND phone = $2', [clinicId, phone]);

// NEVER string interpolation in queries
await db.query(`SELECT * FROM patients WHERE clinic_id = '${clinicId}'`); // SQL INJECTION RISK
```

---

## 9. SECURITY RULES

- Passwords: bcrypt with saltRounds = 12
- JWT: HS256, expires 7 days, secret from env var
- CORS: whitelist FRONTEND_URL only
- Helmet: always enabled
- Input validation: every endpoint validates required fields before processing
- Telnyx webhooks: validate signature (Telnyx-Signature header) in production
- Never expose: stack traces, internal errors, DB query details, other clinic data
- PHI never in: logs, error messages, JWT payload, URL params

---

## 10. FRONTEND RULES

```typescript
// ✅ All API calls go through apiClient.ts — never raw fetch
import { api } from '../services/apiClient';
const data = await api.get('/appointments');

// ✅ All pages have three states
if (loading) return <LoadingSpinner />;
if (error) return <ErrorMessage message={error} />;
if (data.length === 0) return <EmptyState message="No appointments yet" />;

// ✅ API URL always from env
const API_URL = process.env.NEXT_PUBLIC_API_URL;

// ❌ Never hardcode data
const appointments = [{ id: 1, name: 'John' }]; // WRONG — this is mock data

// ✅ TypeScript types for all API responses
interface AppointmentResponse {
	id: string;
	patientName: string;
	appointmentDate: string;
	appointmentTime: string;
	status: 'scheduled' | 'cancelled' | 'completed';
}
```

---

## 11. VOICE PIPELINE RULES

The voice pipeline is the core product. These rules protect it:

```
Call arrives → Emergency check (FIRST, always) → Intent detection → State machine → TTS
```

1. Emergency detection MUST run before ANYTHING else. No exceptions.
2. State machine is the source of truth — never let LLM control state directly.
3. LLM only detects intent — it does NOT write to DB, book appointments, or change state.
4. TTS failure must NOT fail the call — return text-only response.
5. Session state persists in memory + DB. Both must stay in sync.
6. A session MUST clear on call.hangup — no memory leaks.

---

## 12. FOLDER STRUCTURE (NEVER DEVIATE)

```
backend/src/
├── config/          — db.ts, env.ts, redis.ts
├── controllers/     — one file per route group
├── middleware/      — auth.ts, logging.ts, errorHandler.ts
├── migrations/      — NNN_description.sql files only
├── models/          — one file per table
├── routes/          — one file per route group
├── services/        — business logic, external APIs
└── voice/
		├── conversation-manager/   — conversationManager.ts (state machine)
		├── emergency/              — emergencyDetector.ts
		├── intent-detection/       — intentService.ts
		├── stt/                    — sttService.ts
		└── tts/                    — ttsService.ts

frontend/
├── components/      — reusable UI components
├── pages/           — Next.js pages
├── services/        — apiClient.ts
├── styles/          — globals.css
├── types/           — shared TypeScript interfaces
└── utils/           — auth.ts, format.ts
```

---

## 13. DO NOT BUILD (POST-LAUNCH)

These are explicitly excluded. If Copilot suggests them, refuse:

- EMR integration (Epic, athenahealth)
- Stripe or billing of any kind
- DocuSign or e-signature
- Retry queue dashboard UI
- Workflow orchestrator engine
- Event timeline UI
- Voice/chat simulator
- Advanced analytics page
- Rate limiting (add before public launch, not now)
- Outbound auto-dialing

---

## 14. WHAT "DONE" MEANS FOR EACH TASK

A task is complete when:
1. Code compiles with no TypeScript errors
2. The specific test in the test plan passes
3. No existing tests or endpoints are broken
4. No mock/hardcoded data remains
5. Error handling is present (try/catch)
6. PHI is not logged

---

## 15. NAMING CONVENTIONS

```typescript
// Variables and functions: camelCase
const clinicId = req.user.clinicId;
async function getAppointments() {}

// Classes and interfaces: PascalCase
class ConversationManager {}
interface AppointmentParams {}

// Database columns: snake_case
// appointment_date, clinic_id, created_at

// Files: camelCase for .ts, kebab-case for .sql
// appointmentModel.ts, 001_initial_schema.sql

// Environment variables: UPPER_SNAKE_CASE
// DATABASE_URL, TELNYX_API_KEY

// API routes: kebab-case
// /api/call-logs, /api/form-tokens
```
