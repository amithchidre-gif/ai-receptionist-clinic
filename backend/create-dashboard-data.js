require('dotenv').config();
const { query } = require('./src/config/db');

async function createTestData() {
  const clinicId = 'bbb44629-da9b-480a-91a2-6cff9c8c891c';
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const lastWeek = new Date();
  lastWeek.setDate(lastWeek.getDate() - 5);
  const lastWeekStr = lastWeek.toISOString().slice(0, 10);
  
  console.log('Creating test data...');
  console.log('Today:', today);
  console.log('Tomorrow:', tomorrowStr);
  
  // Create a test patient
  await query(\
    INSERT INTO patients (clinic_id, name, phone, date_of_birth)
    VALUES (\, 'John Doe', '+19255551234', '1985-03-15')
  \, [clinicId]);
  
  await query(\
    INSERT INTO patients (clinic_id, name, phone, date_of_birth)
    VALUES (\, 'Jane Smith', '+19255554321', '1990-07-22')
  \, [clinicId]);
  
  // Get patient IDs
  const patients = await query(\
    SELECT id FROM patients WHERE clinic_id = \ ORDER BY created_at
  \, [clinicId]);
  
  // Create appointments for today
  await query(\
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status)
    VALUES (\, \, \, '09:00', 'scheduled')
  \, [clinicId, patients.rows[0].id, today]);
  
  await query(\
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status)
    VALUES (\, \, \, '14:00', 'scheduled')
  \, [clinicId, patients.rows[1].id, today]);
  
  // Create appointment for tomorrow
  await query(\
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status)
    VALUES (\, \, \, '10:00', 'scheduled')
  \, [clinicId, patients.rows[0].id, tomorrowStr]);
  
  // Create appointment from last week (should not count in this week)
  await query(\
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status)
    VALUES (\, \, \, '11:00', 'completed')
  \, [clinicId, patients.rows[0].id, lastWeekStr]);
  
  // Create a call log
  await query(\
    INSERT INTO call_logs (clinic_id, session_id, from_number, to_number, status, started_at, duration_seconds)
    VALUES (\, 'test-session-1', '+19255551234', '+19257097010', 'completed', NOW(), 120)
  \, [clinicId]);
  
  await query(\
    INSERT INTO call_logs (clinic_id, session_id, from_number, to_number, status, started_at, duration_seconds)
    VALUES (\, 'test-session-2', '+19255554321', '+19257097010', 'completed', NOW() - INTERVAL '2 hours', 85)
  \, [clinicId]);
  
  console.log('✅ Test data created!');
  console.log('Patients created: 2');
  console.log('Appointments today: 2');
  console.log('Appointments tomorrow: 1');
  console.log('Call logs: 2');
  process.exit(0);
}

createTestData().catch(console.error);
