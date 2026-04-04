require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

const fromNumber = '+19257097010';
const toNumber = '+1YOUR_ACTUAL_NUMBER';  // Replace with your actual number
const message = 'Test SMS from AI Receptionist - ' + new Date().toISOString();

console.log('Sending SMS from:', fromNumber);
console.log('Sending SMS to:', toNumber);
console.log('Message:', message);

telnyx.messages.create({
  from: fromNumber,
  to: toNumber,
  text: message
})
.then(response => {
  console.log('✅ SMS sent!');
  console.log('Message ID:', response.data.id);
  console.log('Status:', response.data.status);
})
.catch(error => {
  console.error('❌ Error:', error.message);
  if (error.response) {
    console.error('Details:', error.response.data);
  }
});
