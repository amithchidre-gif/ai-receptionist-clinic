require('dotenv').config();
const { createFormToken } = require('./src/services/formTokenService');

async function createToken() {
  const clinicId = '78de52b5-3895-4824-b970-2676eb668293';
  const appointmentId = 'e2c508e9-538a-4dea-955f-f2249733bfeb';
  const patientId = 'eea2b9e8-278c-4b1a-bae0-6f19098aa4b0';
  
  const token = await createFormToken({ clinicId, appointmentId, patientId });
  console.log('NEW TOKEN:', token);
  process.exit(0);
}

createToken().catch(console.error);
