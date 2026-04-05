import { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { runPipelineTurn, clearSession, getSession, PipelineTurnInput } from '../voice/conversation-manager/conversationManager';
import { createCallLog, getCallLogByControlId, updateCallLogComplete, updateCallLogLatency } from '../models/callLogModel';
import { getClinicIdByPhoneNumber } from '../models/settingsModel';
import { sendSuccess, sendError } from '../middleware/responseHelpers';

// Per-call state tracking (module-level, in-memory)
const playingCalls = new Set<string>();
const processingCalls = new Set<string>();
const lastProcessedAt = new Map<string, number>();
// Track consecutive no-input gather events per call (to avoid infinite silence loops)
const noInputCounts = new Map<string, number>();

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
 * Start a speech gather on the live call.
 * Telnyx's own ASR transcribes the caller's next utterance and fires call.gather.ended.
 * This replaces Engine-A (Google STT) transcription which requires Google credentials
 * to be configured in the Telnyx portal — something that blocks transcription events entirely.
 */
async function startGather(callControlId: string): Promise<void> {
  // IMPORTANT: Telnyx gather timeouts are in SECONDS (integer), NOT milliseconds.
  // Verified: setting 30000 (seconds = 8 hours) causes Telnyx to silently ignore
  // the value and fall back to the 5-second default — causing every gather to time out.
  // speech_timeout: max seconds of speech before gather auto-completes (max 60)
  // no_speech_timeout: seconds to wait for speech to START before timing out (max 30)
  await telnyxCallAction(callControlId, 'gather', {
    input: ['speech'],
    speech_timeout: 60,         // 60 seconds max speech duration (seconds)
    no_speech_timeout: 30,      // 30 seconds to wait for caller to start speaking (seconds)
    speech_language: 'en-US',
    speech_model: 'default',    // 'default' is the most reliable; 'enhanced' caused no transcription
  });
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

      // NOTE: transcription_start with Engine A (Google STT) requires Google credentials
      // configured inside the Telnyx portal — not set up, so no call.transcription events ever fire.
      // Instead we use gather (Telnyx's built-in ASR) which fires call.gather.ended with the
      // full transcript after the caller finishes speaking. No external credentials required.
      // Gather is sent after call.playback.ended so we don't attempt to capture speech while
      // the AI is still playing its response.

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
            message: 'call.answered: greeting audio playing — gather will start after playback ends',
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
          // TTS failed — start gather immediately so call doesn't go silent
          try { await startGather(callControlId); } catch { /* ignore */ }
        }
      } else {
        // No TTS audio — start gather immediately
        try { await startGather(callControlId); } catch { /* ignore */ }
      }

    } else if (eventType === 'call.gather.ended') {
      // Telnyx has collected the caller's utterance via built-in ASR.
      const gatherStatus: string = payload.status ?? '';
      const gatherTranscript: string = payload.speech?.results?.[0]?.transcript ?? '';
      const gatherConfidence: number = payload.speech?.results?.[0]?.confidence ?? 0;

      console.info(JSON.stringify({
        level: 'info',
        service: 'telnyxWebhook',
        message: 'call.gather.ended',
        callControlId,
        status: gatherStatus,
        hasTranscript: !!gatherTranscript,
        confidence: gatherConfidence,
      }));

      // Caller hung up during gather
      if (gatherStatus === 'call_hangup') return;

      // No speech detected — optionally prompt once, then hang up after repeated silence
      // Telnyx uses status 'timeout' when no_speech_timeout expires with no input
      if (gatherStatus === 'no_input' || gatherStatus === 'timeout' || !gatherTranscript.trim()) {
        const count = (noInputCounts.get(callControlId) ?? 0) + 1;
        noInputCounts.set(callControlId, count);

        if (count >= 3) {
          // Three consecutive silences — caller is likely gone
          const callLog = await getCallLogByControlId(callControlId);
          if (callLog) {
            const silenceResult = await runPipelineTurn({
              sessionId: callControlId,
              clinicId: callLog.clinicId,
              callLogId: callLog.id,
              transcriptFragment: '',
            });
            if (silenceResult.ttsResult?.audioBuffer) {
              await playAudioToCall(callControlId, silenceResult.ttsResult.audioBuffer);
            }
          }
          setTimeout(async () => {
            try { await telnyxCallAction(callControlId, 'hangup'); } catch { /* already hung up */ }
          }, 3000);
        } else {
          // Re-send gather to give caller another chance
          try { await startGather(callControlId); } catch { /* ignore */ }
        }
        return;
      }

      // Reset no-input counter on a real transcript
      noInputCounts.set(callControlId, 0);

      // Guard: skip if pipeline is already in-flight for this call
      if (processingCalls.has(callControlId)) return;

      const gatherCallLog = await getCallLogByControlId(callControlId);
      if (!gatherCallLog) {
        console.warn(JSON.stringify({
          level: 'warn',
          service: 'telnyxWebhook',
          message: 'call.gather.ended: no call log found',
          callControlId,
        }));
        return;
      }

      processingCalls.add(callControlId);
      try {
        const gatherInput: PipelineTurnInput = {
          sessionId: callControlId,
          clinicId: gatherCallLog.clinicId,
          callLogId: gatherCallLog.id,
          transcriptFragment: gatherTranscript,
        };

        const gatherResult = await runPipelineTurn(gatherInput);

        console.info(JSON.stringify({
          level: 'info',
          service: 'telnyxWebhook',
          message: 'call.gather.ended: pipeline turn complete',
          clinicId: gatherCallLog.clinicId,
          callControlId,
          state: gatherResult.state,
          nextState: gatherResult.nextState,
          callCompletedThisTurn: gatherResult.callCompletedThisTurn,
        }));

        if (gatherResult.ttsResult?.audioBuffer) {
          await playAudioToCall(callControlId, gatherResult.ttsResult.audioBuffer);
          // Next gather is sent from call.playback.ended after AI audio finishes
          if (gatherResult.shouldAutoHangUp) {
            setTimeout(async () => {
              try { await telnyxCallAction(callControlId, 'hangup'); } catch { /* already hung up */ }
            }, 3500);
          }
        } else {
          // No audio response — send gather immediately
          if (!gatherResult.shouldAutoHangUp) {
            try { await startGather(callControlId); } catch { /* ignore */ }
          } else {
            setTimeout(async () => {
              try { await telnyxCallAction(callControlId, 'hangup'); } catch { /* already hung up */ }
            }, 1000);
          }
        }
      } finally {
        processingCalls.delete(callControlId);
        lastProcessedAt.set(callControlId, Date.now());
      }

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
        message: 'call.playback.ended — starting gather for caller speech',
        callControlId,
      }));
      // After AI audio finishes, start gathering the caller's next utterance.
      // This is the primary trigger for the gather loop.
      if (!processingCalls.has(callControlId)) {
        try {
          await startGather(callControlId);
        } catch (gatherErr) {
          console.error(JSON.stringify({
            level: 'error',
            service: 'telnyxWebhook',
            message: 'Failed to start gather after playback',
            callControlId,
            error: (gatherErr as Error).message,
          }));
        }
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
      noInputCounts.delete(callControlId);
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