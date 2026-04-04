import { Request, Response } from 'express';
import { query } from '../config/db';
import { sendSuccess, sendError } from '../middleware/responseHelpers';

export async function listPatients(req: Request, res: Response): Promise<void> {
  const { clinicId } = req.user!;
  const search = (req.query.search as string | undefined)?.trim() ?? '';

  try {
    const params: unknown[] = [clinicId];
    let whereClause = 'WHERE p.clinic_id = $1';

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (p.name ILIKE $${params.length} OR p.phone ILIKE $${params.length})`;
    }

    const result = await query(
      `SELECT
         p.id,
         p.clinic_id,
         p.name,
         p.phone,
         p.date_of_birth,
         p.created_at,
         COUNT(a.id)::int AS appointments_count
       FROM patients p
       LEFT JOIN appointments a ON a.patient_id = p.id
       ${whereClause}
       GROUP BY p.id
       ORDER BY p.created_at DESC
       LIMIT 100`,
      params,
    );

    const patients = result.rows.map((row) => ({
      id: row.id as string,
      clinicId: row.clinic_id as string,
      name: (row.name as string) ?? '—',
      phone: row.phone as string,
      dob: (row.date_of_birth as string) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
      appointmentsCount: (row.appointments_count as number) ?? 0,
    }));

    sendSuccess(res, patients);
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({ level: 'error', service: 'patientController', message: 'listPatients failed', clinicId, error: error.message, timestamp: new Date().toISOString() }));
    sendError(res, 'Failed to fetch patients', 500);
  }
}

export async function getPatientById(req: Request, res: Response): Promise<void> {
  const { clinicId } = req.user!;
  const { id } = req.params;

  try {
    const patientResult = await query(
      `SELECT
         p.id,
         p.clinic_id,
         p.name,
         p.phone,
         p.date_of_birth,
         p.created_at,
         COUNT(a.id)::int AS appointments_count
       FROM patients p
       LEFT JOIN appointments a ON a.patient_id = p.id
       WHERE p.id = $1 AND p.clinic_id = $2
       GROUP BY p.id`,
      [id, clinicId],
    );

    if (patientResult.rows.length === 0) {
      sendError(res, 'Patient not found', 404);
      return;
    }

    const row = patientResult.rows[0];
    const patient = {
      id: row.id as string,
      clinicId: row.clinic_id as string,
      name: (row.name as string) ?? '—',
      phone: row.phone as string,
      dob: (row.date_of_birth as string) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
      appointmentsCount: (row.appointments_count as number) ?? 0,
    };

    // Last 5 appointments for this patient
    const apptResult = await query(
      `SELECT id, appointment_date, appointment_time, status, form_completed
       FROM appointments
       WHERE patient_id = $1 AND clinic_id = $2
       ORDER BY appointment_date DESC, appointment_time DESC
       LIMIT 5`,
      [id, clinicId],
    );

    const appointments = apptResult.rows.map((a) => ({
      id: a.id as string,
      date: a.appointment_date as string,
      time: a.appointment_time as string,
      status: a.status as string,
      formCompleted: a.form_completed as boolean,
    }));

    sendSuccess(res, { ...patient, appointments });
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({ level: 'error', service: 'patientController', message: 'getPatientById failed', clinicId, error: error.message, timestamp: new Date().toISOString() }));
    sendError(res, 'Failed to fetch patient', 500);
  }
}
