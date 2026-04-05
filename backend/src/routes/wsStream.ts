/**
 * wsStream.ts
 *
 * WebSocket handler for Telnyx real-time audio streaming.
 *
 * Telnyx connects to wss://<BASE_URL>/voice/stream after receiving a streaming_start
 * Call Control action. It sends JSON messages containing base64-encoded G711 mulaw
 * audio from the caller (inbound_track only).
 *
 * This handler:
 *   1. Parses Telnyx's streaming protocol events (connected, start, media, stop)
 *   2. Extracts the call_control_id from the 'start' event
 *   3. Initialises a Deepgram live STT connection via streamingManager
 *   4. Forwards each decoded audio chunk to Deepgram
 */

import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import {
  initDeepgramSession,
  sendAudioToDeepgram,
  closeDeepgramSession,
} from '../services/streamingManager';

const LOG = 'wsStream';

export function handleTelnyxAudioStream(ws: WebSocket, _req: IncomingMessage): void {
  let callControlId: string | null = null;

  ws.on('message', (rawData: Buffer | string) => {
    try {
      const msg = JSON.parse(rawData.toString()) as Record<string, unknown>;
      const event = msg.event as string | undefined;

      if (event === 'connected') {
        console.info(JSON.stringify({
          level: 'info',
          service: LOG,
          message: 'Telnyx audio stream connected (WebSocket open)',
        }));
      } else if (event === 'start') {
        const startPayload = msg.start as Record<string, unknown> | undefined;
        callControlId = (startPayload?.call_control_id as string) ?? null;
        if (callControlId) {
          console.info(JSON.stringify({
            level: 'info',
            service: LOG,
            message: 'Audio stream started — initialising Deepgram',
            callControlId,
          }));
          // The transcript callback is already registered by voiceController before
          // streaming_start was sent to Telnyx. initDeepgramSession connects to Deepgram
          // and starts receiving audio.
          initDeepgramSession(callControlId);
        }
      } else if (event === 'media' && callControlId) {
        const media = msg.media as Record<string, unknown> | undefined;
        const audioBase64 = media?.payload as string | undefined;
        if (audioBase64) {
          const audioBuffer = Buffer.from(audioBase64, 'base64');
          sendAudioToDeepgram(callControlId, audioBuffer);
        }
      } else if (event === 'stop' && callControlId) {
        console.info(JSON.stringify({
          level: 'info',
          service: LOG,
          message: 'Audio stream stop event',
          callControlId,
        }));
        closeDeepgramSession(callControlId);
      }
    } catch {
      // Ignore malformed JSON from Telnyx (shouldn't happen in practice)
    }
  });

  ws.on('close', () => {
    if (callControlId) {
      console.info(JSON.stringify({
        level: 'info',
        service: LOG,
        message: 'WebSocket closed',
        callControlId,
      }));
      closeDeepgramSession(callControlId);
    }
  });

  ws.on('error', (err: Error) => {
    console.error(JSON.stringify({
      level: 'error',
      service: LOG,
      message: 'WebSocket error',
      error: err.message,
      callControlId,
    }));
  });
}
