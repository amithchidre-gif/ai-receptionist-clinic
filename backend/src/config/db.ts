import { Pool, QueryResult } from 'pg';

if (!process.env.DATABASE_URL) {
  console.warn('[db.ts] DATABASE_URL is not set — database operations will fail. Set it in Render dashboard.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/placeholder',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
  console.log('Database connected');
});

pool.on('error', (err: Error) => {
  console.error('Database pool error:', err.message);
});

export async function query(text: string, params?: unknown[]): Promise<QueryResult> {
  try {
    return await pool.query(text, params);
  } catch (error) {
    const err = error as Error;
    console.error('Database query error:', err.message);
    throw error;
  }
}
