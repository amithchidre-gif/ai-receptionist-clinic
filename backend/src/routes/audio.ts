import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

/**
 * GET /api/audio/:id
 * Serves a synthesized WAV audio file to Telnyx for playback_start.
 * No auth required — Telnyx fetches this URL directly during an active call.
 */
router.get('/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  // Prevent path traversal — only allow alphanumeric, dash, dot
  if (!/^[\w.-]+$/.test(id)) {
    res.status(400).end();
    return;
  }

  // Must match the write path in voiceController.ts playAudioToCall
  const filePath = path.join('/tmp', 'audio', `${id}.wav`);

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'no-cache');

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    res.status(404).end();
  });
  stream.pipe(res);
});

export default router;
