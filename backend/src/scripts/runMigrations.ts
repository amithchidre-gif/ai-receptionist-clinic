import fs from 'fs';
import path from 'path';
import '../config/env'; // validates required env vars on startup
import { pool, query } from '../config/db';

async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn('Skipping migrations: DATABASE_URL is not set. Set it in Render dashboard.');
    return;
  }

  const migrationsDir = path.join(__dirname, '..', 'migrations');

  let files: string[];
  try {
    files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // alphabetical = 001, 002, ...
  } catch (error) {
    const err = error as Error;
    console.error('Failed to read migrations directory:', err.message);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log('No migration files found.');
    process.exit(0);
  }

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    console.log(`Running migration: ${file}`);

    let sql: string;
    try {
      sql = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      const err = error as Error;
      console.error(`Failed to read migration file ${file}:`, err.message);
      process.exit(1);
    }

    try {
      await query(sql);
      console.log(`✓ Migration complete: ${file}`);
    } catch (error) {
      const err = error as Error;
      console.error(`✗ Migration failed: ${file} — ${err.message}`);
      process.exit(1);
    }
  }

  console.log('All migrations completed successfully.');
  await pool.end();
}

runMigrations();
