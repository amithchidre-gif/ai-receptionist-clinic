import Telnyx from 'telnyx';
import { config } from '../config/env';
import { query } from '../config/db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmsResult {
  messageId: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Helper: get clinic's outbound Telnyx number
// ---------------------------------------------------------------------------

async function getClinicFromNumber(clinicId: string): Promise<string> {
  const result = await query(
    `SELECT telnyx_phone_number FROM clinic_settings WHERE clinic_id = $1`,
    [clinicId],
  );
  const number: string | null = result.rows[0]?.telnyx_phone_number ?? null;
  if (!number) {
    throw new Error(`Telnyx phone number not configured for clinic ${clinicId}`);
  }
  return number;
}

// ---------------------------------------------------------------------------
// Core (private): send one SMS and persist log row
// ---------------------------------------------------------------------------

/** Extract the most useful error message from any thrown value (Telnyx or plain Error). */
function extractErrorDetail(err: unknown): { detail: string; code?: string; statusCode?: number } {
  const e = err as {
    message?: string;
    statusCode?: number;
    raw?: { errors?: Array<{ code?: string; detail?: string; title?: string }> };
  };
  const telnyxError = e.raw?.errors?.[0];
  return {
    detail: telnyxError?.detail ?? e.message ?? 'unknown error',
    code: telnyxError?.code,
    statusCode: e.statusCode,
  };
}

async function sendSms(
  to: string,
  from: string,
  message: string,
  clinicId: string,
  messageType: string,
): Promise<SmsResult | null> {
  if (to === from) {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'smsService',
      message: 'SMS skipped — source and destination are the same number',
      clinicId,
      messageType,
      number: to,
      timestamp: new Date().toISOString(),
    }));
    return null;
  }

  try {
    const client = new Telnyx(config.telnyxApiKey);
    // The telnyx package type definitions are incorrect for messages.create —
    // cast through unknown to work around the broken MessagesCreateParams type.
    const createFn = client.messages.create.bind(client.messages) as unknown as (
      params: { from: string; to: string; text: string }
    ) => Promise<{ data: { id?: string; to?: Array<{ status?: string }> } }>;
    const response = await createFn({ from, to, text: message });

    const messageId: string = response.data.id ?? '';
    const status: string = response.data.to?.[0]?.status ?? 'sent';

    // Persist log row — omit to_number in INSERT (privacy) using only allowed columns
    await query(
      `INSERT INTO sms_logs (clinic_id, message_type, to_number, status, telnyx_message_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [clinicId, messageType, to, status, messageId],
    );

    console.info(JSON.stringify({
      level: 'info',
      service: 'smsService',
      message: 'SMS sent',
      clinicId,
      messageType,
      messageId,
      timestamp: new Date().toISOString(),
    }));

    return { messageId, status };
  } catch (err: unknown) {
    const { detail, code, statusCode } = extractErrorDetail(err);
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'smsService',
      message: 'SMS send failed',
      clinicId,
      messageType,
      statusCode,
      errorCode: code,
      error: detail,
      timestamp: new Date().toISOString(),
    }));
    // Always persist a log row (status='failed') so audit trail exists
    try {
      await query(
        `INSERT INTO sms_logs (clinic_id, message_type, to_number, status, telnyx_message_id)
         VALUES ($1, $2, $3, 'failed', NULL)`,
        [clinicId, messageType, to],
      );
    } catch {
      // ignore secondary failure
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public named functions
// ---------------------------------------------------------------------------

export async function sendConfirmationSms(
  clinicId: string,
  patientPhone: string,
  patientName: string,
  date: string,
  time: string,
  clinicName: string,
): Promise<void> {
  try {
    const from = await getClinicFromNumber(clinicId);
    const text = `Hi ${patientName}, your appointment at ${clinicName} is confirmed for ${date} at ${time}. To cancel, reply CANCEL.`;
    await sendSms(patientPhone, from, text, clinicId, 'appointment_confirmation');
  } catch (err: unknown) {
    const { detail, code, statusCode } = extractErrorDetail(err);
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'smsService',
      message: 'sendConfirmationSms failed',
      clinicId,
      messageType: 'appointment_confirmation',
      statusCode,
      errorCode: code,
      error: detail,
      timestamp: new Date().toISOString(),
    }));
  }
}

export async function sendFormLinkSms(
  clinicId: string,
  patientPhone: string,
  formUrl: string,
): Promise<void> {
  try {
    const from = await getClinicFromNumber(clinicId);
    const text = `Please complete your intake form before your visit: ${formUrl}`;
    await sendSms(patientPhone, from, text, clinicId, 'intake_form_link');
  } catch (err: unknown) {
    const { detail, code, statusCode } = extractErrorDetail(err);
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'smsService',
      message: 'sendFormLinkSms failed',
      clinicId,
      messageType: 'intake_form_link',
      statusCode,
      errorCode: code,
      error: detail,
      timestamp: new Date().toISOString(),
    }));
  }
}

export async function sendReminderSms(
  clinicId: string,
  patientPhone: string,
  date: string,
  time: string,
  clinicName: string,
): Promise<void> {
  try {
    const from = await getClinicFromNumber(clinicId);
    const text = `Reminder: Your appointment at ${clinicName} is tomorrow at ${time}. Reply CANCEL to cancel.`;
    await sendSms(patientPhone, from, text, clinicId, 'appointment_reminder');
  } catch (err: unknown) {
    const { detail, code, statusCode } = extractErrorDetail(err);
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'smsService',
      message: 'sendReminderSms failed',
      clinicId,
      messageType: 'appointment_reminder',
      statusCode,
      errorCode: code,
      error: detail,
      timestamp: new Date().toISOString(),
    }));
  }
}

export async function sendCancellationSms(
  clinicId: string,
  patientPhone: string,
  date: string,
  time: string,
  clinicName: string,
): Promise<void> {
  try {
    const from = await getClinicFromNumber(clinicId);
    const text = `Your appointment at ${clinicName} on ${date} at ${time} has been cancelled.`;
    await sendSms(patientPhone, from, text, clinicId, 'appointment_cancellation');
  } catch (err: unknown) {
    const { detail, code, statusCode } = extractErrorDetail(err);
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'smsService',
      message: 'sendCancellationSms failed',
      clinicId,
      messageType: 'appointment_cancellation',
      statusCode,
      errorCode: code,
      error: detail,
      timestamp: new Date().toISOString(),
    }));
  }
}
