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

// Inworld TTS streaming endpoint — returns NDJSON lines:
//   {"result":{"audio":"<base64_mp3>"},"error":null}
const INWORLD_TTS_URL = 'https://api.inworld.ai/tts/v1/voice:stream';

// ---------------------------------------------------------------------------
// TTS response cache — avoids re-synthesising identical static phrases.
// Ceiling raised to 500 chars to cover longer dynamic-sounding but repeated phrases.
// ---------------------------------------------------------------------------
const TTS_CACHE = new Map<string, Buffer>();
const TTS_CACHE_MAX = 120;

function ttsCacheKey(text: string, voiceId: string): string {
  return `${voiceId}::${text.trim()}`;
}

// ---------------------------------------------------------------------------
// Static phrases to pre-synthesise on server startup so first-call latency
// is the same as all subsequent calls (~zero TTS wait for these responses).
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
  // Greeting — must match conversationManager greeting text exactly for cache hit on T1
  'Thanks for calling! How can I help you today?',
];

/**
 * Pre-synthesise all static phrases into the TTS cache at server startup.
 * Non-blocking — errors are swallowed so startup is never delayed.
 * Call this once after the server is listening.
 */
export async function warmTtsCache(): Promise<void> {
  const apiKey = config.inworldApiKey;
  if (!apiKey) {
    console.log(JSON.stringify({ level: 'info', service: 'ttsService', message: 'TTS warm-up skipped — INWORLD_API_KEY not set' }));
    return;
  }

  const voiceId = config.inworldVoiceId;
  const toWarm = WARMUP_PHRASES.filter(p => !TTS_CACHE.has(ttsCacheKey(p, voiceId)));

  if (toWarm.length === 0) {
    console.log(JSON.stringify({ level: 'info', service: 'ttsService', message: 'TTS warm-up skipped — all phrases already cached' }));
    return;
  }

  console.log(JSON.stringify({ level: 'info', service: 'ttsService', message: 'TTS cache warm-up started', phraseCount: toWarm.length }));

  // Process in batches of 5 to pre-warm more phrases concurrently
  const BATCH = 5;
  let warmed = 0;
  for (let i = 0; i < toWarm.length; i += BATCH) {
    const batch = toWarm.slice(i, i + BATCH);
    await Promise.all(batch.map(async (phrase) => {
      try {
        await synthesize({ text: phrase, sessionId: 'warmup', clinicId: 'warmup' });
        warmed++;
      } catch {
        // Silently skip phrases that fail to pre-warm
      }
    }));
  }

  console.log(JSON.stringify({ level: 'info', service: 'ttsService', message: 'TTS cache warm-up complete', warmed, total: toWarm.length }));
}


export async function synthesize(params: SynthesizeParams): Promise<TtsResult> {
  const { text, sessionId, clinicId } = params;

  const apiKey = config.inworldApiKey;
  const voiceId = config.inworldVoiceId;

  // Return cached audio for phrases — raised ceiling to 500 chars to cover longer dynamic responses
  if (text.length < 500) {
    const cacheKey = ttsCacheKey(text, voiceId);
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
      error: 'INWORLD_API_KEY is not set',
    }));
    return { audioBuffer: null, text };
  }

  // Debug log before API call — never log text (PHI)
  console.log(JSON.stringify({
    level: 'debug',
    service: 'ttsService',
    provider: 'inworld',
    message: 'TTS request',
    voiceId,
    modelId: 'inworld-tts-1.5-max',
    apiKeyPrefix: apiKey.substring(0, 6) + '...',
    apiKeyLength: apiKey.length,
    textLength: text.length,
    sessionId,
    clinicId,
  }));

  const start = Date.now();

  try {
    const response = await axios.post(
      INWORLD_TTS_URL,
      {
        text,
        voice_id: voiceId,
        audio_config: { audio_encoding: 'MP3' },
        model_id: 'inworld-tts-1.5-max',
      },
      {
        headers: {
          Authorization: `Basic ${apiKey}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 10000,
      }
    );

    // Collect streaming NDJSON chunks and decode base64 audio segments
    const audioChunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      let partial = '';

      response.data.on('data', (chunk: Buffer) => {
        partial += chunk.toString('utf8');
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';  // keep incomplete trailing line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error) {
              reject(new Error(`Inworld TTS error: ${JSON.stringify(parsed.error)}`));
              return;
            }
            const b64 = parsed?.result?.audioContent as string | undefined;
            if (b64) audioChunks.push(Buffer.from(b64, 'base64'));
          } catch {
            // non-JSON line — skip
          }
        }
      });

      response.data.on('end', () => {
        // Flush any remaining buffered line
        const trimmed = partial.trim();
        if (trimmed) {
          try {
            const parsed = JSON.parse(trimmed);
            const b64 = parsed?.result?.audioContent as string | undefined;
            if (b64) audioChunks.push(Buffer.from(b64, 'base64'));
          } catch { /* ignore */ }
        }
        resolve();
      });

      response.data.on('error', (err: Error) => reject(err));
    });

    const audioBuffer = Buffer.concat(audioChunks);
    const durationMs = Date.now() - start;

    // Cache all synthesised audio (ceiling raised to 500 chars)
    if (audioBuffer.byteLength > 0 && text.length < 500) {
      const cacheKey = ttsCacheKey(text, voiceId);
      if (TTS_CACHE.size >= TTS_CACHE_MAX) {
        // Evict oldest entry
        TTS_CACHE.delete(TTS_CACHE.keys().next().value as string);
      }
      TTS_CACHE.set(cacheKey, audioBuffer);
    }

    // Never log the text — PHI risk
    console.log(JSON.stringify({
      level: 'info',
      event: 'tts_synthesized',
      provider: 'inworld',
      sessionId,
      clinicId,
      durationMs,
      byteLength: audioBuffer.byteLength,
    }));

    return { audioBuffer: audioBuffer.byteLength > 0 ? audioBuffer : null, text, durationMs };
  } catch (err: unknown) {
    // Never include text in the error log — PHI risk
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
      provider: 'inworld',
      sessionId,
      clinicId,
      status,
      ...(status === 401 && {
        hint: 'Inworld 401 — check INWORLD_API_KEY is a valid Basic auth token (base64 of client_id:client_secret)',
        apiKeyPrefix: apiKey.substring(0, 6) + '...',
        apiKeyLength: apiKey.length,
        responseBody,
      }),
      error: (err as Error)?.message ?? 'Unknown TTS error',
    }));
    return { audioBuffer: null, text };
  }
}
