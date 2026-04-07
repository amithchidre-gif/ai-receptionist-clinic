/**
 * streamingManager.ts
 *
 * Manages per-call Deepgram live (real-time) STT connections.
 * Uses the `ws` package directly to connect to Deepgram's raw WebSocket API —
 * bypassing the @deepgram/sdk live client which fails to upgrade in some Node.js
 * environments on Render ("Received network error or non-101 status code.").
 *
 * Flow:
 *   1. voiceController sends `streaming_start` to Telnyx
 *   2. Telnyx opens a WebSocket to /voice/stream (wsStream.ts)
 *   3. wsStream calls initDeepgramSession() when it receives the 'start' event
 *   4. Audio chunks from Telnyx are forwarded via sendAudioToDeepgram()
 *   5. When Deepgram fires a final transcript, the registered callback is called
 *   6. voiceController's callback runs the conversation pipeline and plays TTS
 */

import WebSocket from 'ws';

const LOG = 'streamingManager';

// Deepgram live transcription WebSocket endpoint
const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

const deepgramConnections = new Map<string, WebSocket>();

// isFinal=true → complete utterance, run pipeline; isFinal=false → interim, barge-in only
type TranscriptCallback = (transcript: string, confidence: number, isFinal: boolean) => void;
const transcriptCallbacks = new Map<string, TranscriptCallback>();

/**
 * Register a callback for when Deepgram fires a transcript (interim or final).
 * Must be called BEFORE initDeepgramSession so no transcript is missed.
 */
export function registerTranscriptCallback(
  callControlId: string,
  cb: TranscriptCallback,
): void {
  transcriptCallbacks.set(callControlId, cb);
}

/**
 * Start Deepgram live STT for a call using raw WebSocket (ws package).
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
  if (existing && existing.readyState < WebSocket.CLOSING) {
    try { existing.close(); } catch { /* ignore */ }
    deepgramConnections.delete(callControlId);
  }

  // Build Deepgram WebSocket URL with query parameters
  // Telnyx streams G711 mulaw at 8000 Hz mono to us, so we forward it as-is.
  const params = new URLSearchParams({
    model: 'nova-2-phonecall',  // Optimised for telephony audio — faster + more accurate
    language: 'en-US',
    encoding: 'mulaw',           // G.711 μ-law (the format Telnyx sends)
    sample_rate: '8000',
    channels: '1',
    interim_results: 'true',     // Enable interim results for lower perceived latency
    endpointing: '300',          // Reduced from 500ms → fires final transcript 200ms sooner
    utterance_end_ms: '700',     // Reduced from 1000ms — fires transcript 300ms sooner
    smart_format: 'true',
  });

  const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Token ${apiKey}`,
    },
  });

  ws.on('open', () => {
    console.info(JSON.stringify({
      level: 'info',
      service: LOG,
      message: 'Deepgram live STT connected',
      callControlId,
    }));
  });

  ws.on('message', (rawData: Buffer) => {
    try {
      const msg = JSON.parse(rawData.toString()) as Record<string, unknown>;

      // Only handle transcript messages (type === 'Results')
      const msgType = msg.type as string | undefined;
      if (msgType !== 'Results') return;

      const isFinal = msg.is_final as boolean | undefined;
      const channel = (msg.channel as Record<string, unknown> | undefined);
      const alternatives = channel?.alternatives as Array<Record<string, unknown>> | undefined;
      const transcript = (alternatives?.[0]?.transcript as string | undefined) ?? '';
      const confidence = (alternatives?.[0]?.confidence as number | undefined) ?? 0;

      if (!transcript.trim()) return;

      // PHI — never log the actual text
      if (isFinal) {
        console.info(JSON.stringify({
          level: 'info',
          service: LOG,
          message: 'Final transcript from Deepgram',
          callControlId,
          charCount: transcript.length,
          confidence,
        }));
      } else {
        // Log interim transcript event (no text)
        console.debug(JSON.stringify({
          level: 'debug',
          service: LOG,
          message: 'Interim transcript from Deepgram',
          callControlId,
          charCount: transcript.length,
        }));
      }

      const cb = transcriptCallbacks.get(callControlId);
      if (cb) {
        cb(transcript, isFinal ? confidence : 0.5, isFinal ?? false);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on('error', (err: Error) => {
    console.error(JSON.stringify({
      level: 'error',
      service: LOG,
      message: 'Deepgram WebSocket error',
      callControlId,
      error: err.message,
    }));
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.info(JSON.stringify({
      level: 'info',
      service: LOG,
      message: 'Deepgram WebSocket closed',
      callControlId,
      code,
      reason: reason.toString(),
    }));
    deepgramConnections.delete(callControlId);
  });

  deepgramConnections.set(callControlId, ws);
}

/**
 * Forward a raw audio buffer (base64-decoded mulaw) to the Deepgram connection for this call.
 * Called for every audio chunk received from Telnyx.
 */
export function sendAudioToDeepgram(callControlId: string, audioBuffer: Buffer): void {
  const ws = deepgramConnections.get(callControlId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(audioBuffer);
  } catch {
    // Connection may have already closed
  }
}

/**
 * Cleanly close the Deepgram connection and remove the transcript callback for this call.
 * Called on call.hangup or streaming.stopped.
 */
export function closeDeepgramSession(callControlId: string): void {
  const ws = deepgramConnections.get(callControlId);
  if (ws) {
    try {
      // Send CloseStream message to flush remaining audio before closing
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      ws.close();
    } catch { /* ignore */ }
    deepgramConnections.delete(callControlId);
  }
  transcriptCallbacks.delete(callControlId);
}
