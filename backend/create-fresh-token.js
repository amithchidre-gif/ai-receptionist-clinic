require('dotenv').config();
const { createFormToken } = require('./src/services/formTokenService');

async function createToken() {
  const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
  
  // Get the most recent appointment that hasn't had form completed yet
  const { query } = require('./src/config/db');
  const appointment = await query(`
    SELECT a.id, a.patient_id, p.name 
    FROM appointments a
    JOIN patients p ON a.patient_id = p.id
    WHERE a.clinic_id = $1 
      AND a.form_completed = false
    ORDER BY a.created_at DESC
    LIMIT 1
  `, [clinicId]);
  
  if (appointment.rows.length === 0) {
    console.log('No pending appointments found. Creating a new appointment...');
    
    // Get a patient
    const patient = await query(`
      SELECT id FROM patients WHERE clinic_id = $1 LIMIT 1
    `, [clinicId]);
    
    if (patient.rows.length === 0) {
      console.log('No patient found. Creating one...');
      await query(`
        INSERT INTO patients (clinic_id, name, phone, date_of_birth)
        VALUES ($1, 'Sarah Johnson', '+19255497652', '01/15/1990')
      `, [clinicId]);
    }
    
    // Get patient ID again
    const newPatient = await query(`
      SELECT id FROM patients WHERE clinic_id = $1 LIMIT 1
    `, [clinicId]);
    
    // Create appointment for next week
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const dateStr = nextWeek.toISOString().slice(0, 10);
    
    await query(`
      INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status, reminder_sent)
      VALUES ($1, $2, $3, '10:00', 'scheduled', false)
    `, [clinicId, newPatient.rows[0].id, dateStr]);
    
    // Get the new appointment
    const newAppointment = await query(`
      SELECT a.id, a.patient_id, p.name 
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      WHERE a.clinic_id = $1 
        AND a.form_completed = false
      ORDER BY a.created_at DESC
      LIMIT 1
    `, [clinicId]);
    
    const appt = newAppointment.rows[0];
    const token = await createFormToken({ 
      clinicId, 
      appointmentId: appt.id, 
      patientId: appt.patient_id 
    });
    console.log('TOKEN:', token);
    console.log('Appointment ID:', appt.id);
    console.log('Patient:', appt.name);
  } else {
    const appt = appointment.rows[0];
    const token = await createFormToken({ 
      clinicId, 
      appointmentId: appt.id, 
      patientId: appt.patient_id 
    });
    console.log('TOKEN:', token);
    console.log('Appointment ID:', appt.id);
    console.log('Patient:', appt.name);
  }
  
  process.exit(0);
}

createToken().catch(console.error);
