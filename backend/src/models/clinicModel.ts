import { query } from '../config/db';

export interface Clinic {
  id: string;
  name: string;
  createdAt: Date;
}

export async function createClinic(name: string): Promise<Clinic> {
  try {
    const result = await query(
      `INSERT INTO clinics (name)
       VALUES ($1)
       RETURNING id, name, created_at AS "createdAt"`,
      [name]
    );
    return result.rows[0] as Clinic;
  } catch (error) {
    const err = error as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'clinicModel',
      message: 'createClinic failed',
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    throw error;
  }
}

export async function findClinicById(id: string): Promise<Clinic | null> {
  try {
    const result = await query(
      `SELECT id, name, created_at AS "createdAt"
       FROM clinics
       WHERE id = $1
       LIMIT 1`,
      [id]
    );
    return (result.rows[0] as Clinic) ?? null;
  } catch (error) {
    const err = error as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'clinicModel',
      message: 'findClinicById failed',
      clinicId: id,
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    throw error;
  }
}

export async function createClinicSettings(clinicId: string): Promise<void> {
  try {
    await query(
      `INSERT INTO clinic_settings (clinic_id)
       VALUES ($1)
       ON CONFLICT (clinic_id) DO NOTHING`,
      [clinicId]
    );
  } catch (error) {
    const err = error as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'clinicModel',
      message: 'createClinicSettings failed',
      clinicId,
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    throw error;
  }
}
