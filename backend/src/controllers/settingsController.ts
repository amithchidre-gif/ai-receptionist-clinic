import { Request, Response } from 'express';
import { query } from '../config/db';
import { sendSuccess, sendError } from '../middleware/responseHelpers';

// Ensure working_hours column exists (idempotent, runs once at import time)
query(`ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS working_hours TEXT`).catch(() => {});

const ALLOWED_FIELDS = new Set([
  'clinicName',
  'aiEnabled',
  'aiReceptionistEnabled', // frontend alias for aiEnabled
  'workingHours',
  'telnyxPhoneNumber',
  'phone', // frontend alias for telnyxPhoneNumber
  'googleCalendarId',
  'calendarId', // frontend alias for googleCalendarId
]);

const DEFAULTS = {
  clinicName: '',
  aiReceptionistEnabled: true,
  workingHours: '',
  phone: '',
  calendarId: '',
};

function rowToResponse(row: Record<string, unknown>) {
  return {
    clinicName: (row.clinic_name as string) ?? '',
    aiReceptionistEnabled: (row.ai_enabled as boolean) ?? true,
    workingHours: (row.working_hours as string) ?? '',
    phone: (row.telnyx_phone_number as string) ?? '',
    calendarId: (row.google_calendar_id as string) ?? '',
  };
}

export async function getSettings(req: Request, res: Response): Promise<void> {
  const { clinicId } = req.user!;
  try {
    const result = await query(
      `SELECT c.name AS clinic_name,
              cs.telnyx_phone_number,
              cs.google_calendar_id,
              cs.ai_enabled,
              cs.working_hours
       FROM clinic_settings cs
       JOIN clinics c ON c.id = cs.clinic_id
       WHERE cs.clinic_id = $1`,
      [clinicId],
    );

    if (result.rows.length === 0) {
      // Return defaults — never a 404 for settings
      sendSuccess(res, { ...DEFAULTS, clinicId });
      return;
    }

    sendSuccess(res, rowToResponse(result.rows[0]));
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({ level: 'error', service: 'settingsController', message: 'getSettings failed', clinicId, error: error.message, timestamp: new Date().toISOString() }));
    sendError(res, 'Failed to fetch settings', 500);
  }
}

export async function updateSettings(req: Request, res: Response): Promise<void> {
  const { clinicId } = req.user!;

  // Reject unknown fields
  const unknownFields = Object.keys(req.body).filter((k) => !ALLOWED_FIELDS.has(k));
  if (unknownFields.length > 0) {
    sendError(res, `Unknown fields: ${unknownFields.join(', ')}`, 400);
    return;
  }

  // Normalise aliases to canonical names
  const {
    clinicName,
    aiEnabled,
    aiReceptionistEnabled,
    workingHours,
    telnyxPhoneNumber,
    phone,
    googleCalendarId,
    calendarId,
  } = req.body as Record<string, string | boolean | undefined>;

  const resolvedAiEnabled = aiReceptionistEnabled ?? aiEnabled;
  const resolvedPhone = phone ?? telnyxPhoneNumber;
  const resolvedCalendarId = calendarId ?? googleCalendarId;

  try {
    if (clinicName !== undefined) {
      await query(`UPDATE clinics SET name = $1 WHERE id = $2`, [clinicName, clinicId]);
    }

    // Upsert clinic_settings row.
    // NOTE: ai_enabled is NOT NULL in the schema, so we must not pass explicit NULL in the
    // INSERT path — use COALESCE($3, TRUE) so a new row gets a valid default even when the
    // caller omits aiEnabled. The ON CONFLICT path still uses COALESCE to preserve existing.
    await query(
      `INSERT INTO clinic_settings (clinic_id, telnyx_phone_number, google_calendar_id, ai_enabled, working_hours)
       VALUES ($5, $1, $2, COALESCE($3, TRUE), $4)
       ON CONFLICT (clinic_id) DO UPDATE SET
         telnyx_phone_number = COALESCE(EXCLUDED.telnyx_phone_number, clinic_settings.telnyx_phone_number),
         google_calendar_id  = COALESCE(EXCLUDED.google_calendar_id,  clinic_settings.google_calendar_id),
         ai_enabled          = COALESCE(EXCLUDED.ai_enabled,          clinic_settings.ai_enabled),
         working_hours       = COALESCE(EXCLUDED.working_hours,       clinic_settings.working_hours),
         updated_at          = NOW()`,
      [
        resolvedPhone       ?? null,
        resolvedCalendarId  ?? null,
        resolvedAiEnabled   ?? null,
        workingHours        ?? null,
        clinicId,
      ],
    );

    const updated = await query(
      `SELECT c.name AS clinic_name,
              cs.telnyx_phone_number,
              cs.google_calendar_id,
              cs.ai_enabled,
              cs.working_hours
       FROM clinic_settings cs
       JOIN clinics c ON c.id = cs.clinic_id
       WHERE cs.clinic_id = $1`,
      [clinicId],
    );

    sendSuccess(res, rowToResponse(updated.rows[0]));
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({ level: 'error', service: 'settingsController', message: 'updateSettings failed', clinicId, error: error.message, timestamp: new Date().toISOString() }));
    sendError(res, 'Failed to save settings', 500);
  }
}
