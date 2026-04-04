import { query } from '../config/db';

// Note: The fields durationMinutes, visitType, reminderSentAt, and notes are not
// present in the current migration schema. The interface reflects actual DB columns.
export interface Appointment {
  id: string;
  clinicId: string;
  patientId: string;
  patientName: string | null;       // JOIN from patients table
  appointmentDate: string;          // "YYYY-MM-DD"
  appointmentTime: string;          // "HH:MM"
  status: string;                   // 'scheduled' | 'cancelled' | 'completed'
  googleEventId: string | null;
  createdVia: string;
  reminderSent: boolean;
  formCompleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAppointmentParams {
  clinicId: string;
  patientId: string;
  appointmentDate: string;
  appointmentTime: string;
  status?: string;
  googleEventId?: string;
  createdVia?: string;
}

function rowToAppointment(row: Record<string, unknown>): Appointment {
  return {
    id: row.id as string,
    clinicId: row.clinic_id as string,
    patientId: row.patient_id as string,
    patientName: (row.patient_name as string) ?? null,
    appointmentDate: row.appointment_date as string,
    appointmentTime: row.appointment_time as string,
    status: row.status as string,
    googleEventId: (row.google_event_id as string) ?? null,
    createdVia: row.created_via as string,
    reminderSent: row.reminder_sent as boolean,
    formCompleted: row.form_completed as boolean,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export async function createAppointment(
  params: CreateAppointmentParams,
): Promise<Appointment> {
  const {
    clinicId,
    patientId,
    appointmentDate,
    appointmentTime,
    status = 'scheduled',
    googleEventId = null,
    createdVia = 'voice',
  } = params;

  try {
    const result = await query(
      `INSERT INTO appointments
         (clinic_id, patient_id, appointment_date, appointment_time,
          status, google_event_id, created_via)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [clinicId, patientId, appointmentDate, appointmentTime, status, googleEventId, createdVia],
    );

    // Fetch with patient name for the return value
    const appt = await query(
      `SELECT a.*, p.name AS patient_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND a.clinic_id = $2`,
      [result.rows[0].id as string, clinicId],
    );

    console.info(JSON.stringify({
      level: 'info',
      service: 'appointmentModel',
      message: 'Appointment created',
      clinicId,
      appointmentId: result.rows[0].id,
      createdVia,
      timestamp: new Date().toISOString(),
    }));

    return rowToAppointment(appt.rows[0]);
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'appointmentModel',
      message: 'createAppointment failed',
      clinicId,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}

export async function getAppointments(
  clinicId: string,
  filters?: { status?: string; date?: string },
): Promise<Appointment[]> {
  try {
    const conditions: string[] = ['a.clinic_id = $1'];
    const values: unknown[] = [clinicId];
    let idx = 2;

    if (filters?.status) {
      conditions.push(`a.status = $${idx++}`);
      values.push(filters.status);
    }
    if (filters?.date) {
      conditions.push(`a.appointment_date = $${idx++}`);
      values.push(filters.date);
    }

    const result = await query(
      `SELECT a.*, p.name AS patient_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.appointment_date ASC, a.appointment_time ASC`,
      values,
    );

    return result.rows.map(rowToAppointment);
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'appointmentModel',
      message: 'getAppointments failed',
      clinicId,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}

export async function cancelAppointment(
  clinicId: string,
  id: string,
): Promise<Appointment> {
  try {
    const existing = await query(
      `SELECT id FROM appointments WHERE id = $1 AND clinic_id = $2`,
      [id, clinicId],
    );

    if (existing.rows.length === 0) {
      const err = new Error('Appointment not found or access denied');
      (err as Error & { statusCode: number }).statusCode = 403;
      throw err;
    }

    await query(
      `UPDATE appointments
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND clinic_id = $2`,
      [id, clinicId],
    );

    const result = await query(
      `SELECT a.*, p.name AS patient_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND a.clinic_id = $2`,
      [id, clinicId],
    );

    console.info(JSON.stringify({
      level: 'info',
      service: 'appointmentModel',
      message: 'Appointment cancelled',
      clinicId,
      appointmentId: id,
      timestamp: new Date().toISOString(),
    }));

    return rowToAppointment(result.rows[0]);
  } catch (err: unknown) {
    const error = err as Error;
    if ((error as Error & { statusCode?: number }).statusCode === 403) throw err;
    console.error(JSON.stringify({
      level: 'error',
      service: 'appointmentModel',
      message: 'cancelAppointment failed',
      clinicId,
      appointmentId: id,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}

export async function getPendingReminders(): Promise<Array<Appointment & { patientPhone: string }>> {
  // Compute "tomorrow" in Node.js to avoid skew between the application server's
  // timezone and the PostgreSQL container's CURRENT_DATE.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10); // 'YYYY-MM-DD'

  try {
    const result = await query(
      `SELECT a.*, p.name AS patient_name, p.phone AS patient_phone
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.status = 'scheduled'
         AND a.appointment_date = $1
         AND a.reminder_sent = false`,
      [tomorrowStr],
    );

    return result.rows.map((row) => ({
      ...rowToAppointment(row as Record<string, unknown>),
      patientPhone: row.patient_phone as string,
    }));
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'appointmentModel',
      message: 'getPendingReminders failed',
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}

export async function markReminderSent(appointmentId: string, clinicId: string): Promise<void> {
  try {
    await query(
      `UPDATE appointments
       SET reminder_sent = true, updated_at = NOW()
       WHERE id = $1 AND clinic_id = $2`,
      [appointmentId, clinicId],
    );
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'appointmentModel',
      message: 'markReminderSent failed',
      clinicId,
      appointmentId,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}

export async function markFormCompleted(
  appointmentId: string,
  clinicId: string,
): Promise<void> {
  try {
    await query(
      `UPDATE appointments
       SET form_completed = true, updated_at = NOW()
       WHERE id = $1 AND clinic_id = $2`,
      [appointmentId, clinicId],
    );
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'appointmentModel',
      message: 'markFormCompleted failed',
      clinicId,
      appointmentId,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}
