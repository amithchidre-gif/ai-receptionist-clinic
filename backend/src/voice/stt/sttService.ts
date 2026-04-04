import { createClient } from '@deepgram/sdk';

export interface SttResult {
  text: string;
  confidence: number;
  sessionId: string;
}

export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  sessionId: string
): Promise<SttResult> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'stt_config_error',
      sessionId,
      message: 'DEEPGRAM_API_KEY is not set',
    }));
    return { text: '', confidence: 0, sessionId };
  }

  const deepgram = createClient(apiKey);

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 10_000);

  try {
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: 'nova-2',
        language: 'en-US',
        smart_format: true,
      }
    );

    clearTimeout(timeoutId);

    if (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'stt_api_error',
        sessionId,
        message: error.message,
      }));
      return { text: '', confidence: 0, sessionId };
    }

    const channel = result?.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    const transcript = alternative?.transcript ?? '';
    const confidence = alternative?.confidence ?? 0;

    // Never log transcript — PHI
    console.log(JSON.stringify({
      level: 'info',
      event: 'stt_transcribed',
      sessionId,
      confidence,
      charCount: transcript.length,
    }));

    return { text: transcript, confidence, sessionId };
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.error(JSON.stringify({
      level: 'error',
      event: 'stt_exception',
      sessionId,
      message: err?.message ?? 'Unknown STT error',
    }));
    return { text: '', confidence: 0, sessionId };
  }
}

export function ingestTranscriptText(sessionId: string, text: string): SttResult {
  // Never log the text itself — PHI
  console.log(JSON.stringify({
    level: 'info',
    event: 'stt_text_ingested',
    sessionId,
    charCount: text.length,
  }));

  return { text, confidence: 1.0, sessionId };
}
