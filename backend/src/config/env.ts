import dotenv from "dotenv";
import path from "path";
import fs from "fs";

const envPath = path.resolve(process.cwd(), '.env');
const envExists = fs.existsSync(envPath);
console.log(`[env.ts] cwd: ${process.cwd()}`);
console.log(`[env.ts] .env path: ${envPath}`);
console.log(`[env.ts] .env exists: ${envExists}`);

console.log(`[env.ts] DATABASE_URL before dotenv: ${process.env.DATABASE_URL ?? '(not set)'}`);

const dotenvResult = dotenv.config({ path: envPath, override: true });

if (dotenvResult.error) {
  console.error(`[env.ts] dotenv parse ERROR: ${dotenvResult.error.message}`);
} else {
  const parsed = dotenvResult.parsed ?? {};
  console.log(`[env.ts] dotenv parsed ${Object.keys(parsed).length} keys: ${Object.keys(parsed).join(', ')}`);
  const maskedParsed = (parsed.DATABASE_URL ?? '(not in file)').replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
  console.log(`[env.ts] dotenv file DATABASE_URL: ${maskedParsed}`);
}

const rawDbUrl = process.env.DATABASE_URL ?? '(not set)';
const maskedDbUrl = rawDbUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
console.log(`[env.ts] DATABASE_URL: ${maskedDbUrl}`);
console.log(`[env.ts] INWORLD_API_KEY set: ${!!process.env.INWORLD_API_KEY}`);

// Support Google credentials stored as JSON string in env (for Render/cloud deployments)
// Set GOOGLE_CREDENTIALS_JSON to the full JSON content of the service account file
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_CREDENTIALS_JSON) {
  const credPath = path.join('/tmp', 'google-credentials.json');
  try {
    fs.writeFileSync(credPath, process.env.GOOGLE_CREDENTIALS_JSON, 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
    console.log(`[env.ts] Google credentials written to ${credPath}`);
  } catch (e) {
    console.warn(`[env.ts] Failed to write Google credentials: ${(e as Error).message}`);
  }
}

// Warn about missing vars but don't crash — service will start and log warnings
const recommended = [
  "DATABASE_URL",
  "JWT_SECRET",
  "TELNYX_API_KEY",
  "DEEPGRAM_API_KEY",
  "INWORLD_API_KEY",
  "OPENROUTER_API_KEY",
  "FRONTEND_URL",
];

for (const key of recommended) {
  if (!process.env[key]) {
    console.warn(`[env.ts] WARNING: ${key} is not set. Related features will not work.`);
  }
}

if (!process.env.DATABASE_URL) {
  console.warn('[env.ts] WARNING: DATABASE_URL is not set. Database operations will fail until this is configured in Render dashboard.');
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'changeme-set-in-render-dashboard',
  telnyxApiKey: process.env.TELNYX_API_KEY ?? '',
  telnyxPublicKey: process.env.TELNYX_PUBLIC_KEY ?? '',
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? '',
  inworldApiKey: process.env.INWORLD_API_KEY ?? '',
  inworldVoiceId: process.env.INWORLD_VOICE_ID ?? 'Ashley',
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  openrouterModel: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  baseUrl: process.env.BASE_URL ?? 'http://localhost:4000',
  port: parseInt(process.env.PORT ?? '4000', 10),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  nodeEnv: process.env.NODE_ENV ?? 'development',
};
