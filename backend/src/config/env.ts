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

const required = [
  "DATABASE_URL",
  "JWT_SECRET",
  "TELNYX_API_KEY",
  "DEEPGRAM_API_KEY",
  "INWORLD_API_KEY",
  "OPENROUTER_API_KEY",
  "FRONTEND_URL",
] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

export const config = {
  databaseUrl: process.env.DATABASE_URL as string,
  jwtSecret: process.env.JWT_SECRET as string,
  telnyxApiKey: process.env.TELNYX_API_KEY as string,
  telnyxPublicKey: process.env.TELNYX_PUBLIC_KEY ?? "",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY as string,
  inworldApiKey: process.env.INWORLD_API_KEY as string,
  inworldVoiceId: process.env.INWORLD_VOICE_ID ?? 'Ashley',
  openrouterApiKey: process.env.OPENROUTER_API_KEY as string,
  openrouterModel: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS as string,
  frontendUrl: process.env.FRONTEND_URL as string,
  baseUrl: process.env.BASE_URL ?? "http://localhost:4000",
  port: parseInt(process.env.PORT ?? "4000", 10),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  nodeEnv: process.env.NODE_ENV ?? "development",
};
