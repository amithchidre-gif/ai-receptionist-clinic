require('dotenv').config();
const { upsertPatient } = require('./src/models/patientModel');

const clinicId = '78de52b5-3895-4824-b970-2676eb668293';

async function testUpsert() {
  console.log('=== Testing upsertPatient ===\n');
  
  try {
    const result = await upsertPatient(
      clinicId,
      'Sarah Johnson',
      '555-123-4567',
      '01/15/1990'
    );
    
    console.log('✅ upsertPatient succeeded');
    console.log('   Patient ID:', result.id);
    console.log('   Is New:', result.isNew);
    console.log('   Name:', result.name);
    
  } catch (error) {
    console.error('❌ upsertPatient failed:', error.message);
  }
  
  process.exit(0);
}

testUpsert();
