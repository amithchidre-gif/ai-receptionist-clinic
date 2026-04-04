import { Router } from 'express';
import { verifyToken } from '../middleware/auth';
import { getDashboard } from '../controllers/dashboardController';

const router = Router();

router.get('/', verifyToken, getDashboard);

export default router;
