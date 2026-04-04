'use strict';
const bcrypt = require('bcrypt');
const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const hash = await bcrypt.hash('Password123', 10);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const result = await client.query(
    'UPDATE users SET password_hash=$1 WHERE email=$2',
    [hash, 'admin@testclinic.com']
  );
  await client.end();
  console.log(`Updated ${result.rowCount} row(s). Hash starts: ${hash.substring(0,20)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
