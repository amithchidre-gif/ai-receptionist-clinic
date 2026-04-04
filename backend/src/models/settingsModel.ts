import { query } from '../config/db';

export interface Settings {
  id: string;
  clinicId: string;
  clinicName: string | null;
  telnyxPhoneNumber: string | null;
  googleCalendarId: string | null;
  ttsVoiceId: string | null;
  aiEnabled: boolean;
}

function rowToSettings(row: Record<string, unknown>): Settings {
  return {
    id: row.id as string,
    clinicId: row.clinic_id as string,
    clinicName: (row.clinic_name as string) ?? null,
    telnyxPhoneNumber: (row.telnyx_phone_number as string) ?? null,
    googleCalendarId: (row.google_calendar_id as string) ?? null,
    ttsVoiceId: (row.elevenlabs_voice_id as string) ?? null,
    aiEnabled: row.ai_enabled as boolean,
  };
}

export async function getSettingsByClinicId(clinicId: string): Promise<Settings | null> {
  const result = await query(
    `SELECT cs.id, cs.clinic_id, c.name AS clinic_name,
            cs.telnyx_phone_number, cs.google_calendar_id,
            cs.elevenlabs_voice_id, cs.ai_enabled
     FROM clinic_settings cs
     JOIN clinics c ON c.id = cs.clinic_id
     WHERE cs.clinic_id = $1`,
    [clinicId],
  );
  if (result.rows.length === 0) return null;
  return rowToSettings(result.rows[0]);
}

export async function getClinicIdByPhoneNumber(phoneNumber: string): Promise<string | null> {
  const result = await query(
    `SELECT clinic_id FROM clinic_settings WHERE telnyx_phone_number = $1`,
    [phoneNumber],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].clinic_id as string;
}

export async function updateSettings(
  clinicId: string,
  fields: Partial<Pick<Settings, 'telnyxPhoneNumber' | 'googleCalendarId' | 'ttsVoiceId' | 'aiEnabled'>>,
): Promise<Settings | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (fields.telnyxPhoneNumber !== undefined) {
    setClauses.push(`telnyx_phone_number = $${idx++}`);
    values.push(fields.telnyxPhoneNumber);
  }
  if (fields.googleCalendarId !== undefined) {
    setClauses.push(`google_calendar_id = $${idx++}`);
    values.push(fields.googleCalendarId);
  }
  if (fields.ttsVoiceId !== undefined) {
    setClauses.push(`elevenlabs_voice_id = $${idx++}`);
    values.push(fields.ttsVoiceId);
  }
  if (fields.aiEnabled !== undefined) {
    setClauses.push(`ai_enabled = $${idx++}`);
    values.push(fields.aiEnabled);
  }

  if (setClauses.length === 0) return getSettingsByClinicId(clinicId);

  setClauses.push(`updated_at = NOW()`);
  values.push(clinicId);

  await query(
    `UPDATE clinic_settings SET ${setClauses.join(', ')} WHERE clinic_id = $${idx}`,
    values,
  );
  return getSettingsByClinicId(clinicId);
}

export async function createDefaultSettings(clinicId: string): Promise<void> {
  await query(
    `INSERT INTO clinic_settings (clinic_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [clinicId],
  );
}
