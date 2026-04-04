require('dotenv').config();
const { createFormToken } = require('./src/services/formTokenService');

const clinicId = 'bbb44629-da9b-480a-91a2-6cff9c8c891c';
const appointmentId = '25ae62e9-7566-4251-8d01-a9db179c834b';
const patientId = '20c418eb-76c2-4e21-b760-546b074a9da3';

createFormToken({ clinicId, appointmentId, patientId })
  .then(token => {
    console.log(token);
    process.exit(0);
  })
  .catch(e => {
    console.error(e.message);
    process.exit(1);
  });
