import { query } from '../config/db';

async function main() {
  const r = await query(
    'SELECT session_data FROM conversation_sessions ORDER BY updated_at DESC LIMIT 1'
  );
  console.log(JSON.stringify(r.rows[0]?.session_data, null, 2));
  process.exit(0);
}

main();
