import { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { runPipelineTurn, clearSession, getSession, PipelineTurnInput } from '../voice/conversation-manager/conversationManager';
import { createCallLog, getCallLogByControlId, updateCallLogComplete, updateCallLogLatency } from '../models/callLogModel';
import { getClinicIdByPhoneNumber } from '../models/settingsModel';
import { sendSuccess, sendError } from '../middleware/responseHelpers';
import { registerTranscriptCallback, closeDeepgramSession } from '../services/streamingManager';
import { getCachedTts } from '../voice/tts/ttsService';

// Per-call state tracking (module-level, in-memory)
const playingCalls = new Set<string>();
const processingCalls = new Set<string>();
const lastProcessedAt = new Map<string, number>();
// Silence detection: timer per call â€” fires if caller stays silent for 45s after TTS ends
const silenceTimers = new Map<string, NodeJS.Timeout>();
// Track consecutive silence events per call (to detect dead calls)
const noInputCounts = new Map<string, number>();
// Cache clinicId + callLogId per call to avoid extra DB calls in hot-path handlers
const callMetadata = new Map<string, { clinicId: string; callLogId: string }>();
// Barge-in ack tracking: play "One moment please." after barge-in
// to fill TTS synthesis silence and prevent "call dropped" perception.
const bargeInAckActive = new Set<string>();
const pendingAudioBuffers = new Map<string, Buffer>();

/**
 * Call a Telnyx Call Control action directly via REST API.
 * The Telnyx SDK v2.x has restrictive TypeScript types; using REST directly is more reliable.
 */
async function telnyxCallAction(callControlId: string, action: string, params: Record<string, unknown> = {}): Promise<void> {
  await axios.post(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`,
    params,
    {
      headers: {
        'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 8000,
    }
  );
}

/**
 * Build the WebSocket stream URL for Telnyx to connect to.
 * Converts https:// â†’ wss:// and http:// â†’ ws://.
 * Telnyx requires a WSS (secure WebSocket) URL in production.
 */
function buildStreamUrl(): string {
  const baseUrl = process.env.BASE_URL ?? 'http://localhost:4000';
  return baseUrl
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://')
    + '/voice/stream';
}

/**
 * Clear the inactivity/silence timer for a call.
 */
function clearSilenceTimer(callControlId: string): void {
  const t = silenceTimers.get(callControlId);
  if (t) {
    clearTimeout(t);
    silenceTimers.delete(callControlId);
  }
}

/**
 * Start a 45-second silence timer for a call.
 * If the caller doesn't say anything within 45s after TTS ends, we prompt.
 * After 3 consecutive silences, we hang up.
 */
function startSilenceTimer(callControlId: string): void {
  clearSilenceTimer(callControlId);

  const timer = setTimeout(async () => {
    silenceTimers.delete(callControlId);

    const count = (noInputCounts.get(callControlId) ?? 0) + 1;
    noInputCounts.set(callControlId, count);

    const meta = callMetadata.get(callControlId);
    if (!meta) return;

    try {
      const silenceResult = await runPipelineTurn({
        sessionId: callControlId,
        clinicId: meta.clinicId,
        callLogId: meta.callLogId,
        transcriptFragment: '',  // empty = no-input scenario
      });

      if (silenceResult.ttsResult?.audioBuffer) {
        await playAudioToCall(callControlId, silenceResult.ttsResult.audioBuffer);
      }

      if (count >= 3 || silenceResult.shouldAutoHangUp) {
        setTimeout(async () => {
          try { await telnyxCallAction(callControlId, 'hangup'); } catch { /* already hung up */ }
        }, 3500);
      }
    } catch (err: unknown) {
      console.error(JSON.stringify({
        level: 'error',
        service: 'silenceTimer',
        message: 'Error handling silence',
        callControlId,
        error: (err as Error).message,
      }));
    }
  }, 45_000);  // 45 seconds of silence before prompting

  silenceTimers.set(callControlId, timer);
}

/**
 * Start Telnyx audio streaming on the live call.
 * Telnyx will open a WebSocket to our /voice/stream endpoint and send
 * the caller's audio in real-time (G711 mulaw, 8 kHz, base64-encoded).
 * This replaces the gather-based ASR approach which was silently ignored by Telnyx.
 */
async function startStreaming(callControlId: string): Promise<void> {
  const streamUrl = buildStreamUrl();
  await telnyxCallAction(callControlId, 'streaming_start', {
    stream_url: streamUrl,
    stream_track: 'inbound_track',  // caller audio only â€” AI TTS is on the outbound track
  });
}


/**
 * Save audio buffer to a temp file and trigger Telnyx playback_start via REST API.
 * Telnyx requires a public HTTP URL â€” it cannot accept base64 data URIs.
 */
async function playAudioToCall(callControlId: string, audioBuffer: Buffer): Promise<void> {
  // Use system /tmp/audio â€” guaranteed writable on all Unix environments (Render, Docker, etc.)
  // ${process.cwd()}/tmp/audio can be non-writable if the project source dir is read-only.
  const audioDir = '/tmp/audio';
  await fs.mkdir(audioDir, { recursive: true });

  const audioId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const audioFile = path.join(audioDir, `${audioId}.wav`);
  const baseUrl = process.env.BASE_URL ?? 'http://localhost:4000';
  const audioUrl = `${baseUrl}/api/audio/${audioId}`;

  await fs.writeFile(audioFile, audioBuffer);
  await telnyxCallAction(callControlId, 'playback_start', { audio_url: audioUrl });

  // Clean up temp file after 120 seconds (well after Telnyx has fetched it)
  setTimeout(() => {
    fs.unlink(audioFile).catch(() => {});
  }, 120_000);
}

export async function pipelineTurn(req: Request, res: Response): Promise<void> {
  const { sessionId, callLogId, transcriptFragment } = req.body;
  const clinicId = req.user!.clinicId;

  if (!sessionId) {
    sendError(res, 'sessionId is required', 400);
    return;
  }

  try {
    const input: PipelineTurnInput = {
      sessionId,
      clinicId,
      callLogId: callLogId ?? null,
      transcriptFragment: transcriptFragment ?? undefined,
    };

    const result = await runPipelineTurn(input);

    sendSuccess(res, {
      state: result.state,
      nextState: result.nextState,
      intent: result.intent,
      responseText: result.responseText,
      callCompletedThisTurn: result.callCompletedThisTurn,
      ttsAudioBytes: result.ttsResult?.audioBuffer?.byteLength ?? null,
    });
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'voiceController',
      message: 'Pipeline turn failed',
      sessionId,
      clinicId,
      error: error.message,
    }));
    sendError(res, 'Pipeline turn failed', 500);
  }
}

export async function telnyxWebhook(req: Request, res: Response): Promise<void> {
  res.sendStatus(200);

  try {
    const eventType: string = req.body?.data?.event_type ?? '';
    const payload = req.body?.data?.payload ?? {};
    const callControlId: string = payload.call_control_id ?? '';

    if (!callControlId) {
      console.warn(JSON.stringify({
        level: 'warn',
        service: 'telnyxWebhook',
        message: 'Received webhook with no call_control_id',
        eventType,
      }));
      return;
    }

    if (eventType === 'call.initiated') {
      const fromNumber: string = payload.from ?? '';
      const toNumber: string = payload.to ?? '';

      const clinicId = await getClinicIdByPhoneNumber(toNumber);
      if (!clinicId) {
        console.warn(JSON.stringify({
          level: 'warn',
          service: 'telnyxWebhook',
          message: 'call.initiated: no clinic mapped to number',
          callControlId,
        }));
        return;
      }

      await createCallLog(clinicId, fromNumber, toNumber, callControlId);

      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.initiated: call log created',
        clinicId,
        callControlId,
      }));

      try {
        await telnyxCallAction(callControlId, 'answer');
        console.info(JSON.stringify({
          level: 'info',
          service: 'telnyxWebhook',
          message: 'call.initiated: call answered',
          clinicId,
          callControlId,
        }));
      } catch (answerErr) {
        console.error(JSON.stringify({
          level: 'error',
          service: 'telnyxWebhook',
          message: 'Failed to answer call',
          callControlId,
          error: (answerErr as Error).message,
        }));
      }


    } else if (eventType === 'call.answered') {
      const callLog = await getCallLogByControlId(callControlId);
      if (!callLog) {
        console.warn(JSON.stringify({
          level: 'warn',
          service: 'telnyxWebhook',
          message: 'call.answered: no call log found',
          callControlId,
        }));
        return;
      }

      // Cache call metadata to avoid repeated DB lookups in hot-path handlers
      callMetadata.set(callControlId, { clinicId: callLog.clinicId, callLogId: callLog.id });

      // â”€â”€â”€ Register Deepgram transcript callback BEFORE starting the stream â”€â”€â”€â”€
      // This closure is called by streamingManager whenever Deepgram fires a final
      // transcript for this call. It runs the conversation pipeline and plays TTS.
      registerTranscriptCallback(callControlId, async (transcript: string, confidence: number, isFinal: boolean) => {
        // Barge-in: any speech (even interim) while AI is playing â†’ stop playback immediately
        if (transcript.trim() && playingCalls.has(callControlId)) {
          playingCalls.delete(callControlId);
          clearSilenceTimer(callControlId);
          try {
            await telnyxCallAction(callControlId, 'playback_stop');
            console.info(JSON.stringify({
              level: 'info',
              service: 'telnyxWebhook',
              message: 'Barge-in: stopped AI playback',
              callControlId,
              isFinal,
            }));
          } catch {
            // Ignore â€” playback may have already ended
          }
          // For interim barge-in: play cached ack so caller hears something
          // during TTS synthesis (prevents "call dropped" perception).
          if (!isFinal) {
            const ack = getCachedTts('One moment please.');
            if (ack && !bargeInAckActive.has(callControlId)) {
              bargeInAckActive.add(callControlId);
              playingCalls.add(callControlId);
              playAudioToCall(callControlId, ack).catch(() => {});
            }
            return;
          }
        }

        // Only run the pipeline on final (complete) transcripts
        if (!isFinal) return;

        // Prevent concurrent pipeline runs for the same call
        if (processingCalls.has(callControlId)) return;

        // A real transcript resets the silence counter
        noInputCounts.set(callControlId, 0);
        clearSilenceTimer(callControlId);

        console.info(JSON.stringify({
          level: 'info',
          event: 'stt_text_ingested',
          sessionId: callControlId,
          charCount: transcript.length,
          confidence,
        }));

        processingCalls.add(callControlId);
        try {
          const result = await runPipelineTurn({
            sessionId: callControlId,
            clinicId: callLog.clinicId,
            callLogId: callLog.id,
            transcriptFragment: transcript,
          });

          console.info(JSON.stringify({
            level: 'info',
            service: 'telnyxWebhook',
            message: 'Transcript pipeline turn complete',
            clinicId: callLog.clinicId,
            callControlId,
            state: result.state,
            nextState: result.nextState,
            callCompletedThisTurn: result.callCompletedThisTurn,
          }));

          if (result.ttsResult?.audioBuffer) {
            if (bargeInAckActive.has(callControlId)) {
              // Ack still playing â€” queue response to play after ack ends
              pendingAudioBuffers.set(callControlId, result.ttsResult.audioBuffer);
            } else {
              await playAudioToCall(callControlId, result.ttsResult.audioBuffer);
            }
            // Silence timer restarts from call.playback.ended after TTS finishes
            if (result.shouldAutoHangUp) {
              setTimeout(async () => {
                try { await telnyxCallAction(callControlId, 'hangup'); } catch { /* already hung up */ }
              }, 3500);
            }
          } else {
            if (result.shouldAutoHangUp) {
              setTimeout(async () => {
                try { await telnyxCallAction(callControlId, 'hangup'); } catch { /* already hung up */ }
              }, 1000);
            }
          }
        } catch (err: unknown) {
          console.error(JSON.stringify({
            level: 'error',
            service: 'telnyxWebhook',
            message: 'Transcript processing error',
            callControlId,
            error: (err as Error).message,
          }));
        } finally {
          processingCalls.delete(callControlId);
          lastProcessedAt.set(callControlId, Date.now());
        }
      });

      // â”€â”€â”€ Run greeting pipeline turn â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const input: PipelineTurnInput = {
        sessionId: callControlId,
        clinicId: callLog.clinicId,
        callLogId: callLog.id,
      };

      const result = await runPipelineTurn(input);

      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.answered: greeting turn complete',
        clinicId: callLog.clinicId,
        callControlId,
        state: result.state,
        nextState: result.nextState,
      }));

      // â”€â”€â”€ Start Telnyx audio streaming â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Telnyx will open a WebSocket to /voice/stream and forward caller audio.
      // We do this BEFORE playing TTS so we're ready to listen as soon as it ends.
      // The transcript callback above ignores speech while AI is playing (playingCalls).
      try {
        await startStreaming(callControlId);
        console.info(JSON.stringify({
          level: 'info',
          service: 'telnyxWebhook',
          message: 'call.answered: Telnyx audio streaming started',
          callControlId,
          streamUrl: buildStreamUrl(),
        }));
      } catch (streamErr) {
        console.error(JSON.stringify({
          level: 'error',
          service: 'telnyxWebhook',
          message: 'call.answered: Failed to start streaming (will still play greeting)',
          callControlId,
          error: (streamErr as Error).message,
        }));
      }

      // â”€â”€â”€ Play greeting audio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (result.ttsResult?.audioBuffer) {
        try {
          await playAudioToCall(callControlId, result.ttsResult.audioBuffer);
          console.info(JSON.stringify({
            level: 'info',
            service: 'telnyxWebhook',
            message: 'call.answered: greeting audio playing',
            clinicId: callLog.clinicId,
            callControlId,
            audioSize: result.ttsResult.audioBuffer.length,
          }));
        } catch (playErr) {
          console.error(JSON.stringify({
            level: 'error',
            service: 'telnyxWebhook',
            message: 'Failed to play greeting audio',
            callControlId,
            error: (playErr as Error).message,
          }));
        }
      }

    } else if (eventType === 'call.gather.ended') {
      // gather is no longer the primary speech input path.
      // Deepgram streaming via /voice/stream handles all caller speech now.
      // Log for visibility only; no action needed.
      const gatherStatus: string = payload.status ?? '';
      const hasTranscript = !!(payload.speech?.results?.[0]?.transcript ?? '');
      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.gather.ended (ignored â€” streaming STT is active)',
        callControlId,
        status: gatherStatus,
        hasTranscript,
      }));
      return;

    } else if (eventType === 'call.transcription') {
      // DISABLED: Engine A transcription is no longer used (requires Google credentials in Telnyx portal).
      // All speech input now goes through call.gather.ended events (gather action with built-in ASR).
      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.transcription: ignored (gather-based flow is active)',
        callControlId,
      }));
      return;

    } else if (eventType === '_call.transcription.DISABLED') {
      const transcript: string = payload.transcription_data?.transcript ?? '';
      const isFinal: boolean = payload.transcription_data?.is_final ?? false;

      // Barge-in: on ANY transcript while AI audio is playing, stop playback immediately.
      // This is intentionally aggressive â€” the caller should always be able to interrupt.
      // For interim transcripts we stop and return; for final transcripts we stop and fall through
      // to pipeline processing so the response still gets generated.
      if (transcript.trim() && playingCalls.has(callControlId)) {
        playingCalls.delete(callControlId);
        try {
          await telnyxCallAction(callControlId, 'playback_stop');
          console.info(JSON.stringify({
            level: 'info',
            service: 'telnyxWebhook',
            message: 'call.transcription: barge-in â€” stopped playback',
            callControlId,
            isFinal,
          }));
        } catch {
          // Ignore â€” playback may have already ended naturally
        }
        // Only return for interim (partial) transcripts; let final transcripts proceed to pipeline.
        if (!isFinal) return;
      }

      // Only run the AI pipeline on final (complete) transcripts
      if (!isFinal || !transcript.trim()) {
        return;
      }

      // Guard: skip if a pipeline turn is already in-flight for this call.
      // This prevents the AI from queuing up multiple overlapping responses.
      if (processingCalls.has(callControlId)) {
        console.info(JSON.stringify({
          level: 'info',
          service: 'telnyxWebhook',
          message: 'call.transcription: skipped â€” pipeline turn already in-flight',
          callControlId,
        }));
        return;
      }

      // 200ms cooldown: ignore transcripts arriving within 200ms of the last completed turn.
      // Prevents stale or duplicate interim webhooks from double-firing the pipeline.
      const lastProcessed = lastProcessedAt.get(callControlId) ?? 0;
      if (Date.now() - lastProcessed < 200) {
        console.info(JSON.stringify({
          level: 'info',
          service: 'telnyxWebhook',
          message: 'call.transcription: skipped â€” within 200ms cooldown',
          callControlId,
        }));
        return;
      }

      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.transcription: received',
        callControlId,
        transcript,
      }));

      const callLog = await getCallLogByControlId(callControlId);
      if (!callLog) {
        console.warn(JSON.stringify({
          level: 'warn',
          service: 'telnyxWebhook',
          message: 'call.transcription: no call log found',
          callControlId,
        }));
        return;
      }

      processingCalls.add(callControlId);
      try {
        const input: PipelineTurnInput = {
          sessionId: callControlId,
          clinicId: callLog.clinicId,
          callLogId: callLog.id,
          transcriptFragment: transcript,
        };

        const result = await runPipelineTurn(input);

        console.info(JSON.stringify({
          level: 'info',
          service: 'telnyxWebhook',
          message: 'call.transcription: pipeline turn complete',
          clinicId: callLog.clinicId,
          callControlId,
          state: result.state,
          nextState: result.nextState,
          callCompletedThisTurn: result.callCompletedThisTurn,
        }));

        if (result.ttsResult?.audioBuffer) {
          try {
            await playAudioToCall(callControlId, result.ttsResult.audioBuffer);
            console.info(JSON.stringify({
              level: 'info',
              service: 'telnyxWebhook',
              message: 'call.transcription: audio playing',
              clinicId: callLog.clinicId,
              callControlId,
              audioSize: result.ttsResult.audioBuffer.length,
            }));
            // Auto-hangup: if the AI just said goodbye, hang up 3 seconds after audio starts
            if (result.shouldAutoHangUp) {
              setTimeout(async () => {
                try { await telnyxCallAction(callControlId, 'hangup'); } catch { /* already hung up */ }
              }, 3000);
            }
          } catch (playErr) {
            console.error(JSON.stringify({
              level: 'error',
              service: 'telnyxWebhook',
              message: 'Failed to play audio',
              callControlId,
              error: (playErr as Error).message,
            }));
          }
        }
      } finally {
        processingCalls.delete(callControlId);
        lastProcessedAt.set(callControlId, Date.now());
      }

    } else if (eventType === 'call.playback.started') {
      playingCalls.add(callControlId);
      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.playback.started',
        callControlId,
      }));

    } else if (eventType === 'call.playback.ended') {
      playingCalls.delete(callControlId);
      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.playback.ended â€” listening for caller speech via Deepgram streaming',
        callControlId,
      }));
      // If barge-in ack just finished, serve any queued pipeline response immediately.
      if (bargeInAckActive.has(callControlId)) {
        const pending = pendingAudioBuffers.get(callControlId);
        if (pending) {
          bargeInAckActive.delete(callControlId);
          pendingAudioBuffers.delete(callControlId);
          playingCalls.add(callControlId);
          playAudioToCall(callControlId, pending).catch(() => {});
          return;
        }
        // No pending yet - pipeline may still be running (e.g. TTS rate-limited)
        if (processingCalls.has(callControlId)) {
          // Re-play hold phrase; keep bargeInAckActive set until pending arrives
          const holdAck = getCachedTts('One moment please.');
          if (holdAck) {
            playingCalls.add(callControlId);
            playAudioToCall(callControlId, holdAck).catch(() => {});
            return;
          }
        }
        // Pipeline done, no pending - clear flag, fall through to silence timer
        bargeInAckActive.delete(callControlId);
      }
      // With streaming STT, no gather command needed.
      // Deepgram is already receiving audio â€” it will fire a transcript when the caller speaks.
      // Start a 45-second inactivity timer so silent/abandoned calls are handled gracefully.
      if (!processingCalls.has(callControlId)) {
        startSilenceTimer(callControlId);
      }

    } else if (eventType === 'call.hangup') {
      // Clean up all in-memory state for this call
      clearSilenceTimer(callControlId);
      closeDeepgramSession(callControlId);
      playingCalls.delete(callControlId);
      processingCalls.delete(callControlId);
      lastProcessedAt.delete(callControlId);
      noInputCounts.delete(callControlId);
      callMetadata.delete(callControlId);
      bargeInAckActive.delete(callControlId);
      pendingAudioBuffers.delete(callControlId);

      const hangupLog = await getCallLogByControlId(callControlId);
      if (hangupLog) {
        await updateCallLogComplete(callControlId, hangupLog.clinicId);
        const session = getSession(callControlId);
        if (session && session.latencies.length > 0) {
          const avgLatencyMs = Math.round(
            session.latencies.reduce((a, b) => a + b, 0) / session.latencies.length
          );
          await updateCallLogLatency(hangupLog.id, hangupLog.clinicId, avgLatencyMs, session.turnCount);
        }
      }
      noInputCounts.delete(callControlId);
      clearSession(callControlId);

      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.hangup: session cleared',
        callControlId,
      }));

    } else if (eventType === 'call.streaming.started' || eventType === 'streaming.started') {
      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'streaming.started â€” Telnyx forwarding caller audio to /voice/stream',
        callControlId,
      }));

    } else if (eventType === 'call.streaming.ended' || eventType === 'streaming.stopped') {
      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'streaming.stopped',
        callControlId,
      }));
      closeDeepgramSession(callControlId);

    } else {
      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'Unhandled event type',
        eventType,
        callControlId,
      }));
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'telnyxWebhook',
      message: 'Webhook processing error',
      error: error.message,
    }));
  }
}