/**
 * llmPromptService.ts
 *
 * Single source of truth for all LLM-driven conversation turns.
 *
 * The LLM receives the full session context + conversation history and returns
 * ONE structured JSON object per turn:
 *
 *   { next_state, response_text, extracted_entities }
 *
 * This eliminates the two-pass approach (extract → state machine decides) and
 * replaces it with a single guided-LLM call that handles everything intelligently.
 *
 * NO circular imports — this module does NOT import from conversationManager.ts.
 */

import OpenAI from 'openai';
import { config } from '../../config/env';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal session context forwarded from conversationManager.
 * Uses a flat interface instead of importing ConversationSession to avoid
 * circular dependencies.
 */
export interface LLMCallContext {
  sessionId: string;
  clinicId: string;
  state: string;
  turnCount: number;
  verificationAttempts: number;
  failedIntentAttempts: number;
  collectedData: {
    name?: string;
    dateOfBirth?: string;
    phone?: string;
  };
  intent: string | null;
  bookingDate: string | null;
  bookingTime: string | null;
  identityVerified: boolean;
  bookingConfirmed: boolean;
  lastResponseOpener: string | null;
}

export interface LLMExtractedEntities {
  intent: string | null;       // 'book_appointment' | 'cancel_appointment' | 'reschedule_appointment' | 'clinic_question' | null
  name: string | null;         // title-cased full name, or null
  dateOfBirth: string | null;  // 'MM/DD/YYYY', or null
  phone: string | null;        // exactly 10 digits, no formatting, or null
  bookingDate: string | null;  // 'YYYY-MM-DD', or null
  bookingTime: string | null;  // 'H:MM AM/PM', or null
  isYes: boolean;
  isNo: boolean;
  isGoodbye: boolean;
}

export interface LLMTurnResult {
  next_state: string;
  response_text: string;
  extracted_entities: LLMExtractedEntities;
  /** The exact JSON string the model produced — stored in conversation history so the
   *  model always sees its prior responses in JSON format and continues in JSON. */
  raw_json: string;
  /** Actual LLM streaming duration in ms — for telemetry. */
  llmMs: number;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible client — uses Groq when GROQ_API_KEY set, else OpenAI
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;
let _clientType: 'groq' | 'openai' | null = null;

function getClient(): { client: OpenAI; model: string } {
  const useGroq = !!config.groqApiKey;
  const type = useGroq ? 'groq' : 'openai';
  if (!_client || _clientType !== type) {
    if (useGroq) {
      _client = new OpenAI({ apiKey: config.groqApiKey, baseURL: 'https://api.groq.com/openai/v1' });
    } else {
      _client = new OpenAI({ apiKey: config.openrouterApiKey, baseURL: 'https://api.openai.com/v1' });
    }
    _clientType = type;
  }
  const model = useGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';
  return { client: _client, model };
}

// ---------------------------------------------------------------------------
// DOB normalization (duplicated here to avoid importing from conversationManager)
// ---------------------------------------------------------------------------

function normalizeDOB(raw: string): string | null {
  const s = raw.trim();

  // ISO: YYYY-MM-DD → MM/DD/YYYY
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;

  // Slash or dash: MM/DD/YYYY or DD/MM/YYYY (2- or 4-digit year)
  const slash = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/);
  if (slash) {
    const a = parseInt(slash[1], 10);
    const b = parseInt(slash[2], 10);
    let y = slash[3];
    if (y.length === 2) y = `${parseInt(y, 10) <= 30 ? '20' : '19'}${y}`;
    // If first number >12 it must be the day (DD/MM/YYYY)
    if (a > 12) return `${String(b).padStart(2, '0')}/${String(a).padStart(2, '0')}/${y}`;
    return `${String(a).padStart(2, '0')}/${String(b).padStart(2, '0')}/${y}`;
  }

  return null; // unrecognizable — caller should handle
}

// ---------------------------------------------------------------------------
// Condensed system prompt — ~50% fewer tokens than v1 for faster TTFT.
// response_text is placed FIRST in the output JSON so it appears earliest in
// the stream, allowing TTS to start before the full JSON is received.
// ---------------------------------------------------------------------------

function buildSystemPrompt(ctx: LLMCallContext, clinicName: string, today: string): string {
  const cd = ctx.collectedData;
  const collected = [
    cd.name        ? `name:${cd.name}` : null,
    cd.dateOfBirth ? `dob:${cd.dateOfBirth}` : null,
    cd.phone       ? 'phone:✓' : null,
    ctx.intent     ? `intent:${ctx.intent}` : null,
    ctx.bookingDate ? `date:${ctx.bookingDate}` : null,
    ctx.bookingTime ? `time:${ctx.bookingTime}` : null,
  ].filter(Boolean).join(', ') || 'nothing yet';

  const openerWarning = ctx.lastResponseOpener
    ? `\nDo NOT start your response with "${ctx.lastResponseOpener}".`
    : '';

  return `You are the AI voice receptionist for ${clinicName}. Today: ${today}.
State: ${ctx.state} | Turn: ${ctx.turnCount + 1} | Attempts: ${ctx.verificationAttempts}
Collected: ${collected}
Identity verified: ${ctx.identityVerified ? 'YES' : 'NO'} | Booking confirmed: ${ctx.bookingConfirmed ? 'YES' : 'NO'}

STATES: greeting→intent_detection→identity_verification→booking_flow→awaiting_time→completed | handoff
RULES:
- Stay in identity_verification until name+dob+phone ALL collected. Then: book/reschedule→booking_flow, cancel→completed.
- booking_flow→awaiting_time once date known. awaiting_time→completed only on isYes.
- handoff after 5+ failed attempts or caller asks for a person.

EXTRACT from caller's words:
- name: title-case; resolve spelled letters "a-m-i-t"→"Amit", NATO phonetics "Alpha Mike India Tango"→"Amit"
- dateOfBirth: always "MM/DD/YYYY"; accept any format (e.g. "30 March 1985"→"03/30/1985")
- phone: 10 US digits, strip leading 1, strip formatting (spoken digits ok)
- bookingDate: "YYYY-MM-DD"; compute relative dates from today=${today}
- bookingTime: "H:MM AM/PM"
- isYes/isNo/isGoodbye: detect all natural variants

STYLE: Extremely brief voice responses. ONE short sentence only, max 40 characters. Never two questions.
Use caller's first name occasionally once known. Vary openers: Got it / Sure / Perfect / Thanks / Great.${openerWarning}
After collecting name, confirm spelling: 'Is that [Name]?' (short!)
Never ask for already-collected info.

OUTPUT: valid JSON only, response_text FIRST:
{"response_text":"And your date of birth?","next_state":"identity_verification","extracted_entities":{"intent":null,"name":"Amit Chidre","dateOfBirth":null,"phone":null,"bookingDate":null,"bookingTime":null,"isYes":false,"isNo":false,"isGoodbye":false}}`;
}

// ---------------------------------------------------------------------------
// Stream extractor — fires TTS as soon as response_text value is complete.
// response_text MUST be the first field in the JSON for this to work.
// ---------------------------------------------------------------------------

function extractResponseTextFromStream(buffer: string): string | null {
  // Matches: {"response_text":"<value>"  — value may contain escaped chars
  const m = buffer.match(/^\s*\{\s*"response_text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    return m[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, ' ')
      .replace(/\\\\/g, '\\');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main export — callLLM
// ---------------------------------------------------------------------------

/**
 * Make one LLM call that handles extraction + response + next-state in a
 * single JSON output.  Returns null if the LLM is unreachable or returns
 * unparseable JSON — the caller should fall back gracefully.
 *
 * @param onResponseTextReady - Optional callback fired the moment response_text
 *   is complete in the stream. Used for parallel TTS: caller starts synthesis
 *   DURING LLM streaming rather than waiting for the full JSON.
 */
export async function callLLM(
  ctx: LLMCallContext,
  preprocessedTranscript: string,
  clinicName: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  onResponseTextReady?: (text: string) => void,
): Promise<LLMTurnResult | null> {
  const apiKey = config.groqApiKey || config.openrouterApiKey;
  if (!apiKey) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'llmPromptService',
      message: 'No LLM API key set (GROQ_API_KEY or OPENAI_API_KEY)',
      sessionId: ctx.sessionId,
    }));
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildSystemPrompt(ctx, clinicName, today);
  const { client, model } = getClient();
  const useGroq = model.startsWith('llama');

  // Last 2 turns (4 messages) — shorter context = fewer input tokens → faster TTFT
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-4),
    { role: 'user', content: preprocessedTranscript },
  ];

  const llmStart = Date.now();
  try {
    let content = '';
    let responseTextFired = false;

    const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages,
      temperature: 0.3,
      max_tokens: 220,
      stream: true as const,
      ...(useGroq ? { response_format: { type: 'json_object' as const } } : {}),
    };

    const stream = await client.chat.completions.create(createParams);

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        // Fire TTS as soon as response_text value is complete in the stream
        if (!responseTextFired && onResponseTextReady) {
          const text = extractResponseTextFromStream(content);
          if (text && text.trim().length > 0) {
            responseTextFired = true;
            onResponseTextReady(text.trim());
          }
        }
      }
    }

    const llmMs = Date.now() - llmStart;

    // Strip markdown code fences if the model adds them despite instructions
    content = content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

    const rawJson = content;
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const e = (parsed.extracted_entities ?? {}) as Record<string, unknown>;

    // Normalize + validate phone: accept 10 or 11 digits (strip leading 1)
    const rawPhone = typeof e.phone === 'string' ? e.phone.replace(/\D/g, '') : null;
    const phone: string | null = rawPhone
      ? rawPhone.length === 11 && rawPhone.startsWith('1')
        ? rawPhone.slice(1)
        : rawPhone.length === 10
          ? rawPhone
          : null
      : null;

    // Normalize DOB: try to parse any format the model returns
    const rawDob = typeof e.dateOfBirth === 'string' && e.dateOfBirth.trim()
      ? e.dateOfBirth.trim()
      : null;
    const dateOfBirth = rawDob ? (normalizeDOB(rawDob) ?? rawDob) : null;

    const responseText = typeof parsed.response_text === 'string' && parsed.response_text.trim()
      ? parsed.response_text.trim()
      : 'I apologize, could you say that again?';

    console.info(JSON.stringify({
      level: 'info',
      service: 'llmPromptService',
      provider: useGroq ? 'groq' : 'openai',
      model,
      llmMs,
      sessionId: ctx.sessionId,
    }));

    return {
      next_state: typeof parsed.next_state === 'string' && parsed.next_state.trim()
        ? parsed.next_state
        : ctx.state,
      response_text: responseText,
      extracted_entities: {
        intent: typeof e.intent === 'string' && e.intent !== 'null' && e.intent.trim()
          ? e.intent.trim()
          : null,
        name: typeof e.name === 'string' && e.name.trim() ? e.name.trim() : null,
        dateOfBirth,
        phone,
        bookingDate: typeof e.bookingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.bookingDate)
          ? e.bookingDate
          : null,
        bookingTime: typeof e.bookingTime === 'string' && e.bookingTime.trim()
          ? e.bookingTime.trim()
          : null,
        isYes: e.isYes === true,
        isNo: e.isNo === true,
        isGoodbye: e.isGoodbye === true,
      },
      raw_json: rawJson,
      llmMs,
    };
  } catch (err: unknown) {
    const llmMs = Date.now() - llmStart;
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'llmPromptService',
      message: 'LLM call failed',
      sessionId: ctx.sessionId,
      clinicId: ctx.clinicId,
      error: err instanceof Error ? err.message : String(err),
      httpStatus: (err as Record<string, unknown>)?.status ?? null,
      llmMs,
    }));
    return null;
  }
}
