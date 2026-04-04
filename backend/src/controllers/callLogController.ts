import { Request, Response } from 'express';
import { query } from '../config/db';
import { sendSuccess, sendError } from '../middleware/responseHelpers';

export async function listCallLogs(req: Request, res: Response): Promise<void> {
  const { clinicId } = req.user!;

  try {
    const result = await query(
      `SELECT
         id,
         from_number,
         status,
         started_at,
         duration_seconds
       FROM call_logs
       WHERE clinic_id = $1
       ORDER BY started_at DESC
       LIMIT 100`,
      [clinicId],
    );

    const logs = result.rows.map((row) => ({
      id: row.id as string,
      fromNumber: (row.from_number as string) ?? '',
      status: row.status as string,
      startedAt: row.started_at ? (row.started_at as Date).toISOString() : null,
      durationSeconds: (row.duration_seconds as number) ?? null,
    }));

    sendSuccess(res, logs);
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({ level: 'error', service: 'callLogController', message: 'listCallLogs failed', clinicId, error: error.message, timestamp: new Date().toISOString() }));
    sendError(res, 'Failed to fetch call logs', 500);
  }
}
