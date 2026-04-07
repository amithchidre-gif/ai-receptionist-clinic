import OpenAI from "openai";
import { config } from "../../config/env";
export type IntentType = "book_appointment" | "cancel_appointment" | "reschedule_appointment" | "clinic_question" | "unknown";

export interface IntentResult {
  intent: IntentType;
  confidence: number;
  entities: {
    date?: string | null;
    time?: string | null;
    patientName?: string | null;
  };
  rawResponse?: string;
}

const cache = new Map<string, IntentResult>();

function getCacheKey(sessionId: string, transcript: string): string {
  return `${sessionId}:${transcript}`;
}

export async function detectIntent(
  transcript: string,
  sessionId: string,
  clinicId: string
): Promise<IntentResult> {
  // --- Regex pre-check: explicit cancel overrides take priority over LLM ---
  // Catches mid-sentence pivots like "Actually wait I need to cancel instead".
  // Both patterns use \b word boundaries so order in the sentence doesn't matter.
  const hasCancelKeyword = /\b(cancel|cancellation)\b/i.test(transcript);
  const hasPivotWord    = /\b(actually|wait|hold\s+on|nevermind|never\s+mind|instead|on\s+second\s+thought)\b/i.test(transcript);
  if (hasCancelKeyword && (hasPivotWord || /i\s+(need|want|have)\s+to\s+cancel/i.test(transcript))) {
    const result: IntentResult = {
      intent: 'cancel_appointment',
      confidence: 0.95,
      entities: {},
    };
    cache.set(getCacheKey(sessionId, transcript), result);
    console.log(JSON.stringify({
      level: 'info',
      service: 'intentService',
      message: 'Intent detected (regex override)',
      sessionId,
      clinicId,
      intent: result.intent,
      confidence: result.confidence,
    }));
    return result;
  }

  const cacheKey = getCacheKey(sessionId, transcript);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const apiKey = process.env.OPENAI_API_KEY || config.openrouterApiKey;

  if (!apiKey) {
    console.error(JSON.stringify({
      level: "error",
      service: "intentService",
      message: "OPENAI_API_KEY is not set",
      sessionId,
      clinicId,
    }));
    return { intent: "unknown", confidence: 0, entities: {} };
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: "https://api.openai.com/v1",
  });

  const systemPrompt = `You are an intent classifier for a medical clinic AI receptionist.
Classify the patient's message into exactly one intent.

Intents:
- book_appointment: patient wants to schedule, make, or book an appointment
- cancel_appointment: patient wants to cancel or remove an appointment
- reschedule_appointment: patient wants to change the date/time of an existing appointment
- clinic_question: patient is asking about clinic hours, location, services, doctors, or policies
- unknown: unclear, greeting only, or does not match any above intent

CRITICAL RULE — Cancel overrides Book:
If the patient mentions the word "cancel" (or "cancellation", "cancel instead", "need to cancel"),
classify as cancel_appointment even if they previously mentioned booking.
Phrases like these MUST be classified as cancel_appointment:
  - "Actually wait I need to cancel instead"
  - "Nevermind, I want to cancel"
  - "Instead of booking, I need to cancel"
  - "On second thought, please cancel"
  - "Wait, I need to cancel my appointment"
The words "actually", "wait", "nevermind", "instead" signal that the patient is changing their mind.
When combined with "cancel", the intent is ALWAYS cancel_appointment.

Also extract any date or time mentioned (e.g. "Tuesday", "2pm", "next week").

Return ONLY valid JSON. No markdown, no explanation, no code blocks. Just JSON:
{"intent":"<intent>","confidence":<0.0-1.0>,"entities":{"date":"<or null>","time":"<or null>"}}`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openrouterModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcript }
      ],
      temperature: 0.1,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content || "";
    let jsonStr = content.trim();
    jsonStr = jsonStr.replace(/```json\n?/g, "").replace(/```\n?/g, "");

    const parsed = JSON.parse(jsonStr);

    const result: IntentResult = {
      intent: parsed.intent,
      confidence: parsed.confidence,
      entities: {
        date: parsed.entities?.date || null,
        time: parsed.entities?.time || null,
      },
    };

    const validIntents: IntentType[] = ["book_appointment", "cancel_appointment", "reschedule_appointment", "clinic_question", "unknown"];
    if (!validIntents.includes(result.intent)) {
      return { intent: "unknown", confidence: 0.3, entities: {} };
    }

    cache.set(cacheKey, result);

    console.log(JSON.stringify({
      level: "info",
      service: "intentService",
      message: "Intent detected",
      sessionId,
      clinicId,
      intent: result.intent,
      confidence: result.confidence,
    }));

    return result;
  } catch (error: any) {
    console.error(JSON.stringify({
      level: "error",
      service: "intentService",
      message: "Intent detection failed",
      sessionId,
      clinicId,
      error: error.message,
    }));
    return { intent: "unknown", confidence: 0, entities: {} };
  }
}

// Self-test when run directly
if (require.main === module) {
  (async () => {
    console.log("=== Intent Detection Self Test ===\n");
    const tests = [
      { text: "I want to book an appointment please", expected: "book_appointment" },
      { text: "I need to cancel my appointment", expected: "cancel_appointment" },
      { text: "hello", expected: "unknown" },
    ];
    for (const test of tests) {
      const result = await detectIntent(test.text, "self-test", "clinic-1");
      const status = result.intent === test.expected ? "✅" : "❌";
      console.log(status + " \"" + test.text + "\" → " + result.intent + " (" + result.confidence + ")");
    }
  })().catch(console.error);
}
