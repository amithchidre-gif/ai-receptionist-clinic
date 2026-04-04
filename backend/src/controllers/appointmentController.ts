import { Request, Response } from 'express';
import { sendSuccess, sendError } from '../middleware/responseHelpers';
import { getAppointments, cancelAppointment } from '../models/appointmentModel';
import { getPatientById } from '../models/patientModel';
import { getSettingsByClinicId } from '../models/settingsModel';
import { cancelCalendarEvent } from '../services/googleCalendarService';
import { sendCancellationSms } from '../services/smsService';

export async function listAppointments(req: Request, res: Response): Promise<void> {
  const { clinicId } = req.user!;
  const { status, date } = req.query as { status?: string; date?: string };

  try {
    const appointments = await getAppointments(clinicId, {
      ...(status ? { status } : {}),
      ...(date   ? { date }   : {}),
    });
    sendSuccess(res, appointments);
  } catch (err: unknown) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'appointmentController',
      message: 'listAppointments failed',
      clinicId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    sendError(res, 'Failed to fetch appointments', 500);
  }
}

export async function cancelAppointmentHandler(req: Request, res: Response): Promise<void> {
  const { clinicId } = req.user!;
  const { id } = req.params;

  if (!id) {
    sendError(res, 'Appointment ID is required', 400);
    return;
  }

  let appointment;
  try {
    appointment = await cancelAppointment(clinicId, id);
  } catch (err: unknown) {
    const e = err as Error & { statusCode?: number };
    if (e.statusCode === 403) {
      sendError(res, 'Appointment not found', 404);
    } else {
      console.error(JSON.stringify({
        level: 'error',
        service: 'appointmentController',
        message: 'cancelAppointment model failed',
        clinicId,
        appointmentId: id,
        error: e.message,
        timestamp: new Date().toISOString(),
      }));
      sendError(res, 'Failed to cancel appointment', 500);
    }
    return;
  }

  // Cancel Google Calendar event (non-fatal)
  if (appointment.googleEventId) {
    try {
      await cancelCalendarEvent(clinicId, appointment.googleEventId);
    } catch (calErr: unknown) {
      console.warn(JSON.stringify({
        level: 'warn',
        service: 'appointmentController',
        message: 'cancelCalendarEvent failed — appointment still cancelled',
        clinicId,
        appointmentId: id,
        googleEventId: appointment.googleEventId,
        error: (calErr as Error).message,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  // Send cancellation SMS (non-fatal)
  try {
    const [settings, patient] = await Promise.all([
      getSettingsByClinicId(clinicId),
      getPatientById(clinicId, appointment.patientId),
    ]);
    const clinicName = settings?.clinicName ?? 'the clinic';
    if (patient?.phone) {
      await sendCancellationSms(
        clinicId,
        patient.phone,
        appointment.appointmentDate,
        appointment.appointmentTime,
        clinicName,
      );
    }
  } catch (smsErr: unknown) {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'appointmentController',
      message: 'sendCancellationSms failed — appointment still cancelled',
      clinicId,
      appointmentId: id,
      error: (smsErr as Error).message,
      timestamp: new Date().toISOString(),
    }));
  }

  sendSuccess(res, appointment);
}
