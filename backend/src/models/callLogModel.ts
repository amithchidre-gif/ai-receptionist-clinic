import { query } from '../config/db';

export interface CallLog {
  id: string;
  clinicId: string;
  patientId: string | null;
  callControlId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  status: string;
  durationSeconds: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

function rowToCallLog(row: Record<string, unknown>): CallLog {
  return {
    id: row.id as string,
    clinicId: row.clinic_id as string,
    patientId: (row.patient_id as string) ?? null,
    callControlId: (row.call_control_id as string) ?? null,
    fromNumber: (row.from_number as string) ?? null,
    toNumber: (row.to_number as string) ?? null,
    status: row.status as string,
    durationSeconds: (row.duration_seconds as number) ?? null,
    startedAt: row.started_at ? new Date(row.started_at as string) : null,
    endedAt: row.ended_at ? new Date(row.ended_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

export async function createCallLog(
  clinicId: string,
  fromNumber: string,
  toNumber: string,
  callControlId: string,
): Promise<CallLog> {
  const result = await query(
    `INSERT INTO call_logs (clinic_id, call_control_id, from_number, to_number, status, started_at)
     VALUES ($1, $2, $3, $4, 'in_progress', NOW())
     RETURNING *`,
    [clinicId, callControlId, fromNumber, toNumber],
  );
  return rowToCallLog(result.rows[0]);
}

export async function getCallLogByControlId(callControlId: string): Promise<CallLog | null> {
  const result = await query(
    `SELECT * FROM call_logs WHERE call_control_id = $1 LIMIT 1`,
    [callControlId],
  );
  if (result.rows.length === 0) return null;
  return rowToCallLog(result.rows[0]);
}

export async function updateCallLogComplete(callControlId: string, clinicId: string): Promise<void> {
  await query(
    `UPDATE call_logs
     SET status = 'completed',
         ended_at = NOW(),
         duration_seconds = EXTRACT(EPOCH FROM NOW() - started_at)::INTEGER
     WHERE call_control_id = $1 AND clinic_id = $2`,
    [callControlId, clinicId],
  );
}

export async function updateCallLogLatency(
  callLogId: string,
  clinicId: string,
  avgLatencyMs: number,
  turnCount: number,
): Promise<void> {
  await query(
    `UPDATE call_logs
     SET avg_latency_ms = $1,
         turn_count     = $2
     WHERE id = $3 AND clinic_id = $4`,
    [avgLatencyMs, turnCount, callLogId, clinicId],
  );
}

export async function getCallLogs(clinicId: string, limit = 100): Promise<CallLog[]> {
  const result = await query(
    `SELECT id, clinic_id, patient_id, call_control_id, from_number, to_number,
            CASE WHEN status NOT IN ('completed', 'missed', 'in_progress')
                 THEN 'completed' ELSE status END AS status,
            duration_seconds, started_at, ended_at, created_at
     FROM call_logs
     WHERE clinic_id = $1
     ORDER BY started_at DESC NULLS LAST, created_at DESC
     LIMIT $2`,
    [clinicId, limit],
  );
  return result.rows.map(rowToCallLog);
}
