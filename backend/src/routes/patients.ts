import { Router } from 'express';
import { verifyToken } from '../middleware/auth';
import { listPatients, getPatientById } from '../controllers/patientController';

const router = Router();

router.get('/', verifyToken, (req, res) => listPatients(req, res));
router.get('/:id', verifyToken, (req, res) => getPatientById(req, res));

export default router;
