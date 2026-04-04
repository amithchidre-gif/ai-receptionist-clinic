import crypto from 'crypto';
import { query } from '../config/db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormTokenPayload {
  clinicId: string;
  appointmentId: string;
  patientId: string;
  patientName: string;
  patientDob: string;
  appointmentDate: string;
  appointmentTime: string;
  clinicName: string;
}

// ---------------------------------------------------------------------------
// createFormToken
// ---------------------------------------------------------------------------

export async function createFormToken(params: {
  clinicId: string;
  appointmentId: string;
  patientId: string;
}): Promise<string> {
  const { clinicId, appointmentId, patientId } = params;
  const token = crypto.randomBytes(32).toString('hex');

  await query(
    `INSERT INTO form_tokens (clinic_id, appointment_id, patient_id, token, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '72 hours')`,
    [clinicId, appointmentId, patientId, token],
  );

  return token;
}

// ---------------------------------------------------------------------------
// validateFormToken
// ---------------------------------------------------------------------------

export async function validateFormToken(token: string): Promise<FormTokenPayload | null> {
  const result = await query(
    `SELECT
       ft.clinic_id,
       ft.appointment_id,
       ft.patient_id,
       p.name            AS patient_name,
       p.date_of_birth   AS patient_dob,
       a.appointment_date,
       a.appointment_time,
       c.name            AS clinic_name
     FROM form_tokens ft
     JOIN patients     p  ON p.id  = ft.patient_id
     JOIN appointments a  ON a.id  = ft.appointment_id
     JOIN clinics      c  ON c.id  = ft.clinic_id
     WHERE ft.token      = $1
       AND ft.used       = false
       AND ft.expires_at > NOW()`,
    [token],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    clinicId:        row.clinic_id        as string,
    appointmentId:   row.appointment_id   as string,
    patientId:       row.patient_id       as string,
    patientName:     (row.patient_name    as string) ?? '',
    patientDob:      (row.patient_dob     as string) ?? '',
    appointmentDate: row.appointment_date as string,
    appointmentTime: row.appointment_time as string,
    clinicName:      (row.clinic_name     as string) ?? 'the clinic',
  };
}

// ---------------------------------------------------------------------------
// markTokenUsed
// ---------------------------------------------------------------------------

export async function markTokenUsed(token: string): Promise<void> {
  await query(
    `UPDATE form_tokens SET used = true WHERE token = $1`,
    [token],
  );
}
