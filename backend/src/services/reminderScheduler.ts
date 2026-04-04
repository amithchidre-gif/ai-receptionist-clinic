import { query } from '../config/db';
import { getPendingReminders, markReminderSent } from '../models/appointmentModel';
import { sendReminderSms } from './smsService';

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Batch clinic-name lookup
// ---------------------------------------------------------------------------

async function getClinicNameMap(clinicIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (clinicIds.length === 0) return map;

  try {
    const result = await query(
      `SELECT cs.clinic_id, c.name AS clinic_name
       FROM clinic_settings cs
       JOIN clinics c ON c.id = cs.clinic_id
       WHERE cs.clinic_id = ANY($1)`,
      [clinicIds],
    );
    for (const row of result.rows) {
      map.set(row.clinic_id as string, row.clinic_name as string);
    }
  } catch (err: unknown) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'reminderScheduler',
      message: 'Failed to fetch clinic names',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    // Return empty map — callers fall back to 'your clinic'
  }
  return map;
}

// ---------------------------------------------------------------------------
// Core reminder run (exported for direct testing)
// ---------------------------------------------------------------------------

export async function sendPendingReminders(): Promise<void> {
  let sent = 0;
  let failed = 0;

  try {
    const pending = await getPendingReminders();

    if (pending.length === 0) {
      console.log(JSON.stringify({
        level: 'debug',
        service: 'reminderScheduler',
        message: 'No reminders to send',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Batch-fetch all required clinic names in a single query
    const uniqueClinicIds = [...new Set(pending.map((a) => a.clinicId))];
    const clinicNameMap = await getClinicNameMap(uniqueClinicIds);

    for (const appointment of pending) {
      try {
        const clinicName = clinicNameMap.get(appointment.clinicId) ?? 'your clinic';

        await sendReminderSms(
          appointment.clinicId,
          appointment.patientPhone,
          appointment.appointmentDate,
          appointment.appointmentTime,
          clinicName,
        );

        await markReminderSent(appointment.id, appointment.clinicId);

        console.log(JSON.stringify({
          level: 'info',
          service: 'reminderScheduler',
          message: 'Reminder sent',
          appointmentId: appointment.id,
          timestamp: new Date().toISOString(),
        }));

        sent++;
      } catch (err: unknown) {
        failed++;
        console.error(JSON.stringify({
          level: 'error',
          service: 'reminderScheduler',
          message: 'Failed to send reminder for appointment',
          appointmentId: appointment.id,
          error: (err as Error).message,
          timestamp: new Date().toISOString(),
        }));
        // Continue — one failure must not stop remaining reminders
      }
    }
  } catch (err: unknown) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'reminderScheduler',
      message: 'sendPendingReminders run failed',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  console.log(JSON.stringify({
    level: 'info',
    service: 'reminderScheduler',
    message: 'Reminder run complete',
    sent,
    failed,
    timestamp: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Exported scheduler entry point
// ---------------------------------------------------------------------------

export function startReminderScheduler(): void {
  console.log(JSON.stringify({
    level: 'info',
    service: 'reminderScheduler',
    message: 'Reminder scheduler started',
    intervalMs: INTERVAL_MS,
    timestamp: new Date().toISOString(),
  }));

  // Run immediately on startup, then on every interval
  sendPendingReminders().catch((err: unknown) => {
    console.error(JSON.stringify({
      level: 'error',
      service: 'reminderScheduler',
      message: 'Initial reminder run threw unexpectedly',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
  });

  setInterval(() => {
    sendPendingReminders().catch((err: unknown) => {
      console.error(JSON.stringify({
        level: 'error',
        service: 'reminderScheduler',
        message: 'Scheduled reminder run threw unexpectedly',
        error: (err as Error).message,
        timestamp: new Date().toISOString(),
      }));
    });
  }, INTERVAL_MS);
}
