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

export type VerificationStep =
  | 'await_first_name'
  | 'confirm_first_name'
  | 'await_last_name'
  | 'confirm_last_name'
  | 'await_dob'
  | 'confirm_dob'
  | 'await_phone'
  | 'confirm_phone'
  | 'complete'
  | 'llm_override';

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
  latencies: number[];            // per-turn totalMs â€” in-memory only, for avg at hangup
  conversationHistory: Array<{role: 'user' | 'assistant'; content: string}>;  // last 3 turns for LLM context
  nameConfirmed: boolean;         // true once last name spelling confirmed
  firstNameConfirmed: boolean;    // true once first name spelling confirmed
  lastResponseOpener: string | null; // first word of last AI turn (prevents opener repetition)
  verificationStep: VerificationStep;  // current sub-step in identity step machine
  firstNameRaw: string | null;         // first name only during step machine collection
  nameConfirmAttempts: number;         // confirmation retry counter
  callerPhone: string | null;          // inbound caller number for SMS fallback
  spellingRetries: number;             // total re-ask count across all identity steps
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineTurnInput {
  sessionId: string;
  clinicId: string;
  callLogId?: string | null;
  transcriptFragment?: string;
  audioChunk?: Buffer;
  callerPhone?: string | null;
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
// Natural spelling detection â€” converts "A-M-I-T" or "A M I T" to "Amit"
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
 *   "A-M-I-T", "A.M.I.T", "a - m - i - t"     â†’ "Amit"
 *   "A M I T" / "a m i t" (3+ consecutive)    â†’ "Amit"
 *   "A as in Alpha, M as in Mike â€¦"           â†’ "Amit"
 */
export function preprocessSpelledLetters(text: string): string {
  let result = text.trim();

  // Step 1 â€” NATO phonetic: "X as in Word" â†’ letter, e.g. "A as in Alpha" â†’ "A"
  result = result.replace(
    /\b([A-Za-z]) as in ([A-Za-z]+(?:-[A-Za-z]+)?)\b/gi,
    (_m, letter: string, phonetic: string) =>
      PHONETIC_REVERSE[phonetic.toLowerCase()] ?? letter.toUpperCase(),
  );

  // Step 1b — Bare NATO phonetic word sequences (3+ consecutive) without "as in".
  // e.g. "Alpha Mike India Tango Hotel" → "Amith"
  {
    const knownPhonetics = new Set(Object.keys(PHONETIC_REVERSE));
    result = result.replace(
      /\b([A-Za-z]+(?:\s+[A-Za-z]+){2,})\b/g,
      (match: string) => {
        const words = match.trim().toLowerCase().split(/\s+/);
        if (words.length < 3) return match;
        if (!words.every((w: string) => knownPhonetics.has(w))) return match;
        const letters = words.map((w: string) => PHONETIC_REVERSE[w]!);
        return letters[0] + letters.slice(1).map((l: string) => l.toLowerCase()).join('');
      },
    );
  }

  // Step 2 â€” Separator-delimited single letters (3+), allowing optional spaces around separator.
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

  // Step 2b â€” Comma-separated single letters (3+): "A, M, I, T" or "A,M,I,T" â†’ "Amit"
  result = result.replace(
    /\b([A-Za-z])(?:,\s*([A-Za-z])){2,}\b/g,
    (match: string) => {
      const chars = match.split(/,\s*/).map((c: string) => c.trim().toUpperCase());
      return chars[0] + chars.slice(1).map((c: string) => c.toLowerCase()).join('');
    },
  );

  // Step 3 â€” Space-separated single letters (3+): "A M I T" or "a m i t" â†’ "Amit"
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
  const hasCancel = /\b(cancel|call off)\b/.test(t);
  const hasReschedule = /\b(reschedule|change|move|modify|postpone|push back|different day|different time)\b/.test(t) && /\bappointment\b/.test(t);
  const hasBook = /\b(book|schedule|appointment|make an appointment|need an appointment|set up|set an|see a doctor|see the doctor|new appointment|need to see|want to see|come in)\b/.test(t);

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

  // Name: "my name is X Y", "I am X Y", "I'm X", "this is X Y" â€” use preprocessed for spelling
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
  // Only fires when no other name was found and the entire preprocessed transcript is 1â€“3 title-case words.
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
  const dobSlash = transcript.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);

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

  // ISO: YYYY-MM-DD â†’ MM/DD/YYYY
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

// (extractWithLLM removed â€” replaced by callLLM in llmPromptService.ts)

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
  callLogId: string | null,
  callerPhone: string | null = null,
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
    verificationStep: 'await_first_name',
    firstNameRaw: null,
    nameConfirmAttempts: 0,
    callerPhone,
    spellingRetries: 0,
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
 * "Amit" â†’ "A as in Alpha, M as in Mike, I as in India, T as in Tango"
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
 * "Sarah" â†’ "S as in Sierra, A as in Alpha, R as in Romeo, A as in Alpha, H as in Hotel"
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
      message: 'getClinicName failed â€” using fallback',
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
      verificationStep: session.verificationStep,
      firstNameRaw: session.firstNameRaw,
      nameConfirmAttempts: session.nameConfirmAttempts,
      callerPhone: session.callerPhone,
      spellingRetries: session.spellingRetries,
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
    // Non-fatal â€” session still works from memory
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
      message: 'updateCallLogStatus failed â€” non-fatal',
      callLogId,
      clinicId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// Hybrid script â€” static phrases (must match WARMUP_PHRASES in ttsService.ts exactly)
// ---------------------------------------------------------------------------

const STATIC = {
  greeting:      'Welcome! To book, reschedule, or cancel, just say which one.',
  firstNameAsk:  "What's your first name?",
  lastNameAsk:   'And your last name?',
  dobAsk:        'Date of birth?',
  phoneAsk:      'Best phone number?',
  sayAgain:      'Sorry, could you say that again?',
  dateTimeAsk:   'What day and time works for you?',
  cancelAsk:     'Got it. Which appointment would you like to cancel?',
  rescheduleAsk: 'Sure. What date works for the new appointment?',
  bookingDone:   "You'll get a text confirmation. Have a great day, bye!",
  phoneRetry:    'Please give all 10 digits.',
} as const;

// ---------------------------------------------------------------------------
// Hybrid helpers â€” intent keyword, yes/no, name extraction, confirmations
// ---------------------------------------------------------------------------

function detectIntentKeyword(preprocessed: string): IntentType | null {
  const t = preprocessed.toLowerCase();
  const hasCancel = /\b(cancel|call off)\b/.test(t);
  const hasReschedule = /\b(reschedule|change my appointment|move.*appointment|modify|postpone|push back|different day|different time|change the time|change the date)\b/.test(t);
  const hasBook = /\b(book|schedule|appointment|make an appointment|need an appointment|set up|set an|see a doctor|see the doctor|new appointment|need to see|want to see|come in)\b/.test(t);
  if (hasCancel && !hasReschedule) return 'cancel_appointment';
  if (hasReschedule) return 'reschedule_appointment';
  if (hasBook) return 'book_appointment';
  return null;
}

function detectYesNo(transcript: string): 'yes' | 'no' | null {
  const t = transcript.toLowerCase();
  if (/\b(yes|yeah|yep|yup|correct|right|sure|absolutely|that's right|that's correct|you're right|you are right|exactly|confirmed|go ahead|perfect|spot on|sounds good|sounds right|great|good|affirmative|that's it|that is correct|that is right)\b/.test(t)) return 'yes';
  if (/\b(no|nope|nah|wrong|incorrect|not right|that's wrong|not quite|not correct|that's not right|that is not right|not exactly)\b/.test(t)) return 'no';
  return null;
}

/** Detect requests to append a letter: "add H at the end", "missing an H", "H at the end" */
function detectAppendLetter(text: string): string | null {
  // "add H", "adding H", "add an H", "add the letter H", "add H at the end"
  let m = text.match(
    /\badd(?:ing)?\s+(?:the\s+(?:letter\s+)?|an?\s+)?([A-Za-z])\b(?:\s+at\s+the\s+end)?/i,
  );
  if (m) return m[1].toUpperCase();
  // "missing an H", "missing H"
  m = text.match(/\bmissing\s+(?:an?\s+)?([A-Za-z])\b/i);
  if (m) return m[1].toUpperCase();
  // "need an H", "needs H", "it needs an H"
  m = text.match(/\bneed(?:s)?\s+(?:an?\s+)?([A-Za-z])\b/i);
  if (m) return m[1].toUpperCase();
  // "there's an H", "there is an H"
  m = text.match(/\bthere(?:'s|\s+is)\s+(?:an?\s+)?([A-Za-z])\b/i);
  if (m) return m[1].toUpperCase();
  // "plus H", "and H", "and an H at the end"
  m = text.match(/\b(?:plus|and)\s+(?:an?\s+)?([A-Za-z])\b(?:\s+at\s+the\s+end)?/i);
  if (m) return m[1].toUpperCase();
  // "H at the end"
  m = text.match(/\b([A-Za-z])\s+at\s+the\s+end\b/i);
  if (m) return m[1].toUpperCase();
  // "ends with H", "ending in H"
  m = text.match(/\bend(?:s|ing)\s+(?:with|in)\s+([A-Za-z])\b/i);
  if (m) return m[1].toUpperCase();
  return null;
}

/** Detect requests to remove the last letter */
function detectRemoveLastLetter(text: string): boolean {
  return (
    /\b(?:remove|drop|take\s+off|delete|without|minus)\s+the\s+last\s+(?:letter|character|one)?\b/i.test(text) ||
    /\bshorten\s+(?:it|the\s+name)\b/i.test(text)
  );
}

function extractNameSimple(preprocessed: string): string | null {
  const named = preprocessed.match(
    /(?:my first name is|my last name is|my first name's|my last name's|first name is|last name is|first name's|last name's|my name is|my name's|i'm called|i am called|this is|i am|i'm|name's|it is|it's|called)\s+([A-Za-z]+(?:\s+[A-Za-z]+)*)/i
  );
  if (named) {
    return named[1].trim().split(/\s+/)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }
  // Strip trailing Deepgram smart_format punctuation (e.g. "Amith.")
  const cleaned = preprocessed.replace(/[.,!?;:]+$/, '').trim();
  // Bare name: 1â€“3 words, any capitalisation (Deepgram varies)
  const STOP_WORDS = new Set([
    'you','your','yes','yeah','yep','no','nope','nah',
    'ok','okay','sure','hi','hello','hey','bye','goodbye',
    'thanks','thank','please','sorry','what','when','where',
    'the','a','an','and','or','but','for','with','from',
    'my','me','i','we','he','she','they','it','this','that',
    // Verbs / auxiliaries
    'are','is','am','was','were','be','been','being',
    'do','does','did','done','have','has','had',
    'will','would','could','should','may','might','shall','can',
    // Adverbs / question words / fillers
    'there','here','now','then','so','how','who','which','if','as',
    'not','just','still','also','too','very','much','all','any','some',
    'up','out','off','at','by','on','in','to','of','into','about','after',
    // Pronouns
    'him','his','her','its','their','our','them','us',
    // Filler sounds
    'um','uh','hmm','hm','err','ah','oh',
  ]);
  const bare = cleaned.match(/^([A-Za-z]+(?:\s+[A-Za-z]+){0,2})$/);
  if (bare) {
    const words = bare[1].trim().toLowerCase().split(/\s+/);
    if (words.every((w: string) => STOP_WORDS.has(w))) return null;
    return bare[1].trim().split(/\s+/)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }
  // Fallback: strip internal commas and retry.
  // Handles "Chidre, Chidre" from "Chidre C-H-I-D-R-E" where Deepgram adds a comma.
  const noComma = cleaned.replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (noComma !== cleaned) {
    const bare2 = noComma.match(/^([A-Za-z]+(?:\s+[A-Za-z]+){0,2})$/);
    if (bare2) {
      const words2 = bare2[1].trim().toLowerCase().split(/\s+/);
      if (!words2.every((w: string) => STOP_WORDS.has(w))) {
        return bare2[1].trim().split(/\s+/)
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');
      }
    }
  }
  return null;
}

/** "Amit" → "Is that A-M-I-T-H, Amith?" — compact dash format for fast TTS synthesis */
function buildSpellingConfirm(name: string): string {
  const letters = name.toUpperCase().split('').filter((c: string) => /[A-Z]/.test(c)).join(', ');
  return `Is that ${letters}? As in ${name}?`;
}

/** Build spelling-confirm text AND pre-synthesise TTS -- saves ~1.2s on identity turns */
async function spellConfirmWithTts(
  name: string,
  session: ConversationSession,
): Promise<{ responseText: string; parallelTtsResult: TtsResult | null }> {
  const responseText = buildSpellingConfirm(name);
  const parallelTtsResult = await synthesize({
    text: responseText,
    sessionId: session.sessionId,
    clinicId: session.clinicId,
  }).catch(() => null);
  return { responseText, parallelTtsResult };
}

/** "03/30/1985" â†’ "March 30th 1985, correct?" */
function buildDOBConfirm(dob: string): string {
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const parts = dob.split('/');
  if (parts.length !== 3) return `${dob}, correct?`;
  const m = parseInt(parts[0], 10) - 1;
  const d = parseInt(parts[1], 10);
  const y = parts[2];
  const suffix = (d >= 11 && d <= 13) ? 'th'
    : d % 10 === 1 ? 'st'
    : d % 10 === 2 ? 'nd'
    : d % 10 === 3 ? 'rd'
    : 'th';
  return `${MONTH_NAMES[m] ?? 'Unknown'} ${d}${suffix} ${y}, correct?`;
}

/** "9063338206" â†’ "And 9-0-6-3-3-3-8-2-0-6, correct?" */
function buildPhoneConfirm(phone: string): string {
  return `And ${phone.split('').join('-')}, correct?`;
}

// ---------------------------------------------------------------------------
// Identity verification completion â€” upsert patient, advance to booking
// ---------------------------------------------------------------------------

async function handleVerificationComplete(
  session: ConversationSession,
): Promise<{ responseText: string; nextState: ConversationState; shouldAutoHangUp: boolean; parallelTtsResult: TtsResult | null; llmMs: number; ttsWaitMs: number }> {
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
      event: 'identity_verified_step_machine',
      sessionId: session.sessionId,
      clinicId: session.clinicId,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'conversationManager',
      message: 'upsertPatient failed in handleVerificationComplete',
      sessionId: session.sessionId,
      error: (err as Error).message,
    }));
    return {
      responseText: "I'm having trouble verifying your information. Let me connect you with a staff member.",
      nextState: 'handoff',
      shouldAutoHangUp: false,
      parallelTtsResult: null,
      llmMs: 0,
      ttsWaitMs: 0,
    };
  }

  // Route to appropriate flow based on intent
  if (session.intent === 'cancel_appointment') {
    return { responseText: STATIC.cancelAsk, nextState: 'cancel_flow', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
  } else if (session.intent === 'reschedule_appointment') {
    return { responseText: STATIC.rescheduleAsk, nextState: 'reschedule_flow', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
  }
  // book_appointment or unknown
  return { responseText: STATIC.dateTimeAsk, nextState: 'awaiting_date', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
}

// ---------------------------------------------------------------------------
// DOB text pre-processor â€” converts ordinal words and spoken years to digit form
// before the keywordExtract DOB regexes run.  Called only in await_dob.
// ---------------------------------------------------------------------------

function preprocessDOBText(text: string): string {
  let t = text;

  // Ordinal words â†’ ordinal digits ("fifth" â†’ "5th", "third" â†’ "3rd", etc.)
  const ORDINALS: Record<string, string> = {
    first:'1st', second:'2nd', third:'3rd', fourth:'4th', fifth:'5th',
    sixth:'6th', seventh:'7th', eighth:'8th', ninth:'9th', tenth:'10th',
    eleventh:'11th', twelfth:'12th', thirteenth:'13th', fourteenth:'14th',
    fifteenth:'15th', sixteenth:'16th', seventeenth:'17th', eighteenth:'18th',
    nineteenth:'19th', twentieth:'20th',
    'twenty-first':'21st', 'twenty-second':'22nd', 'twenty-third':'23rd',
    'twenty-fourth':'24th', 'twenty-fifth':'25th', 'twenty-sixth':'26th',
    'twenty-seventh':'27th', 'twenty-eighth':'28th', 'twenty-ninth':'29th',
    thirtieth:'30th', 'thirty-first':'31st',
  };
  for (const [word, digit] of Object.entries(ORDINALS)) {
    t = t.replace(new RegExp(`\\b${word}\\b`, 'gi'), digit);
  }

  // Spoken years: "nineteen ninety" â†’ "1990", "nineteen eighty five" â†’ "1985"
  const TENS: Record<string, number> = {
    ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
    sixteen:16, seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30,
    forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90,
  };
  const ONES: Record<string, number> = {
    one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  };
  t = t.replace(
    /\bninete{1,2}n\s+(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:\s+(one|two|three|four|five|six|seven|eight|nine))?\b/gi,
    (_m: string, tens: string, units?: string) => {
      const y = 1900 + (TENS[tens.toLowerCase()] || 0) + (units ? (ONES[units.toLowerCase()] || 0) : 0);
      return String(y);
    },
  );
  // "two thousand [optional part]" â†’ 2000â€“2029
  t = t.replace(
    /\btwo\s+thousand(?:\s+(?:and\s+)?(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|one|two|three|four|five|six|seven|eight|nine|zero)(?:\s+(one|two|three|four|five|six|seven|eight|nine))?)?\b/gi,
    (_m: string, part1?: string, part2?: string) => {
      const T2: Record<string,number> = {twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
      const AL: Record<string,number> = {zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19};
      if (!part1) return '2000';
      const p = part1.toLowerCase();
      if (T2[p] !== undefined) {
        return String(2000 + T2[p] + (part2 ? (AL[part2.toLowerCase()] || 0) : 0));
      }
      return String(2000 + (AL[p] || 0));
    },
  );

  // Cardinal day-number words → digits (handles "thirty March" when caller uses cardinal).
  // Year-words like "eighty" are already gone after year conversion above.
  // Process compound forms first (twenty-eight before twenty).
  const CARDINAL_DAY_MAP: [RegExp, string][] = [
    [/\bthirty[- ]?one\b/gi, '31'], [/\btwenty[- ]?nine\b/gi, '29'],
    [/\btwenty[- ]?eight\b/gi, '28'], [/\btwenty[- ]?seven\b/gi, '27'],
    [/\btwenty[- ]?six\b/gi, '26'], [/\btwenty[- ]?five\b/gi, '25'],
    [/\btwenty[- ]?four\b/gi, '24'], [/\btwenty[- ]?three\b/gi, '23'],
    [/\btwenty[- ]?two\b/gi, '22'], [/\btwenty[- ]?one\b/gi, '21'],
    [/\bthirty\b/gi, '30'], [/\btwenty\b/gi, '20'],
    [/\beighteen\b/gi, '18'], [/\bseventeen\b/gi, '17'],
    [/\bsixteen\b/gi, '16'], [/\bfifteen\b/gi, '15'],
    [/\bfourteen\b/gi, '14'], [/\bthirteen\b/gi, '13'],
    [/\btwelve\b/gi, '12'], [/\beleven\b/gi, '11'], [/\bten\b/gi, '10'],
    [/\bnine\b/gi, '9'], [/\beight\b/gi, '8'], [/\bseven\b/gi, '7'],
    [/\bsix\b/gi, '6'], [/\bfive\b/gi, '5'], [/\bfour\b/gi, '4'],
    [/\bthree\b/gi, '3'], [/\btwo\b/gi, '2'], [/\bone\b/gi, '1'],
  ];
  for (const [re, digit] of CARDINAL_DAY_MAP) {
    t = t.replace(re, digit);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Identity verification step machine â€” NO LLM for normal turns.
// Falls back to LLM (via processState with llm_override) on unexpected input.
// ---------------------------------------------------------------------------

async function handleSmsVerificationFallback(
  session: ConversationSession,
): Promise<{ responseText: string; nextState: ConversationState; shouldAutoHangUp: boolean; parallelTtsResult: TtsResult | null; llmMs: number; ttsWaitMs: number }> {
  if (session.callerPhone) {
    import('../../services/smsService').then((smsModule) => {
      smsModule.sendVerificationHelpSms(session.clinicId, session.callerPhone!).catch(() => {});
    }).catch(() => {});
  }
  return {
    responseText:
      "I'm having some trouble capturing your details. I've just sent you a text message — " +
      "please reply with your full name and date of birth and we'll get you booked. Have a great day!",
    nextState: 'completed',
    shouldAutoHangUp: true,
    parallelTtsResult: null,
    llmMs: 0,
    ttsWaitMs: 0,
  };
}

async function processIdentityVerificationStep(
  session: ConversationSession,
  transcript: string,
): Promise<{ responseText: string; nextState: ConversationState; shouldAutoHangUp: boolean; parallelTtsResult: TtsResult | null; llmMs: number; ttsWaitMs: number }> {
  const preprocessed = preprocessSpelledLetters(transcript);

  // SMS fallback: if caller has been stuck for too many re-asks, send a text and hang up
  if (session.spellingRetries >= 5) {
    return handleSmsVerificationFallback(session);
  }

  switch (session.verificationStep) {
    case 'await_first_name': {
      const name = extractNameSimple(preprocessed);
      if (!name) {
        // Re-ask without LLM
        session.spellingRetries++;
        return { responseText: STATIC.firstNameAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      session.firstNameRaw = name.split(/\s+/)[0]; // first token only
      session.collectedData.name = session.firstNameRaw;
      session.verificationStep = 'confirm_first_name';
      const { responseText: rt1, parallelTtsResult: pt1 } = await spellConfirmWithTts(session.firstNameRaw, session);
      return { responseText: rt1, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: pt1, llmMs: 0, ttsWaitMs: 0 };
    }

    case 'confirm_first_name': {
      // Check corrections FIRST — works whether user says "no, add H" or just "add H at the end"
      if (session.firstNameRaw) {
        const appendLFN = detectAppendLetter(preprocessed);
        if (appendLFN) {
          const rawFN = session.firstNameRaw + appendLFN.toLowerCase();
          const firstName = rawFN.charAt(0).toUpperCase() + rawFN.slice(1);
          session.firstNameRaw = firstName;
          session.collectedData.name = firstName;
          session.verificationStep = 'confirm_first_name';
          const { responseText: rtA, parallelTtsResult: ptA } = await spellConfirmWithTts(firstName, session);
          return { responseText: rtA, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptA, llmMs: 0, ttsWaitMs: 0 };
        }
        if (detectRemoveLastLetter(preprocessed) && session.firstNameRaw.length > 1) {
          const firstName = session.firstNameRaw.slice(0, -1);
          session.firstNameRaw = firstName;
          session.collectedData.name = firstName;
          session.verificationStep = 'confirm_first_name';
          const { responseText: rtB, parallelTtsResult: ptB } = await spellConfirmWithTts(firstName, session);
          return { responseText: rtB, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptB, llmMs: 0, ttsWaitMs: 0 };
        }
      }
      const yn = detectYesNo(transcript);
      if (yn === 'yes') {
        session.firstNameConfirmed = true;
        session.nameConfirmAttempts = 0;
        session.verificationStep = 'await_last_name';
        return { responseText: STATIC.lastNameAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      if (yn === 'no') {
        // Try inline correction: "No, Amith" or "No, actually Amy"
        const noStrippedFN = preprocessed.replace(/^\s*(?:no|nope|nah|wrong|incorrect|not right)[,.\s]+/i, '').trim();
        if (noStrippedFN) {
          const correctedFN = extractNameSimple(noStrippedFN);
          if (correctedFN) {
            const firstName = correctedFN.split(/\s+/)[0];
            session.firstNameRaw = firstName;
            session.collectedData.name = firstName;
            session.verificationStep = 'confirm_first_name';
            const { responseText: rtC, parallelTtsResult: ptC } = await spellConfirmWithTts(firstName, session);
            return { responseText: rtC, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptC, llmMs: 0, ttsWaitMs: 0 };
          }
        }
        session.spellingRetries++;
        session.firstNameRaw = null;
        session.collectedData.name = undefined;
        session.verificationStep = 'await_first_name';
        return { responseText: STATIC.firstNameAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      // Bare single letter (e.g. Deepgram fires "H" as a split speech_final) — append it
      if (session.firstNameRaw && /^[A-Za-z]$/.test(preprocessed.trim())) {
        const rawFN = session.firstNameRaw + preprocessed.trim().toLowerCase();
        const firstName = rawFN.charAt(0).toUpperCase() + rawFN.slice(1);
        session.firstNameRaw = firstName;
        session.collectedData.name = firstName;
        session.verificationStep = 'confirm_first_name';
        const { responseText: rtAB, parallelTtsResult: ptAB } = await spellConfirmWithTts(firstName, session);
        return { responseText: rtAB, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptAB, llmMs: 0, ttsWaitMs: 0 };
      }
      // User re-spelled their name as a correction (e.g. "A M I T H" when we had "A M I T")
      const reSpelledFN = extractNameSimple(preprocessed);
      if (reSpelledFN && reSpelledFN.toLowerCase() !== (session.firstNameRaw ?? '').toLowerCase()) {
        const firstName = reSpelledFN.split(/\s+/)[0];
        session.firstNameRaw = firstName;
        session.collectedData.name = firstName;
        session.verificationStep = 'confirm_first_name';
        const { responseText: rtRS, parallelTtsResult: ptRS } = await spellConfirmWithTts(firstName, session);
        return { responseText: rtRS, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptRS, llmMs: 0, ttsWaitMs: 0 };
      }
      // Truly ambiguous -- re-ask the confirm question
      session.spellingRetries++;
      const { responseText: rt3, parallelTtsResult: pt3 } = await spellConfirmWithTts(session.firstNameRaw ?? '', session);
      return { responseText: rt3, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: pt3, llmMs: 0, ttsWaitMs: 0 };
    }
    case 'await_last_name': {
      const lname = extractNameSimple(preprocessed);
      if (!lname) {
        session.spellingRetries++;
        return { responseText: STATIC.lastNameAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      const lastName = lname.split(/\s+/).slice(-1)[0];
      session.collectedData.name = `${session.firstNameRaw ?? ''} ${lastName}`.trim();
      session.verificationStep = 'confirm_last_name';
      const { responseText: rt2, parallelTtsResult: pt2 } = await spellConfirmWithTts(lastName, session);
      return { responseText: rt2, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: pt2, llmMs: 0, ttsWaitMs: 0 };
    }

    case 'confirm_last_name': {
      // Check corrections FIRST — works whether user says "no, add E" or just "add E at the end"
      const currentLN = (session.collectedData.name ?? '').trim().split(/\s+/).slice(-1)[0] ?? '';
      if (currentLN) {
        const appendLLN = detectAppendLetter(preprocessed);
        if (appendLLN) {
          const lastName = currentLN + appendLLN.toLowerCase();
          session.collectedData.name = `${session.firstNameRaw ?? ''} ${lastName}`.trim();
          session.verificationStep = 'confirm_last_name';
          const { responseText: rtD, parallelTtsResult: ptD } = await spellConfirmWithTts(lastName, session);
          return { responseText: rtD, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptD, llmMs: 0, ttsWaitMs: 0 };
        }
        if (detectRemoveLastLetter(preprocessed) && currentLN.length > 1) {
          const lastName = currentLN.slice(0, -1);
          session.collectedData.name = `${session.firstNameRaw ?? ''} ${lastName}`.trim();
          session.verificationStep = 'confirm_last_name';
          const { responseText: rtE, parallelTtsResult: ptE } = await spellConfirmWithTts(lastName, session);
          return { responseText: rtE, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptE, llmMs: 0, ttsWaitMs: 0 };
        }
      }
      const yn = detectYesNo(transcript);
      if (yn === 'yes') {
        session.nameConfirmed = true;
        session.nameConfirmAttempts = 0;
        session.verificationStep = 'await_dob';
        return { responseText: STATIC.dobAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      if (yn === 'no') {
        // Try inline correction: "No, Chidre" or "No, it's C-H-I-D-R-E"
        const noStrippedLN = preprocessed.replace(/^\s*(?:no|nope|nah|wrong|incorrect|not right)[,.\s]+/i, '').trim();
        if (noStrippedLN) {
          const correctedLN = extractNameSimple(noStrippedLN);
          if (correctedLN) {
            const lastName = correctedLN.split(/\s+/).slice(-1)[0];
            session.collectedData.name = `${session.firstNameRaw ?? ''} ${lastName}`.trim();
            session.verificationStep = 'confirm_last_name';
            const { responseText: rtF, parallelTtsResult: ptF } = await spellConfirmWithTts(lastName, session);
            return { responseText: rtF, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptF, llmMs: 0, ttsWaitMs: 0 };
          }
        }
        session.spellingRetries++;
        const parts2 = (session.collectedData.name ?? '').trim().split(/\s+/);
        session.collectedData.name = parts2[0] ?? '';
        session.verificationStep = 'await_last_name';
        return { responseText: STATIC.lastNameAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      // Bare single letter — append it (handles split speech_final)
      const curLNAmb = (session.collectedData.name ?? '').trim().split(/\s+/).slice(-1)[0] ?? '';
      if (curLNAmb && /^[A-Za-z]$/.test(preprocessed.trim())) {
        const lastName = curLNAmb + preprocessed.trim().toLowerCase();
        session.collectedData.name = `${session.firstNameRaw ?? ''} ${lastName}`.trim();
        session.verificationStep = 'confirm_last_name';
        const { responseText: rtLB, parallelTtsResult: ptLB } = await spellConfirmWithTts(lastName, session);
        return { responseText: rtLB, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptLB, llmMs: 0, ttsWaitMs: 0 };
      }
      // User re-spelled (e.g. "C H I D R E" when we had "C H I D R")
      const reSpelledLN = extractNameSimple(preprocessed);
      if (reSpelledLN && reSpelledLN.toLowerCase() !== curLNAmb.toLowerCase()) {
        const lastName = reSpelledLN.split(/\s+/).slice(-1)[0];
        session.collectedData.name = `${session.firstNameRaw ?? ''} ${lastName}`.trim();
        session.verificationStep = 'confirm_last_name';
        const { responseText: rtRSL, parallelTtsResult: ptRSL } = await spellConfirmWithTts(lastName, session);
        return { responseText: rtRSL, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: ptRSL, llmMs: 0, ttsWaitMs: 0 };
      }
      // Truly ambiguous -- re-ask
      session.spellingRetries++;
      const lastN = curLNAmb;
      const { responseText: rt4, parallelTtsResult: pt4 } = await spellConfirmWithTts(lastN, session);
      return { responseText: rt4, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: pt4, llmMs: 0, ttsWaitMs: 0 };
    }
    case 'await_dob': {
      const dobPreprocessed = preprocessDOBText(transcript);
      const extracted = keywordExtract(dobPreprocessed);
      if (!extracted.dateOfBirth) {
        session.spellingRetries++;
        return { responseText: STATIC.dobAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      session.collectedData.dateOfBirth = extracted.dateOfBirth;
      session.verificationStep = 'confirm_dob';
      return { responseText: buildDOBConfirm(extracted.dateOfBirth), nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
    }

    case 'confirm_dob': {
      const yn = detectYesNo(transcript);
      if (yn === 'yes') {
        session.verificationStep = 'await_phone';
        return { responseText: STATIC.phoneAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      if (yn === 'no') {
        session.collectedData.dateOfBirth = undefined;
        session.verificationStep = 'await_dob';
        return { responseText: STATIC.dobAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      // Ambiguous â€” re-ask
      return { responseText: buildDOBConfirm(session.collectedData.dateOfBirth ?? ''), nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
    }

    case 'await_phone': {
      const extracted = keywordExtract(transcript);
      if (!extracted.phone) {
        // If the caller has already started saying digits, give format guidance
        const hasDigits = /\d/.test(transcript);
        const reAsk = hasDigits ? STATIC.phoneRetry : STATIC.phoneAsk;
        return { responseText: reAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      session.collectedData.phone = `+1${extracted.phone}`;
      session.verificationStep = 'confirm_phone';
      return { responseText: buildPhoneConfirm(extracted.phone), nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
    }

    case 'confirm_phone': {
      const yn = detectYesNo(transcript);
      if (yn === 'yes') {
        session.verificationStep = 'complete';
        return handleVerificationComplete(session);
      } else if (yn === 'no') {
        // Clear phone and re-ask directly (clear rejection, no LLM needed)
        session.collectedData.phone = undefined;
        session.verificationStep = 'await_phone';
        return { responseText: STATIC.phoneAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      // Ambiguous â€” re-ask confirm phone
      return { responseText: buildPhoneConfirm((session.collectedData.phone ?? '').replace(/^\+1/, '')), nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
    }

    case 'complete':
      return handleVerificationComplete(session);

    default: {
      session.verificationStep = 'await_first_name';
      return { responseText: STATIC.firstNameAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// State machine processor
// ---------------------------------------------------------------------------

async function processState(
  session: ConversationSession,
  transcript: string
): Promise<{ responseText: string; nextState: ConversationState; shouldAutoHangUp: boolean; parallelTtsResult: TtsResult | null; llmMs: number; ttsWaitMs: number }> {
  // Fast-exit: booking confirmed — any subsequent speech just gets a goodbye
  if (session.bookingConfirmed) {
    return { responseText: 'Thank you for calling. Goodbye!', nextState: 'completed', shouldAutoHangUp: true, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
  }

  // â”€â”€â”€ Greeting (hardcoded â€” no user input to process yet) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (session.state === 'greeting') {
    const clinicNameG = await getClinicName(session.clinicId);
    const greetingText = `Hi, thanks for calling ${clinicNameG}! Would you like to book, reschedule, or cancel an appointment?`;
    return { responseText: greetingText, nextState: 'intent_detection', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
  }

  // â”€â”€â”€ Intent detection: keyword fast-path â€” skips LLM for clear intents â”€â”€â”€â”€
  if (session.state === 'intent_detection') {
    const preprocessedForIntent = preprocessSpelledLetters(transcript);
    const detectedIntent = detectIntentKeyword(preprocessedForIntent);
    if (detectedIntent) {
      session.intent = detectedIntent;
      session.nameConfirmAttempts = 0;
      // Also try to extract a name if the caller said it in the same breath
      // (only use the named-phrase pattern â€” bare words like "book" would false-match)
      const namedMatch = preprocessedForIntent.match(
        /(?:my name is|my first name is|i am|i'm|this is|name's|it's|name is|called|booking for|appointment for|calling for|it is|i go by)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i
      );
      if (namedMatch) {
        const raw = namedMatch[1].trim().split(/\s+/)[0];
        const firstName = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
        session.firstNameRaw = firstName;
        session.collectedData.name = firstName;
        session.verificationStep = 'confirm_first_name';
        return { responseText: buildSpellingConfirm(firstName), nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
      }
      session.verificationStep = 'await_first_name';
      return { responseText: STATIC.firstNameAsk, nextState: 'identity_verification', shouldAutoHangUp: false, parallelTtsResult: null, llmMs: 0, ttsWaitMs: 0 };
    }
    // Unclear intent â†’ fall through to LLM
  }

  // â”€â”€â”€ Identity verification: step machine (no LLM unless unexpected input) â”€
  if (session.state === 'identity_verification') {
    return processIdentityVerificationStep(session, transcript);
  }

  // â”€â”€â”€ All other states (+ llm_override): single LLM call â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    nameConfirmed: session.nameConfirmed,
  };

  // Start TTS as soon as response_text is complete in the stream (parallel execution)
  let ttsPromise: Promise<TtsResult | null> | null = null;
  const onResponseTextReady = (text: string): void => {
    ttsPromise = synthesize({ text: formatTimeForSpeech(text), sessionId: session.sessionId, clinicId: session.clinicId }).catch(() => null);
  };

  const llmResult = await callLLM(ctx, preprocessed, clinicName, session.conversationHistory, onResponseTextReady);

  // LLM failure fallback â€” re-prompt without changing state
  if (!llmResult) {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'conversationManager',
      message: 'callLLM returned null â€” using re-prompt fallback',
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

  // â”€â”€ 1. Update session with extracted entities (never overwrite confirmed data) â”€â”€
  if (e.intent && (VALID_INTENTS as string[]).includes(e.intent) && !session.intent) {
    session.intent = e.intent as IntentType;
  }
  if (e.name && (!session.collectedData.name || !session.nameConfirmed)) {
    session.collectedData.name = e.name;
    session.nameConfirmed = false;  // awaiting verbal confirmation ("Is that [Name]?")
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

  // Name confirmed when caller says "yes" after AI asks "Is that [Name]?" in identity_verification
  if (e.isYes && session.collectedData.name && !session.nameConfirmed
      && (session.state as string) === 'identity_verification') {
    session.nameConfirmed = true;
  }

  // â”€â”€ 2. Side-effect: patient upsert when identity verification is complete â”€â”€
  const hasAllIdentityData =
    session.collectedData.name &&
    session.collectedData.dateOfBirth &&
    session.collectedData.phone &&
    session.nameConfirmed;  // name must be verbally confirmed before leaving verification
  const leavingVerification =
    (session.state as string) === 'identity_verification' && nextState !== 'identity_verification';

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
      ttsPromise = null; // discard parallel TTS (wrong audio) â€” re-synthesize for error message
    }
  }

  // Guard: prevent LLM from skipping identity_verification before all data is collected
  if (leavingVerification && !hasAllIdentityData && !session.identityVerified) {
    nextState = 'identity_verification';
  }

  // â”€â”€ 3. Side-effect: booking confirmation when caller says yes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    return { responseText: confirmResult.responseText, nextState: 'completed', shouldAutoHangUp: true, parallelTtsResult: confirmResult.ttsResult, llmMs: llmResult.llmMs, ttsWaitMs: 0 };
  }

  // â”€â”€ 4. Track failed attempts â€” escalate to handoff after 5 stuck turns â”€â”€â”€â”€
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

  // â”€â”€ 5. Update conversation history (keep last 3 turns = 6 messages) â”€â”€â”€â”€â”€â”€
  // IMPORTANT: store raw_json (not responseText) so the model sees its prior responses
  // were JSON and continues outputting JSON on every subsequent turn.
  session.conversationHistory.push({ role: 'user', content: preprocessed });
  session.conversationHistory.push({ role: 'assistant', content: llmResult.raw_json });
  if (session.conversationHistory.length > 6) {
    session.conversationHistory.splice(0, session.conversationHistory.length - 6);
  }

  const shouldAutoHangUp = (e.isGoodbye || false) && (nextState === 'handoff' || nextState === 'completed');

  // Await parallel TTS (started during LLM streaming â€” likely already done)
  const ttsWaitStart = Date.now();
  const parallelTtsResult: TtsResult | null = ttsPromise ? await ttsPromise : null;
  const ttsWaitMs = ttsPromise ? Date.now() - ttsWaitStart : 0;

  // Track opener word so the LLM avoids repeating the same opener next turn
  const firstWord = responseText.split(/\s+/)[0].replace(/[.,!?]/g, '').toLowerCase();
  session.lastResponseOpener = firstWord || null;

  return { responseText, nextState, shouldAutoHangUp, parallelTtsResult, llmMs: llmResult.llmMs, ttsWaitMs };
}

// ---------------------------------------------------------------------------
// Time format helper (AM/PM â†’ 24-h for calendar API)
// ---------------------------------------------------------------------------

/** Replace AM/PM with spaced letters so TTS clearly enunciates each (e.g. "10 a m" not "10am"). */
function formatTimeForSpeech(text: string): string {
  return text
    .replace(/(\d{1,2}:\d{2})\s*[Aa][Mm]\b/g, '$1 a m')
    .replace(/(\d{1,2})\s*[Aa][Mm]\b/g, '$1 a m')
    .replace(/(\d{1,2}:\d{2})\s*[Pp][Mm]\b/g, '$1 p m')
    .replace(/(\d{1,2})\s*[Pp][Mm]\b/g, '$1 p m');
}

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
// Date formatter â€” converts ISO "YYYY-MM-DD" to spoken English "Wednesday, April 9th"
// ---------------------------------------------------------------------------

function formatDateForSpeech(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  // Construct in local time to avoid UTC offset shifting the day
  const date = new Date(year, month - 1, day);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const d = day;
  const suffix = (d >= 11 && d <= 13) ? 'th'
    : d % 10 === 1 ? 'st'
    : d % 10 === 2 ? 'nd'
    : d % 10 === 3 ? 'rd'
    : 'th';
  return `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${d}${suffix}`;
}

// ---------------------------------------------------------------------------
// Shared booking confirmation logic (used by booking_flow + awaiting_time)
// ---------------------------------------------------------------------------

async function confirmBooking(
  session: ConversationSession,
  _transcript: string
): Promise<{ responseText: string; nextState: ConversationState; ttsResult: TtsResult | null }> {
  const clinicId = session.clinicId;
  const rawDate = session.bookingDate!;  // already ISO "YYYY-MM-DD" from LLM
  const rawTime = session.bookingTime!;
  const isoDate = rawDate;               // no conversion needed â€” LLM returns ISO directly
  const isoTime = resolveBookingTime(rawTime);
  const slot = { date: isoDate, time: isoTime, durationMinutes: 30 };

  // 1. Check slot availability â€” advisory only (Calendar integration is Phase 2, not yet complete).
  // If the slot shows as busy, log a warning and proceed; never block a booking due to calendar state.
  const available = await checkSlotAvailable(clinicId, slot);
  if (!available) {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'conversationManager',
      message: 'Slot shows as busy in calendar â€” proceeding with booking (advisory only, Phase 2)',
      clinicId,
      sessionId: session.sessionId,
      isoDate,
      isoTime,
    }));
  }

  session.bookingConfirmed = true;
  const resp = STATIC.bookingDone;

  // Start TTS first â€” DB write runs in parallel below (~200ms savings)
  const ttsPromise = synthesize({ text: resp, sessionId: session.sessionId, clinicId }).catch(() => null);

  // 2. Create appointment in DB â€” in parallel with TTS synthesis above
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

  // 3. Fire-and-forget: calendar event + SMS + form link â€” none of these block the voice response.
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

  const ttsResult = await ttsPromise;
  return { responseText: resp, nextState: 'completed', ttsResult };
}

// ---------------------------------------------------------------------------
// Main export â€” runPipelineTurn
// ---------------------------------------------------------------------------

export async function runPipelineTurn(
  input: PipelineTurnInput
): Promise<PipelineTurnOutput> {
  const { sessionId, clinicId, callLogId, transcriptFragment, audioChunk, callerPhone } = input;

  // 1. Get or create session
  const session = getOrCreateSession(sessionId, clinicId, callLogId ?? null, callerPhone ?? null);
  // Persist callerPhone on first turn (subsequent turns may not supply it)
  if (callerPhone && !session.callerPhone) session.callerPhone = callerPhone;

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

  // 3. EMERGENCY CHECK â€” always first
  if (transcript.length > 0 && detectEmergency(transcript)) {
    if (session.callLogId) {
      await updateCallLogStatus(session.callLogId, session.clinicId, 'completed');
    }
    clearSession(sessionId);

    console.log(JSON.stringify({
      level: 'warn',
      service: 'conversationManager',
      message: 'Emergency detected â€” call handed off',
      sessionId,
      clinicId,
    }));

    let ttsResult: TtsResult | null = null;
    try {
      ttsResult = await synthesize({ text: EMERGENCY_RESPONSE, sessionId, clinicId });
    } catch {
      // TTS failure is non-fatal â€” text response still returned
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

  // 6. Log state transition (never log transcript â€” PHI)
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

  // 7. Fire-and-forget DB save â€” don't wait for it, TTS is the bottleneck.
  saveSessionToDB(session).catch(() => undefined);

  // 8. TTS â€” use parallel result if available (started during LLM stream), else synthesize now
  let ttsResult: TtsResult | null = parallelTtsResult;
  if (!ttsResult) {
    ttsResult = await synthesize({ text: formatTimeForSpeech(responseText), sessionId, clinicId }).catch(() => null);
  }

  const t4 = Date.now(); // TTS complete

  // Latency log â€” passive measurement, never delays the pipeline
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
  // transcript_text / response_text are PHI â€” only stored when STORE_TRANSCRIPTS=true.
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
