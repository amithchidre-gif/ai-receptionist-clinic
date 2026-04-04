import { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { runPipelineTurn, clearSession, getSession, PipelineTurnInput } from '../voice/conversation-manager/conversationManager';
import { createCallLog, getCallLogByControlId, updateCallLogComplete, updateCallLogLatency } from '../models/callLogModel';
import { getClinicIdByPhoneNumber } from '../models/settingsModel';
import { sendSuccess, sendError } from '../middleware/responseHelpers';

// Per-call state tracking (module-level, in-memory)
// playingCalls: callControlIds currently playing AI audio (used for barge-in)
// processingCalls: callControlIds with a pipeline turn already in-flight (prevents double-processing)
// lastProcessedAt: timestamp of last completed pipeline turn per call (500ms cooldown)
const playingCalls = new Set<string>();
const processingCalls = new Set<string>();
const lastProcessedAt = new Map<string, number>();

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
 * Save audio buffer to a temp file and trigger Telnyx playback_start via REST API.
 * Telnyx requires a public HTTP URL — it cannot accept base64 data URIs.
 */
async function playAudioToCall(callControlId: string, audioBuffer: Buffer): Promise<void> {
  const audioDir = path.join(process.cwd(), 'tmp', 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  const audioId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const audioFile = path.join(audioDir, `${audioId}.mp3`);
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

      // Start real-time transcription (Engine A = Google STT, supports streaming interim_results).
      // Engine B (Telnyx/Whisper) does NOT support streaming — it only transcribes complete utterances
      // and has no `interim_results` support, so it would never fire call.transcription events.
      // transcription_engine_config is required to pass engine-specific params.
      // model: 'phone_call' + use_enhanced: true is optimised for telephony audio quality.
      try {
        await telnyxCallAction(callControlId, 'transcription_start', {
          transcription_engine: 'A',
          transcription_tracks: 'inbound',
          transcription_engine_config: {
            transcription_engine: 'A',
            language: 'en',
            interim_results: true,
            enable_speaker_diarization: false,
            min_speaker_count: 1,
            max_speaker_count: 1,
            profanity_filter: false,
            use_enhanced: true,
            model: 'phone_call',
            hints: [],
          },
        });
        console.info(JSON.stringify({
          level: 'info',
          service: 'telnyxWebhook',
          message: 'call.answered: transcription started',
          clinicId: callLog.clinicId,
          callControlId,
        }));
      } catch (transcribeErr) {
        console.error(JSON.stringify({
          level: 'error',
          service: 'telnyxWebhook',
          message: 'Failed to start transcription',
          callControlId,
          error: (transcribeErr as Error).message,
        }));
      }

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

      if (result.ttsResult?.audioBuffer) {
        try {
          await playAudioToCall(callControlId, result.ttsResult.audioBuffer);
          console.info(JSON.stringify({
            level: 'info',
            service: 'telnyxWebhook',
            message: 'call.answered: audio playing',
            clinicId: callLog.clinicId,
            callControlId,
            audioSize: result.ttsResult.audioBuffer.length,
          }));
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

    } else if (eventType === 'call.transcription') {
      const transcript: string = payload.transcription_data?.transcript ?? '';
      const isFinal: boolean = payload.transcription_data?.is_final ?? false;

      // Barge-in: on ANY transcript while AI audio is playing, stop playback immediately.
      // This is intentionally aggressive — the caller should always be able to interrupt.
      // For interim transcripts we stop and return; for final transcripts we stop and fall through
      // to pipeline processing so the response still gets generated.
      if (transcript.trim() && playingCalls.has(callControlId)) {
        playingCalls.delete(callControlId);
        try {
          await telnyxCallAction(callControlId, 'playback_stop');
          console.info(JSON.stringify({
            level: 'info',
            service: 'telnyxWebhook',
            message: 'call.transcription: barge-in — stopped playback',
            callControlId,
            isFinal,
          }));
        } catch {
          // Ignore — playback may have already ended naturally
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
          message: 'call.transcription: skipped — pipeline turn already in-flight',
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
          message: 'call.transcription: skipped — within 200ms cooldown',
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
        message: 'call.playback.ended — ensuring transcription active',
        callControlId,
      }));
      // Safety net: ensure transcription is still running after AI audio finishes.
      // If transcription_start was already called, Telnyx silently ignores a duplicate.
      try {
        await telnyxCallAction(callControlId, 'transcription_start', {
          transcription_engine: 'A',
          transcription_tracks: 'inbound',
          transcription_engine_config: {
            transcription_engine: 'A',
            language: 'en',
            interim_results: true,
            enable_speaker_diarization: false,
            min_speaker_count: 1,
            max_speaker_count: 1,
            profanity_filter: false,
            use_enhanced: true,
            model: 'phone_call',
            hints: [],
          },
        });
      } catch {
        // Expected if transcription is already running — not an error
      }

    } else if (eventType === 'call.hangup') {
      // Clean up in-memory state for this call
      playingCalls.delete(callControlId);
      processingCalls.delete(callControlId);
      lastProcessedAt.delete(callControlId);

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
      clearSession(callControlId);

      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.hangup: session cleared',
        callControlId,
      }));

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