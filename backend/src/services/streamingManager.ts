/**
 * streamingManager.ts
 *
 * Manages per-call Deepgram live (real-time) STT connections.
 *
 * Flow:
 *   1. voiceController sends `streaming_start` to Telnyx
 *   2. Telnyx opens a WebSocket to /voice/stream (wsStream.ts)
 *   3. wsStream calls initDeepgramSession() when it receives the 'start' event
 *   4. Audio chunks from Telnyx are forwarded via sendAudioToDeepgram()
 *   5. When Deepgram fires a final transcript, the registered callback is called
 *   6. voiceController's callback runs the conversation pipeline and plays TTS
 */

import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

const LOG = 'streamingManager';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deepgramConnections = new Map<string, any>();

type TranscriptCallback = (transcript: string, confidence: number) => void;
const transcriptCallbacks = new Map<string, TranscriptCallback>();

/**
 * Register a callback for when Deepgram fires a final transcript.
 * Must be called BEFORE initDeepgramSession so no transcript is missed.
 */
export function registerTranscriptCallback(
  callControlId: string,
  cb: TranscriptCallback,
): void {
  transcriptCallbacks.set(callControlId, cb);
}

/**
 * Start Deepgram live STT for a call.
 * Called from the WebSocket handler when Telnyx sends the 'start' event.
 * Audio format from Telnyx: G711 mulaw, 8000 Hz, mono.
 */
export function initDeepgramSession(callControlId: string): void {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error(JSON.stringify({
      level: 'error',
      service: LOG,
      message: 'DEEPGRAM_API_KEY not set — streaming STT disabled',
      callControlId,
    }));
    return;
  }

  // Clean up any pre-existing connection for this call
  const existing = deepgramConnections.get(callControlId);
  if (existing) {
    try { existing.finish(); } catch { /* ignore */ }
    deepgramConnections.delete(callControlId);
  }

  const deepgram = createClient(apiKey);

  const conn = deepgram.listen.live({
    model: 'nova-2',
    language: 'en-US',
    // Audio coming from Telnyx is raw G711 mulaw, 8 kHz, mono
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    encoding: 'mulaw' as any,
    sample_rate: 8000,
    channels: 1,
    // Only fire on complete utterances (no partials to avoid extra pipeline calls)
    interim_results: false,
    // End-of-speech detection: fire final transcript after 500ms of silence
    endpointing: 500,
    // Extra buffer — wait up to 1 extra second for the utterance to really be done
    utterance_end_ms: 1000,
    smart_format: true,
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    console.info(JSON.stringify({
      level: 'info',
      service: LOG,
      message: 'Deepgram live STT connected',
      callControlId,
    }));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    if (!data?.is_final) return;

    const transcript: string = data?.channel?.alternatives?.[0]?.transcript ?? '';
    const confidence: number = data?.channel?.alternatives?.[0]?.confidence ?? 0;

    if (!transcript.trim()) return;

    // PHI — never log the actual text
    console.info(JSON.stringify({
      level: 'info',
      service: LOG,
      message: 'Final transcript from Deepgram',
      callControlId,
      charCount: transcript.length,
      confidence,
    }));

    const cb = transcriptCallbacks.get(callControlId);
    if (cb) {
      cb(transcript, confidence);
    }
  });

  conn.on(LiveTranscriptionEvents.Error, (err: unknown) => {
    console.error(JSON.stringify({
      level: 'error',
      service: LOG,
      message: 'Deepgram live STT error',
      callControlId,
      error: (err as Error)?.message ?? String(err),
    }));
  });

  conn.on(LiveTranscriptionEvents.Close, () => {
    console.info(JSON.stringify({
      level: 'info',
      service: LOG,
      message: 'Deepgram live STT closed',
      callControlId,
    }));
    deepgramConnections.delete(callControlId);
  });

  deepgramConnections.set(callControlId, conn);
}

/**
 * Forward a raw audio buffer (base64-decoded mulaw) to the Deepgram connection for this call.
 * Called for every audio chunk received from Telnyx.
 */
export function sendAudioToDeepgram(callControlId: string, audioBuffer: Buffer): void {
  const conn = deepgramConnections.get(callControlId);
  if (!conn) return;
  try {
    conn.send(audioBuffer);
  } catch {
    // Connection may have already closed
  }
}

/**
 * Cleanly close the Deepgram connection and remove the transcript callback for this call.
 * Called on call.hangup or call.streaming.ended.
 */
export function closeDeepgramSession(callControlId: string): void {
  const conn = deepgramConnections.get(callControlId);
  if (conn) {
    try { conn.finish(); } catch { /* ignore */ }
    deepgramConnections.delete(callControlId);
  }
  transcriptCallbacks.delete(callControlId);
}
