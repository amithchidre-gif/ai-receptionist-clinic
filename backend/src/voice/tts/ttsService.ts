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
// Only caches short phrases (< 200 chars) that don't contain caller-specific data.
// Saves ~1-2s per cached call.
// ---------------------------------------------------------------------------
const TTS_CACHE = new Map<string, Buffer>();
const TTS_CACHE_MAX = 60;

function ttsCacheKey(text: string, voiceId: string): string {
  return `${voiceId}::${text.trim()}`;
}

export async function synthesize(params: SynthesizeParams): Promise<TtsResult> {
  const { text, sessionId, clinicId } = params;

  const apiKey = config.inworldApiKey;
  const voiceId = config.inworldVoiceId;

  // Return cached audio for short static phrases (no caller-specific data)
  if (text.length < 200) {
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

    // Cache short static phrases for future calls
    if (audioBuffer.byteLength > 0 && text.length < 200) {
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
