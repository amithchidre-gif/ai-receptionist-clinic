/**
 * streamingManager.ts
 *
 * Manages per-call Deepgram live (real-time) STT connections.
 * Uses the `ws` package directly to connect to Deepgram's raw WebSocket API --
 * bypassing the @deepgram/sdk live client which fails to upgrade in some Node.js
 * environments on Render.
 *
 * Reconnect:
 *   If Deepgram drops unexpectedly (e.g. ECONNRESET / code 1006), we automatically
 *   reconnect up to MAX_RECONNECT_ATTEMPTS times with exponential back-off.
 *   Audio arriving during the brief reconnect window is buffered and replayed
 *   to Deepgram as soon as the new connection is open.
 */

import WebSocket from 'ws';

const LOG = 'streamingManager';
const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_BASE_DELAY_MS = 300;
const AUDIO_BUFFER_MAX_CHUNKS = 200;

const deepgramConnections = new Map<string, WebSocket>();

type TranscriptCallback = (transcript: string, confidence: number, isFinal: boolean) => void;
const transcriptCallbacks = new Map<string, TranscriptCallback>();

const activeConnections = new Map<string, boolean>();
const reconnectAttempts  = new Map<string, number>();
const pendingAudio       = new Map<string, Buffer[]>();

export function registerTranscriptCallback(
  callControlId: string,
  cb: TranscriptCallback,
): void {
  transcriptCallbacks.set(callControlId, cb);
}

function _connectDeepgram(callControlId: string, isReconnect: boolean): void {
  const apiKey = process.env.DEEPGRAM_API_KEY!;

  const existing = deepgramConnections.get(callControlId);
  if (existing && existing.readyState < WebSocket.CLOSING) {
    try { existing.close(); } catch { /* ignore */ }
  }
  deepgramConnections.delete(callControlId);

  const params = new URLSearchParams({
    model:            'nova-2-phonecall',
    language:         'en-US',
    encoding:         'mulaw',
    sample_rate:      '8000',
    channels:         '1',
    interim_results:  'true',
    endpointing:      '200',
    utterance_end_ms: '1000',
    smart_format:     'true',
  });

  const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;
  const ws  = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });

  ws.on('open', () => {
    console.info(JSON.stringify({
      level: 'info', service: LOG,
      message: isReconnect ? 'Deepgram reconnected' : 'Deepgram live STT connected',
      callControlId, attempt: reconnectAttempts.get(callControlId) ?? 0,
    }));
    reconnectAttempts.set(callControlId, 0);

    const buffered = pendingAudio.get(callControlId) ?? [];
    if (buffered.length > 0) {
      for (const chunk of buffered) {
        try { ws.send(chunk); } catch { /* ignore */ }
      }
      pendingAudio.set(callControlId, []);
    }
  });

  ws.on('message', (rawData: Buffer) => {
    try {
      const msg = JSON.parse(rawData.toString()) as Record<string, unknown>;
      if ((msg.type as string | undefined) !== 'Results') return;

      const isFinal      = msg.is_final as boolean | undefined;
      const channel      = (msg.channel as Record<string, unknown> | undefined);
      const alternatives = channel?.alternatives as Array<Record<string, unknown>> | undefined;
      const transcript   = (alternatives?.[0]?.transcript as string | undefined) ?? '';
      const confidence   = (alternatives?.[0]?.confidence as number | undefined) ?? 0;

      if (!transcript.trim()) return;

      if (isFinal) {
        console.info(JSON.stringify({
          level: 'info', service: LOG,
          message: 'Final transcript from Deepgram',
          callControlId, charCount: transcript.length, confidence,
        }));
      } else {
        console.debug(JSON.stringify({
          level: 'debug', service: LOG,
          message: 'Interim transcript from Deepgram',
          callControlId, charCount: transcript.length,
        }));
      }

      const cb = transcriptCallbacks.get(callControlId);
      if (cb) cb(transcript, isFinal ? confidence : 0.5, isFinal ?? false);
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on('error', (err: Error) => {
    console.error(JSON.stringify({
      level: 'error', service: LOG,
      message: 'Deepgram WebSocket error',
      callControlId, error: err.message,
    }));
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.info(JSON.stringify({
      level: 'info', service: LOG,
      message: 'Deepgram WebSocket closed',
      callControlId, code, reason: reason.toString(),
    }));
    deepgramConnections.delete(callControlId);

    const isActive     = activeConnections.get(callControlId) ?? false;
    const isCleanClose = code === 1000 || code === 1001;
    if (!isActive || isCleanClose) return;

    const attempt = (reconnectAttempts.get(callControlId) ?? 0) + 1;
    reconnectAttempts.set(callControlId, attempt);

    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      console.error(JSON.stringify({
        level: 'error', service: LOG,
        message: 'Deepgram reconnect exhausted -- STT unavailable for call',
        callControlId, attempts: attempt,
      }));
      return;
    }

    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    console.warn(JSON.stringify({
      level: 'warn', service: LOG,
      message: `Deepgram dropped (code ${code}) -- reconnecting`,
      callControlId, attempt, delayMs: delay,
    }));

    setTimeout(() => {
      if (activeConnections.get(callControlId)) {
        _connectDeepgram(callControlId, true);
      }
    }, delay);
  });

  deepgramConnections.set(callControlId, ws);
}

export function initDeepgramSession(callControlId: string): void {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error(JSON.stringify({
      level: 'error', service: LOG,
      message: 'DEEPGRAM_API_KEY not set -- streaming STT disabled',
      callControlId,
    }));
    return;
  }

  activeConnections.set(callControlId, true);
  reconnectAttempts.set(callControlId, 0);
  pendingAudio.set(callControlId, []);

  _connectDeepgram(callControlId, false);
}

export function sendAudioToDeepgram(callControlId: string, audioBuffer: Buffer): void {
  const ws = deepgramConnections.get(callControlId);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (activeConnections.get(callControlId)) {
      const buf = pendingAudio.get(callControlId) ?? [];
      buf.push(audioBuffer);
      if (buf.length > AUDIO_BUFFER_MAX_CHUNKS) buf.shift();
      pendingAudio.set(callControlId, buf);
    }
    return;
  }

  try {
    ws.send(audioBuffer);
  } catch {
    // Connection may have just closed -- next chunk will be buffered
  }
}

export function closeDeepgramSession(callControlId: string): void {
  activeConnections.set(callControlId, false);

  const ws = deepgramConnections.get(callControlId);
  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      ws.close();
    } catch { /* ignore */ }
    deepgramConnections.delete(callControlId);
  }

  transcriptCallbacks.delete(callControlId);
  activeConnections.delete(callControlId);
  reconnectAttempts.delete(callControlId);
  pendingAudio.delete(callControlId);
}