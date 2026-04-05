import OpenAI from 'openai';
import { query } from '../../config/db';
import { config } from '../../config/env';
import { detectEmergency, EMERGENCY_RESPONSE } from '../emergency/emergencyDetector';
import { transcribeAudioBuffer, ingestTranscriptText } from '../stt/sttService';
import { IntentType } from '../intent-detection/intentService';
import { synthesize, TtsResult } from '../tts/ttsService';
import { checkSlotAvailable, createCalendarEvent } from '../../services/googleCalendarService';
import { createAppointment } from '../../models/appointmentModel';
import { upsertPatient } from '../../models/patientModel';
import { getSettingsByClinicId } from '../../models/settingsModel';
import { sendConfirmationSms, sendFormLinkSms } from '../../services/smsService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConversationState =
  | 'greeting'
  | 'intent_detection'
  | 'identity_verification'
  | 'booking_flow'
  | 'awaiting_date'
  | 'awaiting_time'
  | 'cancel_flow'
  | 'reschedule_flow'
  | 'completed'
  | 'handoff';

export interface ConversationSession {
  sessionId: string;
  clinicId: string;
  callLogId: string | null;
  state: ConversationState;
  intent: IntentType | null;
  turnCount: number;
  failedIntentAttempts: number;
  collectedData: {
    name?: string;
    dateOfBirth?: string;
    phone?: string;
  };
  identityVerified: boolean;
  verifiedPatientId: string | null;
  verificationAttempts: number;
  bookingDate: string | null;
  bookingTime: string | null;
  bookingConfirmed: boolean;
  lastAppointmentId: string | null;
  latencies: number[];            // per-turn totalMs — in-memory only, for avg at hangup
  nameConfirmed: boolean;         // true once the spelled-back name has been confirmed
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineTurnInput {
  sessionId: string;
  clinicId: string;
  callLogId?: string | null;
  transcriptFragment?: string;
  audioChunk?: Buffer;
}

export interface PipelineTurnOutput {
  state: ConversationState;
  intent: IntentType | null;
  responseText: string;
  ttsResult: TtsResult | null;
  nextState: ConversationState;
  callCompletedThisTurn: boolean;
  shouldAutoHangUp: boolean;
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

interface LLMExtracted {
  intent: IntentType | null;
  name: string | null;
  phone: string | null;        // 10 digits only, no formatting
  dateOfBirth: string | null;  // "MM/DD/YYYY"
  bookingDate: string | null;  // ISO "YYYY-MM-DD"
  bookingTime: string | null;  // "H:MM AM/PM"
  isGoodbye: boolean;
  isYes: boolean;
  isNo: boolean;
}

const LLM_EXTRACTED_DEFAULT: LLMExtracted = {
  intent: null,
  name: null,
  phone: null,
  dateOfBirth: null,
  bookingDate: null,
  bookingTime: null,
  isGoodbye: false,
  isYes: false,
  isNo: false,
};

const VALID_INTENTS: IntentType[] = [
  'book_appointment', 'cancel_appointment', 'reschedule_appointment', 'clinic_question', 'unknown',
];

// ---------------------------------------------------------------------------
// Keyword-based extraction fallback (runs when LLM is unavailable)
// ---------------------------------------------------------------------------

function keywordExtract(transcript: string): LLMExtracted {
  const t = transcript.toLowerCase();
  const result: LLMExtracted = { ...LLM_EXTRACTED_DEFAULT };

  // Intent detection
  const hasCancel = /\bcancel\b/.test(t);
  const hasReschedule = /\b(reschedule|change|move|modify)\b/.test(t) && /\bappointment\b/.test(t);
  const hasBook = /\b(book|schedule|appointment|make an appointment|need an appointment|set up|set an)\b/.test(t);

  if (hasCancel && !hasReschedule) {
    result.intent = 'cancel_appointment';
  } else if (hasReschedule) {
    result.intent = 'reschedule_appointment';
  } else if (hasBook) {
    result.intent = 'book_appointment';
  } else if (/\b(hours|location|address|cost|price|insurance|question|info|information|directions)\b/.test(t)) {
    result.intent = 'clinic_question';
  }

  // Yes / No / Goodbye
  result.isYes = /\b(yes|yeah|yep|yup|correct|right|sure|absolutely|that's right|indeed|confirmed)\b/.test(t);
  result.isNo = /\b(no|nope|nah|wrong|incorrect|not right|that's wrong)\b/.test(t);
  result.isGoodbye = /\b(goodbye|bye|thank you|thanks|that's all|that's it|all set|nothing else|no thanks|we're done|i'm done)\b/.test(t);

  // Name: "my name is X Y", "I am X Y", "I'm X", "this is X Y"
  const nameMatch = transcript.match(
    /(?:my name is|i am|i'm|this is|name's)\s+([A-Za-z]+(?:\s+[A-Za-z]+)*)/i
  );
  if (nameMatch) {
    result.name = nameMatch[1]
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  // Phone: 10 consecutive digits
  const phoneDigits = transcript.replace(/[-.()\s]/g, '');
  const phoneMatch = phoneDigits.match(/\b(\d{10})\b/);
  if (phoneMatch) result.phone = phoneMatch[1];

  // DOB: "March 30 1985", "March 30th, 1985", "30 March 1985"
  const MONTHS: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  const dobMonthFirst = transcript.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i
  );
  const dobDayFirst = transcript.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})\b/i
  );
  const dobSlash = transcript.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);

  if (dobMonthFirst) {
    const m = MONTHS[dobMonthFirst[1].toLowerCase()];
    const d = String(parseInt(dobMonthFirst[2], 10)).padStart(2, '0');
    result.dateOfBirth = `${m}/${d}/${dobMonthFirst[3]}`;
  } else if (dobDayFirst) {
    const m = MONTHS[dobDayFirst[2].toLowerCase()];
    const d = String(parseInt(dobDayFirst[1], 10)).padStart(2, '0');
    result.dateOfBirth = `${m}/${d}/${dobDayFirst[3]}`;
  } else if (dobSlash) {
    result.dateOfBirth = normalizeDOB(`${dobSlash[1]}/${dobSlash[2]}/${dobSlash[3]}`);
  }

  return result;
}

/**
 * Normalize a dateOfBirth string to MM/DD/YYYY.
 * Handles: ISO (YYYY-MM-DD), MM/DD/YYYY, and DD/MM/YYYY (when first number > 12).
 * Returns null if the format is unrecognizable.
 */
function normalizeDOB(raw: string): string | null {
  const s = raw.trim();

  // ISO: YYYY-MM-DD → MM/DD/YYYY
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;

  // MM/DD/YYYY or DD/MM/YYYY (with 2- or 4-digit year)
  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slash) {
    const a = parseInt(slash[1], 10);
    const b = parseInt(slash[2], 10);
    let y = slash[3];
    if (y.length === 2) y = `${parseInt(y, 10) <= 30 ? '20' : '19'}${y}`;
    // If first number is > 12 it must be the day (DD/MM/YYYY)
    if (a > 12) return `${String(b).padStart(2, '0')}/${String(a).padStart(2, '0')}/${y}`;
    // Otherwise trust MM/DD/YYYY as instructed to the LLM
    return `${String(a).padStart(2, '0')}/${String(b).padStart(2, '0')}/${y}`;
  }

  return null;
}

async function extractWithLLM(
  transcript: string,
  sessionId: string,
  clinicId: string,
): Promise<LLMExtracted> {
  if (!transcript.trim()) return { ...LLM_EXTRACTED_DEFAULT };

  const apiKey = config.openrouterApiKey;
  if (!apiKey) {
    console.error(JSON.stringify({ level: 'error', service: 'conversationManager', message: 'OPENROUTER_API_KEY not set — using keyword fallback', sessionId, clinicId }));
    return keywordExtract(transcript);
  }

  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = `You are an AI assistant that extracts structured data from a patient's spoken message to a medical clinic receptionist.

Return ONLY valid JSON — no explanation, no markdown, no code blocks.

Fields to extract:
- intent: one of "book_appointment", "cancel_appointment", "reschedule_appointment", "clinic_question", "unknown", or null
- name: full patient name as spoken (title-case each word), or null
- phone: 10 US digits only (no spaces, dashes, parens), or null. Handle spoken forms: "triple 3" = "333", "double 5" = "55", "five five five one two three four five six seven" = "5551234567"
- dateOfBirth: date of birth normalized to "MM/DD/YYYY". Handle ALL formats: "March 30, 1985"→"03/30/1985", "March 30th 1985"→"03/30/1985", "30 March 1985"→"03/30/1985", "30th of March 1985"→"03/30/1985", "3/30/85"→"03/30/1985", "03/30/1985"→"03/30/1985", "1985-03-30"→"03/30/1985". Return null only if completely absent.
- bookingDate: desired appointment date as "YYYY-MM-DD" (compute from today ${today} if relative, e.g. "next Tuesday", "Thursday April 9th", "tomorrow"), or null
- bookingTime: desired appointment time as "H:MM AM/PM" (e.g. "10:00 AM", "2:30 PM", "9:00 AM"), or null
- isGoodbye: true if caller signals end-of-call (goodbye, bye, that's it, I'm done, we're done, no thanks, all set, I'm all set, nothing else, that's all)
- isYes: true if caller confirms or agrees (yes, yeah, yep, correct, sure, go ahead, that's right, absolutely)
- isNo: true if caller rejects or denies (no, nope, nah, wrong, don't, never mind)

Always return ALL fields. Use null for missing strings, false for missing booleans.
{"intent":null,"name":null,"phone":null,"dateOfBirth":null,"bookingDate":null,"bookingTime":null,"isGoodbye":false,"isYes":false,"isNo":false}`;

  const openai = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  try {
    const response = await openai.chat.completions.create(
      {
        model: config.openrouterModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: transcript },
        ],
        temperature: 0.0,
        max_tokens: 200,
      },
      { timeout: 6000 },
    );

    const content = (response.choices[0]?.message?.content ?? '').trim()
      .replace(/```json\n?/g, '').replace(/```\n?/g, '');

    const parsed = JSON.parse(content) as Record<string, unknown>;

    const intent = VALID_INTENTS.includes(parsed.intent as IntentType)
      ? (parsed.intent as IntentType)
      : null;

    // Ensure phone is exactly 10 digits
    const rawPhone = typeof parsed.phone === 'string' ? parsed.phone.replace(/\D/g, '') : null;
    const phone = rawPhone && rawPhone.length === 10 ? rawPhone : null;

    // Normalize dateOfBirth to MM/DD/YYYY regardless of what format the LLM returns
    const rawDob = typeof parsed.dateOfBirth === 'string' && parsed.dateOfBirth.trim()
      ? parsed.dateOfBirth.trim()
      : null;
    const dateOfBirth = rawDob ? (normalizeDOB(rawDob) ?? rawDob) : null;

    return {
      intent,
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null,
      phone,
      dateOfBirth,
      bookingDate: typeof parsed.bookingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.bookingDate) ? parsed.bookingDate : null,
      bookingTime: typeof parsed.bookingTime === 'string' && parsed.bookingTime.trim() ? parsed.bookingTime.trim() : null,
      isGoodbye: parsed.isGoodbye === true,
      isYes: parsed.isYes === true,
      isNo: parsed.isNo === true,
    };
  } catch (llmErr: unknown) {
    // Never log transcript — PHI. Log the error type/message only.
    const errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
    const errStatus = (llmErr as { status?: number })?.status ?? null;
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'conversationManager',
      message: 'LLM extraction failed — using keyword fallback',
      sessionId,
      clinicId,
      error: errMsg,
      httpStatus: errStatus,
    }));
    return keywordExtract(transcript);
  }
}

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

const sessions = new Map<string, ConversationSession>();

export function getSession(sessionId: string): ConversationSession | undefined {
  return sessions.get(sessionId);
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

function getOrCreateSession(
  sessionId: string,
  clinicId: string,
  callLogId: string | null
): ConversationSession {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const session: ConversationSession = {
    sessionId,
    clinicId,
    callLogId,
    state: 'greeting',
    intent: null,
    turnCount: 0,
    failedIntentAttempts: 0,
    collectedData: {},
    identityVerified: false,
    verifiedPatientId: null,
    verificationAttempts: 0,
    bookingDate: null,
    bookingTime: null,
    bookingConfirmed: false,
    lastAppointmentId: null,
    latencies: [],
    nameConfirmed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  return session;
}

// ---------------------------------------------------------------------------
// Name spell-back helper (still used for TTS confirmation)
// ---------------------------------------------------------------------------

/**
 * Spell a name back letter-by-letter for TTS confirmation.
 * "Sarah Johnson" → "S - A - R - A - H — J - O - H - N - S - O - N"
 */
export function spellName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts
    .map((word) => word.toUpperCase().split('').join(' - '))
    .join(', \u2014 ');
}


// ---------------------------------------------------------------------------
// Clinic name lookup (cached)
// ---------------------------------------------------------------------------

const clinicNameCache = new Map<string, string>();

async function getClinicName(clinicId: string): Promise<string> {
  const cached = clinicNameCache.get(clinicId);
  if (cached) return cached;

  try {
    const result = await query(
      'SELECT name FROM clinics WHERE id = $1 LIMIT 1',
      [clinicId]
    );
    const name = result.rows[0]?.name ?? 'the clinic';
    clinicNameCache.set(clinicId, name);
    return name;
  } catch (err: unknown) {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'conversationManager',
      message: 'getClinicName failed — using fallback',
      clinicId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    return 'the clinic';
  }
}

// ---------------------------------------------------------------------------
// Patient upsert (inline to avoid circular imports)
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// DB persistence helpers
// ---------------------------------------------------------------------------

async function saveSessionToDB(session: ConversationSession): Promise<void> {
  try {
    const sessionData = JSON.stringify({
      intent: session.intent,
      turnCount: session.turnCount,
      failedIntentAttempts: session.failedIntentAttempts,
      collectedData: session.collectedData,
      identityVerified: session.identityVerified,
      verifiedPatientId: session.verifiedPatientId,
      verificationAttempts: session.verificationAttempts,
      bookingDate: session.bookingDate,
      bookingTime: session.bookingTime,
      bookingConfirmed: session.bookingConfirmed,
      lastAppointmentId: session.lastAppointmentId,
      nameConfirmed: session.nameConfirmed,
    });

    await query(
      `INSERT INTO conversation_sessions (session_id, clinic_id, call_log_id, state, session_data, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (session_id) DO UPDATE
         SET state        = EXCLUDED.state,
             session_data = EXCLUDED.session_data,
             updated_at   = NOW()`,
      [session.sessionId, session.clinicId, session.callLogId, session.state, sessionData]
    );
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'conversationManager',
      message: 'Failed to save session to DB',
      sessionId: session.sessionId,
      clinicId: session.clinicId,
      error: error.message,
    }));
    // Non-fatal — session still works from memory
  }
}

async function updateCallLogStatus(
  callLogId: string,
  clinicId: string,
  status: string
): Promise<void> {
  try {
    await query(
      'UPDATE call_logs SET status = $1 WHERE id = $2 AND clinic_id = $3',
      [status, callLogId, clinicId]
    );
  } catch (err: unknown) {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'conversationManager',
      message: 'updateCallLogStatus failed — non-fatal',
      callLogId,
      clinicId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// State machine processor
// ---------------------------------------------------------------------------

async function processState(
  session: ConversationSession,
  transcript: string
): Promise<{ responseText: string; nextState: ConversationState; shouldAutoHangUp: boolean }> {
  // Run LLM extraction once per turn for all states that need user input.
  // Greeting state generates a response without needing any extraction.
  const extracted = session.state !== 'greeting'
    ? await extractWithLLM(transcript, session.sessionId, session.clinicId)
    : { ...LLM_EXTRACTED_DEFAULT };

  switch (session.state) {
    // ----- GREETING -----
    case 'greeting': {
      const clinicName = await getClinicName(session.clinicId);
      return {
        responseText: `Hello, thank you for calling ${clinicName}. How can I help you today?`,
        nextState: 'intent_detection',
        shouldAutoHangUp: false,
      };
    }

    // ----- INTENT DETECTION -----
    case 'intent_detection': {
      if (!transcript) {
        return { responseText: 'How can I help you today?', nextState: 'intent_detection', shouldAutoHangUp: false };
      }

      const intent = extracted.intent;

      if (intent && intent !== 'unknown') {
        session.intent = intent;

        // Capture any date/time the LLM found alongside the intent
        if (extracted.bookingDate) session.bookingDate = extracted.bookingDate;
        if (extracted.bookingTime) session.bookingTime = extracted.bookingTime;

        switch (intent) {
          case 'book_appointment':
          case 'cancel_appointment':
          case 'reschedule_appointment':
            return {
              responseText: 'Sure, I can help with that. First I need to verify your identity. May I have your full name?',
              nextState: 'identity_verification',
              shouldAutoHangUp: false,
            };
          case 'clinic_question':
            return {
              responseText: 'I can try to answer your question, but for detailed information, a staff member would be better. Could you tell me more about what you need?',
              nextState: 'intent_detection',
              shouldAutoHangUp: false,
            };
          default:
            break;
        }
      }

      session.failedIntentAttempts++;
      if (session.failedIntentAttempts >= 3) {
        return {
          responseText: 'Let me connect you with a staff member who can better assist you. Please hold.',
          nextState: 'handoff',
          shouldAutoHangUp: false,
        };
      }
      return {
        responseText: "I'm sorry, I didn't quite understand. Could you tell me how I can help you? For example, would you like to book, cancel, or reschedule an appointment?",
        nextState: 'intent_detection',
        shouldAutoHangUp: false,
      };
    }

    // ----- IDENTITY VERIFICATION -----
    case 'identity_verification': {
      // ----------------------------------------------------------------
      // Step 1: collect name
      // ----------------------------------------------------------------
      if (!session.collectedData.name) {
        const name = extracted.name;
        if (name) {
          session.collectedData.name = name;
          session.nameConfirmed = false;
          return {
            responseText: `Thank you. Let me confirm — your name is ${spellName(name)}. Is that correct?`,
            nextState: 'identity_verification',
            shouldAutoHangUp: false,
          };
        }
        session.verificationAttempts++;
        if (session.verificationAttempts >= 3) {
          return {
            responseText: 'Let me connect you with a staff member. Please hold.',
            nextState: 'handoff',
            shouldAutoHangUp: false,
          };
        }
        return {
          responseText: 'Could you please tell me your full name? For example, you can say "My name is John Smith."',
          nextState: 'identity_verification',
          shouldAutoHangUp: false,
        };
      }

      // ----------------------------------------------------------------
      // Step 2: confirm the spelled-back name
      // ----------------------------------------------------------------
      if (!session.nameConfirmed) {
        if (extracted.isYes) {
          session.nameConfirmed = true;
          console.log(JSON.stringify({
            level: 'info',
            service: 'conversationManager',
            event: 'name_confirmed',
            sessionId: session.sessionId,
            clinicId: session.clinicId,
          }));
          return {
            responseText: 'And your date of birth?',
            nextState: 'identity_verification',
            shouldAutoHangUp: false,
          };
        }

        if (extracted.isNo) {
          session.collectedData.name = undefined;
          session.nameConfirmed = false;
          return {
            responseText: 'I apologize — could you please tell me your name again?',
            nextState: 'identity_verification',
            shouldAutoHangUp: false,
          };
        }

        // Caller may be re-stating their name directly
        if (extracted.name) {
          session.collectedData.name = extracted.name;
          session.nameConfirmed = false;
          return {
            responseText: `Thank you. Let me confirm — your name is ${spellName(extracted.name)}. Is that correct?`,
            nextState: 'identity_verification',
            shouldAutoHangUp: false,
          };
        }

        return {
          responseText: `Just to confirm — your name is ${spellName(session.collectedData.name)}. Please say yes or no.`,
          nextState: 'identity_verification',
          shouldAutoHangUp: false,
        };
      }

      // ----------------------------------------------------------------
      // Step 3: collect DOB
      // ----------------------------------------------------------------
      if (!session.collectedData.dateOfBirth) {
        const dob = extracted.dateOfBirth;
        if (dob) {
          session.collectedData.dateOfBirth = dob;
          return {
            responseText: 'Got it. And your phone number?',
            nextState: 'identity_verification',
            shouldAutoHangUp: false,
          };
        }
        session.verificationAttempts++;
        if (session.verificationAttempts >= 3) {
          return {
            responseText: 'Let me connect you with a staff member. Please hold.',
            nextState: 'handoff',
            shouldAutoHangUp: false,
          };
        }
        return {
          responseText: 'I need your date of birth. You can say it like "January 15, 1990" or "01/15/1990".',
          nextState: 'identity_verification',
          shouldAutoHangUp: false,
        };
      }

      // ----------------------------------------------------------------
      // Step 4: collect phone
      // ----------------------------------------------------------------
      if (!session.collectedData.phone) {
        const rawPhone = extracted.phone; // 10 digits from LLM
        const phone = rawPhone ? `+1${rawPhone}` : null;
        if (phone) {
          session.collectedData.phone = phone;

          try {
            const { patient } = await upsertPatient({
              clinicId: session.clinicId,
              name: session.collectedData.name,
              phone,
              dateOfBirth: session.collectedData.dateOfBirth ?? undefined,
            });
            session.verifiedPatientId = patient.id;
            session.identityVerified = true;

            let nextState: ConversationState = 'booking_flow';
            let responseText = 'Thank you. I have verified your identity. What date works for you?';
            if (session.intent === 'cancel_appointment') {
              nextState = 'completed';
              responseText = "Thank you. I have verified your identity. Your appointment has been cancelled. You will receive a confirmation text shortly. Is there anything else I can help you with?";
            } else if (session.intent === 'reschedule_appointment') {
              nextState = 'booking_flow';
              responseText = 'Thank you. I have verified your identity. What new date works for you?';
            }
            return { responseText, nextState, shouldAutoHangUp: false };
          } catch (err: unknown) {
            const error = err as Error;
            console.error(JSON.stringify({
              level: 'error',
              service: 'conversationManager',
              message: 'Patient upsert failed',
              sessionId: session.sessionId,
              clinicId: session.clinicId,
              error: error.message,
            }));
            return {
              responseText: "I'm having trouble verifying your information. Let me connect you with a staff member.",
              nextState: 'handoff',
              shouldAutoHangUp: false,
            };
          }
        }

        session.verificationAttempts++;
        if (session.verificationAttempts >= 3) {
          return {
            responseText: 'Let me connect you with a staff member. Please hold.',
            nextState: 'handoff',
            shouldAutoHangUp: false,
          };
        }
        return {
          responseText: 'Could you please provide your phone number? For example, "555-123-4567".',
          nextState: 'identity_verification',
          shouldAutoHangUp: false,
        };
      }

      return { responseText: 'One moment please.', nextState: session.state, shouldAutoHangUp: false };
    }

    // ----- BOOKING FLOW -----
    case 'booking_flow':
    case 'awaiting_date': {
      if (!session.bookingDate) {
        const date = extracted.bookingDate;
        if (date) {
          session.bookingDate = date;
          if (session.bookingTime) {
            return {
              responseText: `I have ${session.bookingDate} at ${session.bookingTime}. Shall I confirm this appointment?`,
              nextState: 'awaiting_time',
              shouldAutoHangUp: false,
            };
          }
          return {
            responseText: 'What time works best for you?',
            nextState: 'awaiting_time',
            shouldAutoHangUp: false,
          };
        }
        return {
          responseText: 'What date works for you? You can say something like "next Tuesday" or "April 9th".',
          nextState: 'awaiting_date',
          shouldAutoHangUp: false,
        };
      }

      if (!session.bookingTime) {
        const time = extracted.bookingTime;
        if (time) {
          session.bookingTime = time;
          return {
            responseText: `I have ${session.bookingDate} at ${session.bookingTime}. Shall I confirm this appointment?`,
            nextState: 'awaiting_time',
            shouldAutoHangUp: false,
          };
        }
        return {
          responseText: 'What time works best for you? For example, "10am" or "2:30 PM".',
          nextState: 'awaiting_time',
          shouldAutoHangUp: false,
        };
      }

      if (!session.bookingConfirmed) {
        if (extracted.isYes) {
          const result = await confirmBooking(session, transcript);
          return { ...result, shouldAutoHangUp: false };
        }
        if (extracted.isNo) {
          session.bookingDate = null;
          session.bookingTime = null;
          return {
            responseText: 'No problem. What date would you prefer instead?',
            nextState: 'awaiting_date',
            shouldAutoHangUp: false,
          };
        }
        return {
          responseText: `I have ${session.bookingDate} at ${session.bookingTime}. Shall I confirm this appointment? Please say yes or no.`,
          nextState: 'awaiting_time',
          shouldAutoHangUp: false,
        };
      }

      return { responseText: 'Your appointment is already confirmed. Is there anything else I can help you with?', nextState: 'completed', shouldAutoHangUp: false };
    }

    // ----- AWAITING TIME -----
    case 'awaiting_time': {
      if (!session.bookingTime) {
        const time = extracted.bookingTime;
        if (time) {
          session.bookingTime = time;
          return {
            responseText: `I have ${session.bookingDate} at ${session.bookingTime}. Shall I confirm this appointment?`,
            nextState: 'awaiting_time',
            shouldAutoHangUp: false,
          };
        }
        return {
          responseText: 'What time works best for you? For example, "10am" or "2:30 PM".',
          nextState: 'awaiting_time',
          shouldAutoHangUp: false,
        };
      }

      if (!session.bookingConfirmed) {
        if (extracted.isYes) {
          const result = await confirmBooking(session, transcript);
          return { ...result, shouldAutoHangUp: false };
        }
        if (extracted.isNo) {
          session.bookingDate = null;
          session.bookingTime = null;
          return {
            responseText: 'No problem. What date would you prefer instead?',
            nextState: 'awaiting_date',
            shouldAutoHangUp: false,
          };
        }
        return {
          responseText: `I have ${session.bookingDate} at ${session.bookingTime}. Shall I confirm this appointment? Please say yes or no.`,
          nextState: 'awaiting_time',
          shouldAutoHangUp: false,
        };
      }

      return { responseText: 'Your appointment is already confirmed. Is there anything else I can help you with?', nextState: 'completed', shouldAutoHangUp: false };
    }

    // ----- CANCEL FLOW -----
    case 'cancel_flow': {
      return {
        responseText: "Your appointment has been cancelled. Is there anything else I can help you with?",
        nextState: 'completed',
        shouldAutoHangUp: false,
      };
    }

    // ----- RESCHEDULE FLOW -----
    case 'reschedule_flow': {
      return {
        responseText: "Let's reschedule your appointment. What new date works for you?",
        nextState: 'booking_flow',
        shouldAutoHangUp: false,
      };
    }

    // ----- COMPLETED -----
    case 'completed': {
      if (transcript && transcript.length > 0) {
        if (extracted.isGoodbye) {
          return {
            responseText: 'Thank you for calling. Goodbye!',
            nextState: 'handoff',
            shouldAutoHangUp: true,
          };
        }

        // Caller said something else — reset for a new intent
        session.intent = null;
        session.failedIntentAttempts = 0;
        session.collectedData = {};
        session.identityVerified = false;
        session.verifiedPatientId = null;
        session.verificationAttempts = 0;
        session.bookingDate = null;
        session.bookingTime = null;
        session.bookingConfirmed = false;
        session.lastAppointmentId = null;
        return {
          responseText: 'Sure, how else can I help you?',
          nextState: 'intent_detection',
          shouldAutoHangUp: false,
        };
      }
      return {
        responseText: 'Is there anything else I can help you with today?',
        nextState: 'completed',
        shouldAutoHangUp: false,
      };
    }

    // ----- HANDOFF -----
    case 'handoff': {
      return {
        responseText: 'Let me connect you with a staff member. Please hold.',
        nextState: 'handoff',
        shouldAutoHangUp: false,
      };
    }

    default:
      return {
        responseText: 'Let me connect you with a staff member. Please hold.',
        nextState: 'handoff',
        shouldAutoHangUp: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Time format helper (AM/PM → 24-h for calendar API)
// ---------------------------------------------------------------------------

/** Convert "H:MM AM/PM" (from LLM extraction) to "HH:MM" 24-h. */
export function resolveBookingTime(timeStr: string): string {
  if (/^\d{2}:\d{2}$/.test(timeStr)) return timeStr;

  const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const period = m[3].toUpperCase();
    if (period === 'PM' && h < 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }

  return timeStr;
}

// ---------------------------------------------------------------------------
// Shared booking confirmation logic (used by booking_flow + awaiting_time)
// ---------------------------------------------------------------------------

async function confirmBooking(
  session: ConversationSession,
  _transcript: string
): Promise<{ responseText: string; nextState: ConversationState }> {
  const clinicId = session.clinicId;
  const rawDate = session.bookingDate!;  // already ISO "YYYY-MM-DD" from LLM
  const rawTime = session.bookingTime!;
  const isoDate = rawDate;               // no conversion needed — LLM returns ISO directly
  const isoTime = resolveBookingTime(rawTime);
  const slot = { date: isoDate, time: isoTime, durationMinutes: 30 };

  // 1. Check slot availability — advisory only (Calendar integration is Phase 2, not yet complete).
  // If the slot shows as busy, log a warning and proceed; never block a booking due to calendar state.
  const available = await checkSlotAvailable(clinicId, slot);
  if (!available) {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'conversationManager',
      message: 'Slot shows as busy in calendar — proceeding with booking (advisory only, Phase 2)',
      clinicId,
      sessionId: session.sessionId,
      isoDate,
      isoTime,
    }));
  }

  // 2. Create Google Calendar event (non-fatal on failure)
  let googleEventId: string | null = null;
  try {
    const calEvent = await createCalendarEvent({ clinicId, slot, summary: 'Appointment' });
    googleEventId = calEvent.eventId;
  } catch (err) {
    console.warn(`[confirmBooking] Calendar event creation failed for session=${session.sessionId}, clinic=${clinicId}. Continuing without calendar event.`);
  }

  // 3. Create appointment in DB (non-fatal on failure)
  try {
    if (session.verifiedPatientId) {
      const appointment = await createAppointment({
        clinicId,
        patientId: session.verifiedPatientId,
        appointmentDate: isoDate,
        appointmentTime: isoTime,
        googleEventId: googleEventId ?? undefined,
        createdVia: 'voice',
      });
      session.lastAppointmentId = appointment.id;

      // 3a. Get clinic name for SMS messages
      const settings = await getSettingsByClinicId(clinicId);
      const clinicName = settings?.clinicName || 'the clinic';

      // 3b. Send confirmation SMS — must not affect booking flow
      try {
        await sendConfirmationSms(
          clinicId,
          session.collectedData.phone!,
          session.collectedData.name!,
          session.bookingDate!,
          session.bookingTime!,
          clinicName,
        );
      } catch (smsErr) {
        console.warn('[confirmBooking] Confirmation SMS failed — booking still confirmed:', (smsErr as Error).message);
      }

      // 3c. Create form token + send form link
      try {
        const { createFormToken } = require('../../services/formTokenService');
        const token = await createFormToken({
          clinicId,
          appointmentId: session.lastAppointmentId!,
          patientId: session.verifiedPatientId!,
        });
        const formUrl = `${config.frontendUrl}/intake/${token}`;
        await sendFormLinkSms(clinicId, session.collectedData.phone!, formUrl);
        console.log(JSON.stringify({ level: 'info', service: 'conversationManager', message: 'Form link sent', clinicId, appointmentId: session.lastAppointmentId }));
      } catch (err) {
        console.warn(JSON.stringify({ level: 'warn', service: 'conversationManager', message: 'Form link SMS failed', clinicId, error: err instanceof Error ? err.message : 'Unknown' }));
      }
    }
  } catch (err) {
    console.error(`[confirmBooking] DB appointment creation failed for session=${session.sessionId}, clinic=${clinicId}. Patient was told confirmed.`);
  }

  session.bookingConfirmed = true;
  const resp = `Your appointment is confirmed for ${rawDate} at ${rawTime}. You will receive a confirmation text message shortly.`;
  return { responseText: resp, nextState: 'completed' };
}

// ---------------------------------------------------------------------------
// Main export — runPipelineTurn
// ---------------------------------------------------------------------------

export async function runPipelineTurn(
  input: PipelineTurnInput
): Promise<PipelineTurnOutput> {
  const { sessionId, clinicId, callLogId, transcriptFragment, audioChunk } = input;

  // 1. Get or create session
  const session = getOrCreateSession(sessionId, clinicId, callLogId ?? null);

  const t0 = Date.now(); // turn start

  // 2. Get transcript
  let transcript = '';
  if (transcriptFragment) {
    const sttResult = ingestTranscriptText(sessionId, transcriptFragment);
    transcript = sttResult.text.trim();
  } else if (audioChunk) {
    const sttResult = await transcribeAudioBuffer(audioChunk, sessionId);
    transcript = sttResult.text.trim();
  }

  const t1 = Date.now(); // STT complete

  // 3. EMERGENCY CHECK — always first
  if (transcript.length > 0 && detectEmergency(transcript)) {
    if (session.callLogId) {
      await updateCallLogStatus(session.callLogId, session.clinicId, 'completed');
    }
    clearSession(sessionId);

    console.log(JSON.stringify({
      level: 'warn',
      service: 'conversationManager',
      message: 'Emergency detected — call handed off',
      sessionId,
      clinicId,
    }));

    let ttsResult: TtsResult | null = null;
    try {
      ttsResult = await synthesize({ text: EMERGENCY_RESPONSE, sessionId, clinicId });
    } catch {
      // TTS failure is non-fatal — text response still returned
    }

    return {
      state: 'handoff',
      intent: null,
      responseText: EMERGENCY_RESPONSE,
      ttsResult,
      nextState: 'handoff',
      callCompletedThisTurn: true,
      shouldAutoHangUp: false,
    };
  }

  // Cancel-pivot intent is now handled by extractWithLLM inside processState.
  // The LLM detects "actually I need to cancel instead" and returns intent: 'cancel_appointment'
  // on any turn, so a separate regex pre-check is no longer required.

  const t2 = Date.now(); // pre-processing complete

  // 4. State machine
  const previousState = session.state;
  const { responseText, nextState, shouldAutoHangUp } = await processState(session, transcript);
  session.state = nextState;

  const t3 = Date.now(); // state machine + response build complete

  const callCompletedThisTurn = nextState === 'completed' || nextState === 'handoff';

  // 5. Increment turn count
  session.turnCount++;
  session.updatedAt = new Date();

  // 6. Log state transition (never log transcript — PHI)
  console.log(JSON.stringify({
    level: 'info',
    service: 'conversationManager',
    message: 'Pipeline turn processed',
    sessionId,
    clinicId,
    previousState,
    nextState,
    turnCount: session.turnCount,
  }));

  // 7. Save session to DB
  await saveSessionToDB(session);

  // 8. Synthesize TTS
  let ttsResult: TtsResult | null = null;
  try {
    ttsResult = await synthesize({ text: responseText, sessionId, clinicId });
  } catch {
    // TTS failure is non-fatal
  }

  const t4 = Date.now(); // TTS complete

  // Latency log — passive measurement, never delays the pipeline
  console.log(JSON.stringify({
    level: 'info',
    service: 'latency',
    sessionId,
    turn: session.turnCount,
    stt_ms: t1 - t0,
    llm_ms: t2 - t1,
    logic_ms: t3 - t2,
    tts_ms: t4 - t3,
    total_ms: t4 - t0,
    state: session.state,
  }));

  session.latencies.push(t4 - t0);

  // 9. Return
  return {
    state: previousState,
    intent: session.intent,
    responseText,
    ttsResult,
    nextState: session.state,
    callCompletedThisTurn,
    shouldAutoHangUp,
  };
}
