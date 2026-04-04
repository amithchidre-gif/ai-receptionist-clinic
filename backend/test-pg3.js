const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'ai_receptionist',
  user: 'postgres',
  // No password
});

pool.query('SELECT 1 as test', (err, res) => {
  if (err) {
    console.error('Connection failed:', err.message);
  } else {
    console.log('Connection successful!', res.rows[0]);
  }
  pool.end();
});
