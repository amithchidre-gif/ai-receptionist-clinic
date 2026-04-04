import { Request, Response } from 'express';
import { query } from '../config/db';
import { sendSuccess, sendError } from '../middleware/responseHelpers';

export async function getDashboard(req: Request, res: Response): Promise<void> {
  const { clinicId } = req.user!;

  try {
    const [
      callsTodayRes,
      apptTodayRes,
      apptWeekRes,
      newPatientsRes,
      pendingFormsRes,
      recentCallsRes,
    ] = await Promise.all([
      // totalCallsToday — started_at is TIMESTAMP
      query(
        `SELECT COUNT(*)::int AS count
         FROM call_logs
         WHERE clinic_id = $1
           AND DATE(started_at) = CURRENT_DATE`,
        [clinicId],
      ),
      // appointmentsToday — appointment_date stored as TEXT 'YYYY-MM-DD'
      query(
        `SELECT COUNT(*)::int AS count
         FROM appointments
         WHERE clinic_id = $1
           AND appointment_date = TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
           AND status = 'scheduled'`,
        [clinicId],
      ),
      // appointmentsThisWeek — text date range comparison
      query(
        `SELECT COUNT(*)::int AS count
         FROM appointments
         WHERE clinic_id = $1
           AND appointment_date >= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
           AND appointment_date <= TO_CHAR(CURRENT_DATE + INTERVAL '6 days', 'YYYY-MM-DD')
           AND status = 'scheduled'`,
        [clinicId],
      ),
      // newPatientsThisWeek
      query(
        `SELECT COUNT(*)::int AS count
         FROM patients
         WHERE clinic_id = $1
           AND created_at > NOW() - INTERVAL '7 days'`,
        [clinicId],
      ),
      // pendingForms
      query(
        `SELECT COUNT(*)::int AS count
         FROM appointments
         WHERE clinic_id = $1
           AND status = 'scheduled'
           AND form_completed = false
           AND appointment_date >= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')`,
        [clinicId],
      ),
      // recentCalls (last 5)
      query(
        `SELECT id, from_number, status, started_at, duration_seconds
         FROM call_logs
         WHERE clinic_id = $1
         ORDER BY started_at DESC
         LIMIT 5`,
        [clinicId],
      ),
    ]);

    // Mask phone: show '***-XXXX' using last 4 digits only
    const recentCalls = recentCallsRes.rows.map((row) => {
      const raw: string = (row.from_number as string) ?? '';
      const digits = raw.replace(/\D/g, '');
      const masked = digits.length >= 4 ? `***-${digits.slice(-4)}` : '***-****';
      return {
        id:              row.id as string,
        fromNumber:      masked,
        status:          row.status as string,
        startedAt:       row.started_at as Date | null,
        durationSeconds: (row.duration_seconds as number) ?? null,
      };
    });

    sendSuccess(res, {
      totalCallsToday:      callsTodayRes.rows[0]?.count  ?? 0,
      appointmentsToday:    apptTodayRes.rows[0]?.count   ?? 0,
      appointmentsThisWeek: apptWeekRes.rows[0]?.count    ?? 0,
      newPatientsThisWeek:  newPatientsRes.rows[0]?.count ?? 0,
      pendingForms:         pendingFormsRes.rows[0]?.count ?? 0,
      recentCalls,
    });
  } catch (err: unknown) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'dashboardController',
      message: 'getDashboard failed',
      clinicId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    sendError(res, 'Failed to load dashboard data', 500);
  }
}
