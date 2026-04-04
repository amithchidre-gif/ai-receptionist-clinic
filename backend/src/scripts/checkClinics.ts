import dotenv from 'dotenv';
dotenv.config();
import { query } from '../config/db';

async function main() {
  const result = await query('SELECT id, name FROM clinics LIMIT 5');
  console.log('Clinics in DB:', JSON.stringify(result.rows, null, 2));
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
