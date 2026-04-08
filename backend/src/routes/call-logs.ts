import { Router } from 'express';
import { verifyToken } from '../middleware/auth';
import { listCallLogs, getCallLogTurns } from '../controllers/callLogController';

const router = Router();

router.get('/', verifyToken, (req, res) => listCallLogs(req, res));
router.get('/:id/turns', verifyToken, (req, res) => getCallLogTurns(req, res));

export default router;
