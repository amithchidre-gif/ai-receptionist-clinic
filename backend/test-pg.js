const { Pool } = require('pg');
require('dotenv').config();

console.log('Testing connection with:', process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.query('SELECT 1 as test', (err, res) => {
  if (err) {
    console.error('Connection failed:', err.message);
  } else {
    console.log('Connection successful!', res.rows[0]);
  }
  pool.end();
});
