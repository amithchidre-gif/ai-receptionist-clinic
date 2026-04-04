import { Router } from 'express';
import { pipelineTurn, telnyxWebhook } from '../controllers/voiceController';
import { verifyToken } from '../middleware/auth';

const router = Router();

// POST /voice/pipeline/turn — run a single conversation turn (auth required — clinic_id from JWT)
router.post('/pipeline/turn', verifyToken, pipelineTurn);

// POST /voice/telnyx/webhook — Telnyx call event handler (no user auth — called by Telnyx)
router.post('/telnyx/webhook', telnyxWebhook);

export default router;
