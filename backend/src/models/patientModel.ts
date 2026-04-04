import { query } from '../config/db';

export interface Patient {
  id: string;
  clinicId: string;
  name: string | null;
  phone: string;
  dateOfBirth: string | null;
  createdAt: Date;
}

interface UpsertPatientParams {
  clinicId: string;
  name: string;
  phone: string;
  dateOfBirth?: string;
}

function rowToPatient(row: Record<string, unknown>): Patient {
  return {
    id: row.id as string,
    clinicId: row.clinic_id as string,
    name: (row.name as string) ?? null,
    phone: row.phone as string,
    dateOfBirth: (row.date_of_birth as string) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

export async function upsertPatient(
  params: UpsertPatientParams,
): Promise<{ patient: Patient; isNew: boolean }> {
  const { clinicId, name, phone, dateOfBirth } = params;

  try {
    const existing = await query(
      `SELECT * FROM patients WHERE clinic_id = $1 AND phone = $2`,
      [clinicId, phone],
    );

    if (existing.rows.length > 0) {
      console.info(JSON.stringify({
        level: 'info',
        service: 'patientModel',
        message: 'Patient upserted',
        clinicId,
        isNew: false,
        timestamp: new Date().toISOString(),
      }));
      return { patient: rowToPatient(existing.rows[0]), isNew: false };
    }

    const inserted = await query(
      `INSERT INTO patients (clinic_id, name, phone, date_of_birth)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [clinicId, name, phone, dateOfBirth ?? null],
    );

    console.info(JSON.stringify({
      level: 'info',
      service: 'patientModel',
      message: 'Patient upserted',
      clinicId,
      isNew: true,
      timestamp: new Date().toISOString(),
    }));

    return { patient: rowToPatient(inserted.rows[0]), isNew: true };
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'patientModel',
      message: 'upsertPatient failed',
      clinicId,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}

export async function getPatients(
  clinicId: string,
  search?: string,
): Promise<Patient[]> {
  try {
    if (search) {
      const result = await query(
        `SELECT * FROM patients
         WHERE clinic_id = $1 AND (name ILIKE $2 OR phone ILIKE $2)
         ORDER BY created_at DESC
         LIMIT 100`,
        [clinicId, `%${search}%`],
      );
      return result.rows.map(rowToPatient);
    }

    const result = await query(
      `SELECT * FROM patients
       WHERE clinic_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [clinicId],
    );
    return result.rows.map(rowToPatient);
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'patientModel',
      message: 'getPatients failed',
      clinicId,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}

export async function getPatientById(
  clinicId: string,
  patientId: string,
): Promise<Patient | null> {
  try {
    const result = await query(
      `SELECT * FROM patients WHERE clinic_id = $1 AND id = $2`,
      [clinicId, patientId],
    );
    if (result.rows.length === 0) return null;
    return rowToPatient(result.rows[0]);
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'patientModel',
      message: 'getPatientById failed',
      clinicId,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}
