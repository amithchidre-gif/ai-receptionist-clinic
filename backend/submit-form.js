const token = require('fs').readFileSync('token.txt', 'utf8').trim();
const axios = require('axios');

const formData = {
  token: token,
  responses: {
    reason_for_visit: "Annual checkup",
    current_medications: "None",
    allergies: "None",
    insurance_provider: "Blue Cross",
    insurance_member_id: "BC123456"
  }
};

axios.post('http://localhost:4000/api/forms/submit', formData)
  .then(response => {
    console.log('✅ Form submitted successfully');
    console.log('Response:', response.data);
  })
  .catch(error => {
    console.error('❌ Error:', error.response?.data || error.message);
  });
