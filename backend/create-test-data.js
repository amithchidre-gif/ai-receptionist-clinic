require('dotenv').config();
const { query } = require('./src/config/db');

async function createTestData() {
  const clinicId = 'bbb44629-da9b-480a-91a2-6cff9c8c891c';
  
  // Create a test patient
  await query(\
    INSERT INTO patients (clinic_id, name, phone, date_of_birth)
    VALUES (\, 'Test Patient', '+19255551234', '1985-03-15')
  \, [clinicId]);
  
  // Get the patient ID
  const patient = await query(\
    SELECT id FROM patients WHERE clinic_id = \ LIMIT 1
  \, [clinicId]);
  
  // Create a test appointment for today
  const today = new Date().toISOString().slice(0, 10);
  await query(\
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status)
    VALUES (\, \, \, '10:00', 'scheduled')
  \, [clinicId, patient.rows[0].id, today]);
  
  console.log('✅ Test data created!');
  process.exit(0);
}

createTestData().catch(console.error);
