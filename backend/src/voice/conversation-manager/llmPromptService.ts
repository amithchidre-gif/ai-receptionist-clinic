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
}

// ---------------------------------------------------------------------------
// OpenAI singleton (avoids re-instantiation — ~50ms saved per cold start)
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;
function getClient(apiKey: string): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1' });
  return _client;
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
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(ctx: LLMCallContext, clinicName: string, today: string): string {
  const cd = ctx.collectedData;

  const dataStatus = [
    `  Name:              ${cd.name        ?? '(not yet collected)'}`,
    `  Date of birth:     ${cd.dateOfBirth ?? '(not yet collected)'}`,
    `  Phone:             ${cd.phone       ? '✓ collected' : '(not yet collected)'}`,
    `  Intent:            ${ctx.intent     ?? '(not yet detected)'}`,
    `  Booking date:      ${ctx.bookingDate ?? '(not yet collected)'}`,
    `  Booking time:      ${ctx.bookingTime ?? '(not yet collected)'}`,
    `  Identity verified: ${ctx.identityVerified ? 'YES' : 'NO'}`,
    `  Booking confirmed: ${ctx.bookingConfirmed ? 'YES' : 'NO'}`,
  ].join('\n');

  return `You are the AI receptionist for ${clinicName}. Today is ${today}.

## CURRENT STATE
State: ${ctx.state}  |  Turn: ${ctx.turnCount + 1}  |  Failed attempts: ${ctx.verificationAttempts}

## DATA COLLECTED SO FAR
${dataStatus}

## VALID CONVERSATION STATES
- "intent_detection"      — Identifying reason for the call
- "identity_verification" — Collecting name → DOB → phone (all 3 required)
- "booking_flow"          — Collecting appointment date
- "awaiting_time"         — Have date; collecting time or awaiting yes/no confirmation
- "completed"             — Transaction complete; ask "Is there anything else?"
- "handoff"               — Transfer to human staff

## STATE TRANSITION RULES
1. Stay in "identity_verification" until name + dateOfBirth + phone are ALL collected.
2. After all 3 are collected in "identity_verification", move to:
   - "booking_flow" for book_appointment or reschedule_appointment intent
   - "completed"    for cancel_appointment (cancellation is implicit)
3. Move "booking_flow" → "awaiting_time" once bookingDate is known.
4. Move "awaiting_time" → "completed" ONLY when isYes=true (caller confirmed appointment).
5. Move to "handoff" after 4+ failed attempts, or if caller asks to speak to a person.
6. From "completed", if caller has another request, assess intent and route accordingly.

## EXTRACTION RULES
- name:        Title-case every word. Resolve letter-by-letter spelling: "a m i t" / "A-M-I-T" / "A as in Alpha" → "Amit".
- dateOfBirth: ALWAYS output "MM/DD/YYYY". Accept ALL input formats:
                 "30 March 1985" → "03/30/1985"
                 "March 30, 1985" → "03/30/1985"
                 "March 30th 1985" → "03/30/1985"
                 "30/3/1985" or "30/3/85" → "03/30/1985"
                 "3/30/1985" → "03/30/1985"
                 "1985-03-30" → "03/30/1985"
- phone:       10 US digits only, no formatting. Strip leading "1".
                 Spoken: "five five five one two three four five six seven" → "5551234567"
                 "double five" → "55", "triple three" → "333"
- bookingDate: "YYYY-MM-DD". Compute relative dates from today (${today}).
                 "next Tuesday" → the upcoming Tuesday's ISO date
                 "this Friday" → the coming Friday
- bookingTime: "H:MM AM/PM". "ten" or "10am" → "10:00 AM". "two thirty" → "2:30 PM". "3pm" → "3:00 PM".
- isYes:       yes / yeah / yep / correct / sure / absolutely / that's right / go ahead / confirmed
- isNo:        no / nope / nah / wrong / incorrect / don't / never mind / actually / wait
- isGoodbye:   goodbye / bye / thank you / that's all / all set / nothing else / I'm done / we're done

## CONVERSATION STYLE
- Warm, professional, concise — maximum 2 short sentences.
- Use brief positive fillers BEFORE asking the next question: "Got it." / "Great." / "Perfect."
- If the caller spelled their name letter-by-letter, ALWAYS confirm: 'Did I get that right — your name is "[name]"?'
- NEVER ask for information already shown as collected above.
- NEVER ask for more than one piece of information per turn.
- If a caller provides multiple pieces of info in one message (e.g., name + DOB), extract both and ask for the next missing piece.

## OUTPUT FORMAT
Return ONLY this JSON — no markdown fences, no commentary, no extra fields:
{"next_state":"identity_verification","response_text":"Got it. And your date of birth?","extracted_entities":{"intent":null,"name":"Amit Chidre","dateOfBirth":null,"phone":null,"bookingDate":null,"bookingTime":null,"isYes":false,"isNo":false,"isGoodbye":false}}`;
}

// ---------------------------------------------------------------------------
// Main export — callLLM
// ---------------------------------------------------------------------------

/**
 * Make one LLM call that handles extraction + response + next-state in a
 * single JSON output.  Returns null if the LLM is unreachable or returns
 * unparseable JSON — the caller should fall back gracefully.
 */
export async function callLLM(
  ctx: LLMCallContext,
  preprocessedTranscript: string,
  clinicName: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<LLMTurnResult | null> {
  const apiKey = config.openrouterApiKey;
  if (!apiKey) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'llmPromptService',
      message: 'OPENAI_API_KEY not set',
      sessionId: ctx.sessionId,
    }));
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildSystemPrompt(ctx, clinicName, today);

  // Include last 3 turns (6 messages) for conversational memory
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user', content: preprocessedTranscript },
  ];

  const client = getClient(apiKey);

  try {
    let content = '';
    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.0,
      max_tokens: 200,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) content += delta;
    }

    // Strip markdown code fences if the model adds them despite instructions
    content = content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

    const rawJson = content; // save before parsing — used for conversation history
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

    return {
      next_state: typeof parsed.next_state === 'string' && parsed.next_state.trim()
        ? parsed.next_state
        : ctx.state,
      response_text: typeof parsed.response_text === 'string' && parsed.response_text.trim()
        ? parsed.response_text.trim()
        : 'I apologize, could you say that again?',
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
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const httpStatus = (err as Record<string, unknown>)?.status ?? null;
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'llmPromptService',
      message: 'LLM call failed',
      sessionId: ctx.sessionId,
      clinicId: ctx.clinicId,
      error: errMsg,
      httpStatus,
    }));
    return null;
  }
}
