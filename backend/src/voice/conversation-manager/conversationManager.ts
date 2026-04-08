import { callLLM, LLMCallContext } from './llmPromptService';
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
import { insertConversationTurn } from '../../models/conversationTurnModel';

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
  conversationHistory: Array<{role: 'user' | 'assistant'; content: string}>;  // last 3 turns for LLM context
  nameConfirmed: boolean;         // true once last name spelling confirmed
  firstNameConfirmed: boolean;    // true once first name spelling confirmed
  lastResponseOpener: string | null; // first word of last AI turn (prevents opener repetition)
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
// Natural spelling detection — converts "A-M-I-T" or "A M I T" to "Amit"
// ---------------------------------------------------------------------------

const PHONETIC_REVERSE: Record<string, string> = {
  alpha: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E',
  foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I', juliet: 'J',
  kilo: 'K', lima: 'L', mike: 'M', november: 'N', oscar: 'O',
  papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S', tango: 'T',
  uniform: 'U', victor: 'V', whiskey: 'W', 'x-ray': 'X', yankee: 'Y', zulu: 'Z',
};

/**
 * Pre-process a transcript to resolve letter-by-letter spelling into words.
 * Handles:
 *   "A-M-I-T", "A.M.I.T", "a - m - i - t"     → "Amit"
 *   "A M I T" / "a m i t" (3+ consecutive)    → "Amit"
 *   "A as in Alpha, M as in Mike …"           → "Amit"
 */
export function preprocessSpelledLetters(text: string): string {
  let result = text.trim();

  // Step 1 — NATO phonetic: "X as in Word" → letter, e.g. "A as in Alpha" → "A"
  result = result.replace(
    /\b([A-Za-z]) as in ([A-Za-z]+(?:-[A-Za-z]+)?)\b/gi,
    (_m, letter: string, phonetic: string) =>
      PHONETIC_REVERSE[phonetic.toLowerCase()] ?? letter.toUpperCase(),
  );

  // Step 2 — Separator-delimited single letters (3+), allowing optional spaces around separator.
  // Handles: "A-M-I-T", "A.M.I.T", "a - m - i - t", "A_M_I_T"
  result = result.replace(
    /\b([A-Za-z])(?:\s*[-._]\s*[A-Za-z]){2,}\b/g,
    (match: string) => {
      // Extract the individual letter characters only
      const chars = match.replace(/[\s\-._]/g, ' ').trim().split(/\s+/).filter(
        (c: string) => /^[A-Za-z]$/.test(c)
      );
      if (chars.length < 3) return match;
      return chars[0].toUpperCase() + chars.slice(1).map((c: string) => c.toLowerCase()).join('');
    },
  );

  // Step 2b — Comma-separated single letters (3+): "A, M, I, T" or "A,M,I,T" → "Amit"
  result = result.replace(
    /\b([A-Za-z])(?:,\s*([A-Za-z])){2,}\b/g,
    (match: string) => {
      const chars = match.split(/,\s*/).map((c: string) => c.trim().toUpperCase());
      return chars[0] + chars.slice(1).map((c: string) => c.toLowerCase()).join('');
    },
  );

  // Step 3 — Space-separated single letters (3+): "A M I T" or "a m i t" → "Amit"
  // Case-insensitive: Deepgram smart_format usually uppercases spoken letters, but may not always.
  result = result.replace(
    /\b([A-Za-z] ){2,}[A-Za-z]\b/g,
    (match: string) => {
      const chars = match.trim().split(' ');
      return chars[0].toUpperCase() + chars.slice(1).map((c: string) => c.toLowerCase()).join('');
    },
  );

  return result;
}

// ---------------------------------------------------------------------------
// Keyword-based extraction fallback (runs when LLM is unavailable)
// ---------------------------------------------------------------------------

function keywordExtract(transcript: string): LLMExtracted {
  // Resolve any letter-by-letter spelling before regex matching
  const preprocessed = preprocessSpelledLetters(transcript);
  const t = preprocessed.toLowerCase();
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

  // Name: "my name is X Y", "I am X Y", "I'm X", "this is X Y" — use preprocessed for spelling
  const nameMatch = preprocessed.match(
    /(?:my name is|i am|i'm|this is|name's|last name is|last name's)\s+([A-Za-z]+(?:\s+[A-Za-z]+)*)/i
  );
  if (nameMatch) {
    result.name = nameMatch[1]
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  // Bare-name fallback: caller says just their name ("Amit" or "Amit Chidre") with no prefix.
  // Only fires when no other name was found and the entire preprocessed transcript is 1–3 title-case words.
  if (!result.name) {
    const bare = preprocessed.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})$/);
    if (bare) {
      result.name = bare[1];
    }
  }

  // Phone: 10 consecutive digits, also handles spoken digits ("five five five ...")
  const SPOKEN_DIGITS: Record<string, string> = {
    zero: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9', oh: '0',
  };
  const expandedPhone = preprocessed
    .replace(/\bdouble\s+([a-z])\b/gi, (_: string, c: string) => c + c)
    .replace(/\btriple\s+([a-z])\b/gi, (_: string, c: string) => c + c + c)
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/gi,
      (m: string) => SPOKEN_DIGITS[m.toLowerCase()] ?? m);
  const phoneDigits = expandedPhone.replace(/[-.()+\s]/g, '');
  const phoneRaw = phoneDigits.match(/(\d{10,11})/);
  if (phoneRaw) {
    const digits = phoneRaw[1].replace(/^1(\d{10})$/, '$1');
    if (digits.length === 10) result.phone = digits;
  }

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

// (extractWithLLM removed — replaced by callLLM in llmPromptService.ts)

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
    conversationHistory: [],
    nameConfirmed: false,
    firstNameConfirmed: false,
    lastResponseOpener: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);
  return session;
}

// ---------------------------------------------------------------------------
// Phonetic alphabet spelling helpers
// ---------------------------------------------------------------------------

const PHONETIC_ALPHABET: Record<string, string> = {
  A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo',
  F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliet',
  K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar',
  P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango',
  U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
};

/**
 * Spell a single word using NATO phonetic alphabet.
 * "Amit" → "A as in Alpha, M as in Mike, I as in India, T as in Tango"
 */
export function spellPhonetic(word: string): string {
  return word
    .toUpperCase()
    .split('')
    .filter((c) => /[A-Z]/.test(c))
    .map((c) => `${c} as in ${PHONETIC_ALPHABET[c] ?? c}`)
    .join(', ');
}

/**
 * Spell a full name using NATO phonetic alphabet (kept for backward compat).
 * "Sarah" → "S as in Sierra, A as in Alpha, R as in Romeo, A as in Alpha, H as in Hotel"
 */
export function spellName(name: string): string {
  return name.trim().split(/\s+/).map(spellPhonetic).join('; ');
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
      firstNameConfirmed: session.firstNameConfirmed,
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
): Promise<{ responseText: string; nextState: ConversationState; shouldAutoHangUp: boolean; parallelTtsResult: TtsResult | null; llmMs: number; ttsWaitMs: number }> {
  // ─── Greeting (hardcoded — no user input to process yet) ──────────────────────
  if (session.state === 'greeting') {
    const responseText = `Thanks for calling! How can I help you today?`;
    return { responseText, nextState: 'intent_detection', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
  }

  // ─── All other states: single LLM call drives response + state + entities ─
  const clinicName = await getClinicName(session.clinicId);
  const preprocessed = preprocessSpelledLetters(transcript);
  const ctx: LLMCallContext = {
    sessionId: session.sessionId,
    clinicId: session.clinicId,
    state: session.state,
    turnCount: session.turnCount,
    verificationAttempts: session.verificationAttempts,
    failedIntentAttempts: session.failedIntentAttempts,
    collectedData: session.collectedData,
    intent: session.intent,
    bookingDate: session.bookingDate,
    bookingTime: session.bookingTime,
    identityVerified: session.identityVerified,
    bookingConfirmed: session.bookingConfirmed,
    lastResponseOpener: session.lastResponseOpener,
  };

  // Start TTS as soon as response_text is complete in the stream (parallel execution)
  let ttsPromise: Promise<TtsResult | null> | null = null;
  const onResponseTextReady = (text: string): void => {
    ttsPromise = synthesize({ text, sessionId: session.sessionId, clinicId: session.clinicId }).catch(() => null);
  };

  const llmResult = await callLLM(ctx, preprocessed, clinicName, session.conversationHistory, onResponseTextReady);

  // LLM failure fallback — re-prompt without changing state
  if (!llmResult) {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'conversationManager',
      message: 'callLLM returned null — using re-prompt fallback',
      sessionId: session.sessionId,
    }));
    return {
      responseText: 'I apologize, I missed that. Could you say that again?',
      nextState: session.state,
      shouldAutoHangUp: false,
      parallelTtsResult: null,
      llmMs: 0,
      ttsWaitMs: 0,
    };
  }

  const { next_state: rawNextState, response_text, extracted_entities: e } = llmResult;

  const VALID_CONVERSATION_STATES: ConversationState[] = [
    'greeting', 'intent_detection', 'identity_verification', 'booking_flow',
    'awaiting_date', 'awaiting_time', 'cancel_flow', 'reschedule_flow',
    'completed', 'handoff',
  ];
  let nextState: ConversationState = VALID_CONVERSATION_STATES.includes(rawNextState as ConversationState)
    ? (rawNextState as ConversationState)
    : session.state;
  let responseText = response_text;

  // ── 1. Update session with extracted entities (never overwrite confirmed data) ──
  if (e.intent && (VALID_INTENTS as string[]).includes(e.intent) && !session.intent) {
    session.intent = e.intent as IntentType;
  }
  if (e.name && !session.collectedData.name) {
    session.collectedData.name = e.name;
    session.firstNameConfirmed = true;
    session.nameConfirmed = true;
  }
  if (e.dateOfBirth && !session.collectedData.dateOfBirth) {
    session.collectedData.dateOfBirth = e.dateOfBirth;
  }
  if (e.phone && !session.collectedData.phone) {
    session.collectedData.phone = `+1${e.phone}`;
  }
  if (e.bookingDate && !session.bookingDate) {
    session.bookingDate = e.bookingDate;
  }
  if (e.bookingTime && !session.bookingTime) {
    session.bookingTime = e.bookingTime;
  }

  // ── 2. Side-effect: patient upsert when identity verification is complete ──
  const hasAllIdentityData =
    session.collectedData.name &&
    session.collectedData.dateOfBirth &&
    session.collectedData.phone;
  const leavingVerification =
    session.state === 'identity_verification' && nextState !== 'identity_verification';

  if (leavingVerification && hasAllIdentityData && !session.identityVerified) {
    try {
      const { patient } = await upsertPatient({
        clinicId: session.clinicId,
        name: session.collectedData.name!,
        phone: session.collectedData.phone!,
        dateOfBirth: session.collectedData.dateOfBirth ?? undefined,
      });
      session.verifiedPatientId = patient.id;
      session.identityVerified = true;
      console.log(JSON.stringify({
        level: 'info',
        service: 'conversationManager',
        event: 'identity_verified',
        sessionId: session.sessionId,
        clinicId: session.clinicId,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        service: 'conversationManager',
        message: 'upsertPatient failed',
        sessionId: session.sessionId,
        error: (err as Error).message,
      }));
      responseText = "I'm having trouble verifying your information. Let me connect you with a staff member.";
      nextState = 'handoff';
      ttsPromise = null; // discard parallel TTS (wrong audio) — re-synthesize for error message
    }
  }

  // Guard: prevent LLM from skipping identity_verification before all data is collected
  if (leavingVerification && !hasAllIdentityData && !session.identityVerified) {
    nextState = 'identity_verification';
  }

  // ── 3. Side-effect: booking confirmation when caller says yes ─────────────
  const confirmingBooking =
    !session.bookingConfirmed &&
    session.bookingDate &&
    session.bookingTime &&
    e.isYes &&
    (session.state === 'awaiting_time' || session.state === 'booking_flow');

  if (confirmingBooking) {
    const confirmResult = await confirmBooking(session, transcript);
    session.conversationHistory.push({ role: 'user', content: preprocessed });
    // Store as JSON so model continues in JSON format on subsequent turns
    session.conversationHistory.push({ role: 'assistant', content: JSON.stringify({ next_state: 'completed', response_text: confirmResult.responseText, extracted_entities: {} }) });
    if (session.conversationHistory.length > 6) {
      session.conversationHistory.splice(0, session.conversationHistory.length - 6);
    }
    return { responseText: confirmResult.responseText, nextState: 'completed', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: llmResult.llmMs, ttsWaitMs: 0 };
  }

  // ── 4. Track failed attempts — escalate to handoff after 5 stuck turns ────
  if (session.state === nextState && transcript.trim() && session.state !== 'completed') {
    const madeProgress = e.name || e.dateOfBirth || e.phone || e.bookingDate || e.bookingTime || e.intent;
    if (!madeProgress && !e.isYes && !e.isNo) {
      session.verificationAttempts++;
      if (session.verificationAttempts >= 5) {
        return {
          responseText: 'Let me connect you with a staff member who can better assist you. Please hold.',
          nextState: 'handoff',
          shouldAutoHangUp: false,
          parallelTtsResult: null,
          llmMs: llmResult.llmMs,
          ttsWaitMs: 0,
        };
      }
    } else {
      session.verificationAttempts = 0;
    }
  }

  // ── 5. Update conversation history (keep last 3 turns = 6 messages) ──────
  // IMPORTANT: store raw_json (not responseText) so the model sees its prior responses
  // were JSON and continues outputting JSON on every subsequent turn.
  session.conversationHistory.push({ role: 'user', content: preprocessed });
  session.conversationHistory.push({ role: 'assistant', content: llmResult.raw_json });
  if (session.conversationHistory.length > 6) {
    session.conversationHistory.splice(0, session.conversationHistory.length - 6);
  }

  const shouldAutoHangUp = (e.isGoodbye || false) && (nextState === 'handoff' || nextState === 'completed');

  // Await parallel TTS (started during LLM streaming — likely already done)
  const ttsWaitStart = Date.now();
  const parallelTtsResult: TtsResult | null = ttsPromise ? await ttsPromise : null;
  const ttsWaitMs = ttsPromise ? Date.now() - ttsWaitStart : 0;

  // Track opener word so the LLM avoids repeating the same opener next turn
  const firstWord = responseText.split(/\s+/)[0].replace(/[.,!?]/g, '').toLowerCase();
  session.lastResponseOpener = firstWord || null;

  return { responseText, nextState, shouldAutoHangUp, parallelTtsResult, llmMs: llmResult.llmMs, ttsWaitMs };
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

  // 2. Create appointment in DB immediately — needed for appointment ID
  if (session.verifiedPatientId) {
    try {
      const appointment = await createAppointment({
        clinicId,
        patientId: session.verifiedPatientId,
        appointmentDate: isoDate,
        appointmentTime: isoTime,
        googleEventId: undefined,  // filled in by background task below
        createdVia: 'voice',
      });
      session.lastAppointmentId = appointment.id;
    } catch (err) {
      console.error(`[confirmBooking] DB appointment creation failed for session=${session.sessionId}, clinic=${clinicId}. Patient was told confirmed.`);
    }
  }

  session.bookingConfirmed = true;
  const resp = `Confirmed for ${rawDate} at ${rawTime}! Check your texts.`;

  // 3. Fire-and-forget: calendar event + SMS + form link — none of these block the voice response.
  // Captured in closure so the call can return immediately.
  const _patientId = session.verifiedPatientId;
  const _appointmentId = session.lastAppointmentId;
  const _phone = session.collectedData.phone!;
  const _name = session.collectedData.name!;
  const _bookingDate = session.bookingDate!;
  const _bookingTime = session.bookingTime!;

  setImmediate(async () => {
    // 3a. Google Calendar event
    let googleEventId: string | null = null;
    try {
      const calEvent = await createCalendarEvent({ clinicId, slot, summary: 'Appointment' });
      googleEventId = calEvent.eventId;
      if (_appointmentId && googleEventId) {
        await query(
          'UPDATE appointments SET google_event_id = $1 WHERE id = $2',
          [googleEventId, _appointmentId]
        );
      }
    } catch {
      console.warn(`[confirmBooking] Background: calendar event creation failed, clinic=${clinicId}`);
    }

    // 3b. Confirmation SMS
    try {
      const settings = await getSettingsByClinicId(clinicId);
      const clinicName = settings?.clinicName || 'the clinic';
      await sendConfirmationSms(clinicId, _phone, _name, _bookingDate, _bookingTime, clinicName);
    } catch (smsErr) {
      console.warn('[confirmBooking] Background: confirmation SMS failed:', (smsErr as Error).message);
    }

    // 3c. Intake form link SMS
    if (_patientId && _appointmentId) {
      try {
        const { createFormToken } = require('../../services/formTokenService');
        const token = await createFormToken({ clinicId, appointmentId: _appointmentId, patientId: _patientId });
        const formUrl = `${config.frontendUrl}/intake/${token}`;
        await sendFormLinkSms(clinicId, _phone, formUrl);
        console.log(JSON.stringify({ level: 'info', service: 'conversationManager', message: 'Background: form link sent', clinicId, appointmentId: _appointmentId }));
      } catch (err) {
        console.warn(JSON.stringify({ level: 'warn', service: 'conversationManager', message: 'Background: form link SMS failed', clinicId, error: err instanceof Error ? err.message : 'Unknown' }));
      }
    }
  });

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
  const { responseText, nextState, shouldAutoHangUp, parallelTtsResult, llmMs, ttsWaitMs } = await processState(session, transcript);
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

  // 7. Fire-and-forget DB save — don't wait for it, TTS is the bottleneck.
  saveSessionToDB(session).catch(() => undefined);

  // 8. TTS — use parallel result if available (started during LLM stream), else synthesize now
  let ttsResult: TtsResult | null = parallelTtsResult;
  if (!ttsResult) {
    ttsResult = await synthesize({ text: responseText, sessionId, clinicId }).catch(() => null);
  }

  const t4 = Date.now(); // TTS complete

  // Latency log — passive measurement, never delays the pipeline
  console.log(JSON.stringify({
    level: 'info',
    service: 'latency',
    sessionId,
    turn: session.turnCount,
    stt_ms: t1 - t0,
    llm_ms: llmMs,
    tts_wait_ms: ttsWaitMs,        // time waiting for parallel TTS after LLM returned
    logic_ms: t3 - t2 - llmMs - ttsWaitMs,  // pure state-machine + DB overhead
    tts_serial_ms: t4 - t3,        // sequential TTS (0 when parallel TTS was used)
    total_ms: t4 - t0,
    state: session.state,
  }));

  // 9. Fire-and-forget: persist turn to DB for dashboard debugging.
  // transcript_text / response_text are PHI — only stored when STORE_TRANSCRIPTS=true.
  const logicMs = t3 - t2 - llmMs - ttsWaitMs;
  insertConversationTurn({
    callLogId: session.callLogId,
    clinicId: session.clinicId,
    sessionId,
    turnNumber: session.turnCount,
    state: session.state,
    transcriptText: config.storeTranscripts ? transcript : null,
    responseText: config.storeTranscripts ? responseText : null,
    sttMs: t1 - t0,
    llmMs,
    ttsWaitMs,
    logicMs,
    ttsSerialMs: t4 - t3,
    totalMs: t4 - t0,
  }).catch(() => undefined);

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
