import { Router } from 'express';
import { verifyToken } from '../middleware/auth';
import { listAppointments, cancelAppointmentHandler } from '../controllers/appointmentController';

const router = Router();

router.get('/',        verifyToken, listAppointments);
router.patch('/:id/cancel', verifyToken, cancelAppointmentHandler);

export default router;
