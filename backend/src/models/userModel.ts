import { query } from '../config/db';

export interface User {
  id: string;
  clinicId: string;
  email: string;
  passwordHash: string;
  role: string;
  createdAt: Date;
}

export async function createUser(
  email: string,
  passwordHash: string,
  clinicId: string,
  role = 'admin'
): Promise<User> {
  try {
    const result = await query(
      `INSERT INTO users (email, password_hash, clinic_id, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, clinic_id AS "clinicId", email, password_hash AS "passwordHash", role, created_at AS "createdAt"`,
      [email, passwordHash, clinicId, role]
    );
    return result.rows[0] as User;
  } catch (error) {
    const err = error as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'userModel',
      message: 'createUser failed',
      clinicId,
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    throw error;
  }
}

export async function findUserByEmail(email: string): Promise<User | null> {
  try {
    const result = await query(
      `SELECT id, clinic_id AS "clinicId", email, password_hash AS "passwordHash", role, created_at AS "createdAt"
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email]
    );
    return (result.rows[0] as User) ?? null;
  } catch (error) {
    const err = error as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'userModel',
      message: 'findUserByEmail failed',
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    throw error;
  }
}

export async function findUserById(id: string): Promise<User | null> {
  try {
    const result = await query(
      `SELECT id, clinic_id AS "clinicId", email, password_hash AS "passwordHash", role, created_at AS "createdAt"
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [id]
    );
    return (result.rows[0] as User) ?? null;
  } catch (error) {
    const err = error as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'userModel',
      message: 'findUserById failed',
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    throw error;
  }
}
