import { Router } from 'express';
import { verifyToken } from '../middleware/auth';
import { getSettings, updateSettings } from '../controllers/settingsController';

const router = Router();

router.get('/', verifyToken, (req, res) => getSettings(req, res));
router.put('/', verifyToken, (req, res) => updateSettings(req, res));

export default router;
