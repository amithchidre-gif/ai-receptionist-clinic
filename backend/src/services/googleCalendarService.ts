import { google, calendar_v3 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/env';
import { query } from '../config/db';

const GOOGLE_API_TIMEOUT_MS = 10_000; // 10 s max per rules.md

// Wrap any Google API promise with an AbortController-backed timeout
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Google Calendar API timeout (${label}) after ${GOOGLE_API_TIMEOUT_MS}ms`));
    }, GOOGLE_API_TIMEOUT_MS);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface CalendarSlot {
  date: string;           // "YYYY-MM-DD"
  time: string;           // "HH:MM"
  durationMinutes: number;
}

export interface CalendarEvent {
  eventId: string;
  calendarLink: string;
  startDateTime: string;  // ISO 8601
}

export interface CreateEventParams {
  clinicId: string;
  slot: CalendarSlot;
  summary?: string;       // defaults to 'Appointment' — do NOT pass patient name
  description?: string;
  timeZone?: string;      // IANA timezone string, e.g. 'America/Chicago'
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function resolveCredentialsPath(): string {
  const raw = config.googleApplicationCredentials;
  if (!raw) throw new Error('GOOGLE_APPLICATION_CREDENTIALS env var is not set');
  const resolved = path.resolve(raw); // handle relative paths like ./google-calendar-sa.json
  if (!fs.existsSync(resolved)) {
    throw new Error(`Service account key file not found: ${resolved}`);
  }
  return resolved;
}

/** Returns true only if the credentials file is present and readable. */
export function hasCalendarCredentials(): boolean {
  try {
    resolveCredentialsPath();
    return true;
  } catch {
    return false;
  }
}

function slotToIso(date: string, time: string): string {
  return `${date}T${time}:00`;
}

function getAuth(): GoogleAuth {
  const keyFile = resolveCredentialsPath(); // throws early with clear message if missing
  return new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

async function getCalendarClient(): Promise<calendar_v3.Calendar> {
  const auth = getAuth();
  return google.calendar({ version: 'v3', auth });
}

// ─── Exported functions ───────────────────────────────────────────────────────

export async function getClinicCalendarId(clinicId: string): Promise<string> {
  const result = await query(
    `SELECT google_calendar_id FROM clinic_settings WHERE clinic_id = $1`,
    [clinicId],
  );

  const calendarId: string | null = result.rows[0]?.google_calendar_id ?? null;

  if (!calendarId) {
    throw new Error(`Google Calendar not configured for clinic ${clinicId}`);
  }

  return calendarId;
}

export async function checkSlotAvailable(
  clinicId: string,
  slot: CalendarSlot,
): Promise<boolean> {
  try {
    const calendarId = await getClinicCalendarId(clinicId);
    const calendar = await getCalendarClient();

    const timeZone = 'UTC';
    const startIso = slotToIso(slot.date, slot.time);
    const endDate = new Date(`${startIso}Z`);
    endDate.setMinutes(endDate.getMinutes() + slot.durationMinutes);
    const endIso = endDate.toISOString().replace(/\.\d{3}Z$/, '');

    const response = await withTimeout(
      calendar.freebusy.query({
        requestBody: {
          timeMin: `${startIso}Z`,
          timeMax: `${endIso}Z`,
          timeZone,
          items: [{ id: calendarId }],
        },
      }),
      'freebusy.query',
    );

    const busy = response.data.calendars?.[calendarId]?.busy ?? [];
    return busy.length === 0;
  } catch (err: unknown) {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'googleCalendarService',
      message: 'checkSlotAvailable error — failing open',
      clinicId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    return true; // fail open — never block a booking due to calendar error
  }
}

export async function createCalendarEvent(
  params: CreateEventParams,
): Promise<CalendarEvent> {
  const { clinicId, slot, summary = 'Appointment', description, timeZone = 'UTC' } = params;

  try {
    const calendarId = await getClinicCalendarId(clinicId);
    const calendar = await getCalendarClient();

    const startIso = slotToIso(slot.date, slot.time);
    const endDate = new Date(`${startIso}Z`);
    endDate.setMinutes(endDate.getMinutes() + slot.durationMinutes);
    const endIso = endDate.toISOString().replace(/\.\d{3}Z$/, '');

    const response = await withTimeout(
      calendar.events.insert({
        calendarId,
        requestBody: {
          summary,
          description,
          start: { dateTime: `${startIso}Z`, timeZone },
          end:   { dateTime: `${endIso}Z`,   timeZone },
        },
      }),
      'events.insert',
    );

    const eventId = response.data.id ?? '';
    const calendarLink = response.data.htmlLink ?? '';

    console.info(JSON.stringify({
      level: 'info',
      service: 'googleCalendarService',
      message: 'Calendar event created',
      clinicId,
      eventId,
      timestamp: new Date().toISOString(),
    }));

    return {
      eventId,
      calendarLink,
      startDateTime: response.data.start?.dateTime ?? `${startIso}Z`,
    };
  } catch (err: unknown) {
    const error = err as Error;
    console.error(JSON.stringify({
      level: 'error',
      service: 'googleCalendarService',
      message: 'createCalendarEvent failed',
      clinicId,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw err;
  }
}

export async function cancelCalendarEvent(
  clinicId: string,
  eventId: string,
): Promise<void> {
  try {
    const calendarId = await getClinicCalendarId(clinicId);
    const calendar = await getCalendarClient();

    await withTimeout(
      calendar.events.delete({ calendarId, eventId }),
      'events.delete',
    );

    console.info(JSON.stringify({
      level: 'info',
      service: 'googleCalendarService',
      message: 'Calendar event cancelled',
      clinicId,
      eventId,
      timestamp: new Date().toISOString(),
    }));
  } catch (err: unknown) {
    // Log warning but never throw — missing calendar event must not break the app flow
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'googleCalendarService',
      message: 'cancelCalendarEvent failed — continuing',
      clinicId,
      eventId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
  }
}
