import axios from 'axios';
import { config } from '../../config/env';

export interface TtsResult {
  audioBuffer: Buffer | null;
  text: string;
  durationMs?: number;
}

interface SynthesizeParams {
  text: string;
  sessionId: string;
  clinicId: string;
}

// ---------------------------------------------------------------------------
// Speechmatics TTS — preview endpoint, Megan voice (US English Female)
// API docs: https://docs.speechmatics.com/text-to-speech/quickstart
// ---------------------------------------------------------------------------
const SM_TTS_URL = 'https://preview.tts.speechmatics.com/generate/megan';
// Output: WAV 16kHz 16-bit mono (the only format available as of preview)
const SM_OUTPUT_FORMAT = 'wav_16000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Low-level Speechmatics HTTP call with 429-aware exponential backoff retry.
 * @param maxRetries  - how many times to retry after 429 (0 = no retry)
 * @param baseDelayMs - first retry delay; doubles each attempt (capped at 30 s)
 */
async function speechmaticsRequest(
  text: string,
  apiKey: string,
  maxRetries: number,
  baseDelayMs: number,
): Promise<Buffer> {
  let attempt = 0;
  while (true) {
    try {
      const response = await axios.post(
        `${SM_TTS_URL}?output_format=${SM_OUTPUT_FORMAT}`,
        { text },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
          timeout: 10000,
        }
      );
      return Buffer.from(response.data as ArrayBuffer);
    } catch (err: unknown) {
      const axiosErr = err as import('axios').AxiosError;
      const status = axiosErr?.response?.status;

      if (status === 429 && attempt < maxRetries) {
        const headers = axiosErr.response?.headers as Record<string, string> | undefined;
        const retryAfterHeader = headers?.['retry-after'];
        const backoff = baseDelayMs * Math.pow(2, attempt);
        const delay = Math.min(
          retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : backoff,
          30000,
        );
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'tts_rate_limited',
          provider: 'speechmatics',
          attempt: attempt + 1,
          maxRetries,
          retryAfterMs: delay,
        }));
        await sleep(delay);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// TTS response cache — avoids re-synthesising identical static phrases.
// Ceiling raised to 500 chars to cover longer dynamic-sounding but repeated phrases.
// ---------------------------------------------------------------------------
const TTS_CACHE = new Map<string, Buffer>();
const TTS_CACHE_MAX = 120;

function ttsCacheKey(text: string): string {
  return text.trim();
}

// ---------------------------------------------------------------------------
const WARMUP_PHRASES: string[] = [
  'Sure, I can help with that. First I need to verify your identity. May I have your full name?',
  'Could you please tell me your full name? For example, you can say "My name is John Smith."',
  'And your date of birth?',
  'Got it. And your phone number?',
  'Let me connect you with a staff member. Please hold.',
  'And your last name?',
  'Could you please tell me your last name?',
  'I apologize — could you please tell me your first name?',
  'I apologize — could you please tell me your last name?',
  'I need your date of birth. You can say it like "January 15, 1990" or "01/15/1990".',
  'Could you please provide your phone number? For example, "555-123-4567".',
  'What date works for you? You can say something like "next Tuesday" or "April 9th".',
  'What time works best for you? For example, "10am" or "2:30 PM".',
  'What time works best for you?',
  'No problem. What date would you prefer instead?',
  'How can I help you today?',
  "I'm sorry, I didn't quite understand. Could you tell me how I can help you? For example, would you like to book, cancel, or reschedule an appointment?",
  'Thank you for calling. Goodbye!',
  'Let me connect you with a staff member who can better assist you. Please hold.',
  'Is there anything else I can help you with?',
  'Is there anything else I can help you with today?',
  'Sure, how else can I help you?',
  "Your appointment has been cancelled. Is there anything else I can help you with?",
  "Let's reschedule your appointment. What new date works for you?",
  'Your appointment is already confirmed. Is there anything else I can help you with?',
  "I'm having trouble verifying your information. Let me connect you with a staff member.",
  'One moment please.',
  "I can try to answer your question, but for detailed information, a staff member would be better. Could you tell me more about what you need?",
  'Please say yes or no.',
  'Thank you. I have verified your identity. What date works for you?',
  'What date works for you? You can say something like "next Tuesday" or "April 9th".',
  // Additional high-frequency phrases
  'Thank you. I have verified your identity. What new date works for you?',
  "Thank you. I have verified your identity. Your appointment has been cancelled. You will receive a confirmation text shortly. Is there anything else I can help you with?",
  'Just to confirm — please say yes or no.',
  'Got it.',
  'Perfect.',
  'Shall I confirm this appointment? Please say yes or no.',
  'You will receive a confirmation text message shortly.',
  'Could you repeat that please?',
  'I did not catch that. Could you say that again?',
  // Name/DOB confirmation tail phrases
  'Is that right?',
  'Is that correct?',
  // Hybrid script — must match STATIC object in conversationManager.ts exactly for cache hits
  'Welcome! To book, reschedule, or cancel, just say which one.',
  "What's your first name?",
  'And your last name?',
  'Date of birth?',
  'Best phone number?',
  'Sorry, could you say that again?',
  'What day and time works for you?',
  'Got it. Which appointment would you like to cancel?',
  'Sure. What date works for the new appointment?',
  "You'll get a text confirmation. Have a great day, bye!",
  // Greeting — kept for backward compat
  'Thanks for calling! How can I help you today?',
];

/**
 * Pre-synthesise all static phrases into the TTS cache at server startup.
 * Non-blocking — errors are swallowed so startup is never delayed.
 * Call this once after the server is listening.
 */
export async function warmTtsCache(): Promise<void> {
  const apiKey = config.speechmaticsApiKey;
  if (!apiKey) {
    console.log(JSON.stringify({ level: 'info', service: 'ttsService', message: 'TTS warm-up skipped — SPEECHMATICS_API_KEY not set' }));
    return;
  }

  const toWarm = WARMUP_PHRASES.filter(p => !TTS_CACHE.has(ttsCacheKey(p)));

  if (toWarm.length === 0) {
    console.log(JSON.stringify({ level: 'info', service: 'ttsService', message: 'TTS warm-up skipped — all phrases already cached' }));
    return;
  }

  console.log(JSON.stringify({ level: 'info', service: 'ttsService', message: 'TTS cache warm-up started', phraseCount: toWarm.length, provider: 'speechmatics', voice: 'megan' }));

  // Batch size 3 with 200 ms inter-batch delay — Speechmatics preview has no stated rate limits
  const BATCH = 3;
  const INTER_BATCH_DELAY_MS = 200;
  let warmed = 0;
  let failed = 0;

  for (let i = 0; i < toWarm.length; i += BATCH) {
    const batch = toWarm.slice(i, i + BATCH);
    await Promise.all(batch.map(async (phrase) => {
      try {
        const audioBuffer = await speechmaticsRequest(phrase, apiKey, 3, 500);
        if (audioBuffer.byteLength > 0) {
          const cacheKey = ttsCacheKey(phrase);
          if (TTS_CACHE.size >= TTS_CACHE_MAX) {
            TTS_CACHE.delete(TTS_CACHE.keys().next().value as string);
          }
          TTS_CACHE.set(cacheKey, audioBuffer);
          warmed++;
        }
      } catch {
        failed++;
      }
    }));

    if (i + BATCH < toWarm.length) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  console.log(JSON.stringify({ level: 'info', service: 'ttsService', message: 'TTS cache warm-up complete', warmed, failed, total: toWarm.length }));
}


export function getCachedTts(text: string): Buffer | null {
  return TTS_CACHE.get(ttsCacheKey(text)) ?? null;
}

export async function warmClinicGreeting(clinicName: string): Promise<void> {
  const apiKey = config.speechmaticsApiKey;
  if (!apiKey) return;
  const greeting = `Welcome to ${clinicName}! To book, reschedule, or cancel an appointment, just say which one.`;
  const cacheKey = ttsCacheKey(greeting);
  if (TTS_CACHE.has(cacheKey)) return;
  try {
    const audioBuffer = await speechmaticsRequest(greeting, apiKey, 2, 500);
    if (audioBuffer.byteLength > 0) {
      if (TTS_CACHE.size >= TTS_CACHE_MAX) {
        TTS_CACHE.delete(TTS_CACHE.keys().next().value as string);
      }
      TTS_CACHE.set(cacheKey, audioBuffer);
      console.log(JSON.stringify({ level: 'info', service: 'ttsService', message: 'Clinic greeting pre-warmed', clinicName }));
    }
  } catch { /* Non-fatal */ }
}

export async function synthesize(params: SynthesizeParams): Promise<TtsResult> {
  const { text, sessionId, clinicId } = params;

  const apiKey = config.speechmaticsApiKey;

  // Return cached audio for phrases — ceiling at 500 chars
  if (text.length < 500) {
    const cacheKey = ttsCacheKey(text);
    const cached = TTS_CACHE.get(cacheKey);
    if (cached) {
      console.log(JSON.stringify({ level: 'debug', service: 'ttsService', message: 'TTS cache hit', textLength: text.length, sessionId }));
      return { audioBuffer: cached, text, durationMs: 0 };
    }
  }

  if (!apiKey) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'tts_config_error',
      sessionId,
      clinicId,
      error: 'SPEECHMATICS_API_KEY is not set',
    }));
    return { audioBuffer: null, text };
  }

  console.log(JSON.stringify({
    level: 'debug',
    service: 'ttsService',
    provider: 'speechmatics',
    voice: 'megan',
    message: 'TTS request',
    textLength: text.length,
    sessionId,
    clinicId,
  }));

  const start = Date.now();

  try {
    const audioBuffer = await speechmaticsRequest(text, apiKey, 1, 500);
    const durationMs = Date.now() - start;

    if (audioBuffer.byteLength > 0 && text.length < 500) {
      const cacheKey = ttsCacheKey(text);
      if (TTS_CACHE.size >= TTS_CACHE_MAX) {
        TTS_CACHE.delete(TTS_CACHE.keys().next().value as string);
      }
      TTS_CACHE.set(cacheKey, audioBuffer);
    }

    console.log(JSON.stringify({
      level: 'info',
      event: 'tts_synthesized',
      provider: 'speechmatics',
      voice: 'megan',
      sessionId,
      clinicId,
      durationMs,
      byteLength: audioBuffer.byteLength,
    }));

    return { audioBuffer: audioBuffer.byteLength > 0 ? audioBuffer : null, text, durationMs };
  } catch (err: unknown) {
    const axiosErr = err as import('axios').AxiosError;
    const status = axiosErr?.response?.status;
    const responseBody = axiosErr?.response?.data
      ? typeof axiosErr.response.data === 'string'
        ? axiosErr.response.data.substring(0, 300)
        : JSON.stringify(axiosErr.response.data).substring(0, 300)
      : undefined;

    console.error(JSON.stringify({
      level: 'error',
      event: 'tts_synthesis_failed',
      provider: 'speechmatics',
      sessionId,
      clinicId,
      httpStatus: status,
      responseBody,
      error: (err as Error).message,
    }));

    return { audioBuffer: null, text };
  }
}
