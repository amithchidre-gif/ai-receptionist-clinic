/**
 * write-env-defaults.js
 * Runs during the build step (before tsc) on Render.
 * Writes fallback values into .env for any required vars not already
 * injected by the Render environment. Render dashboard values always win
 * because we only write a key if it is absent from process.env.
 */
const fs   = require('fs');
const path = require('path');

const DEFAULTS = {
  JWT_SECRET: '2db93f8f02ee2b821a6b7516304f87191a892955bcc2167bdee2f531104e9d00',
};

const envPath = path.join(__dirname, '.env');
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const lines = [];

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (process.env[key]) {
    console.log(`[write-env-defaults] ${key} already set via environment — skipping`);
  } else {
    // Only write if not already present in the .env file
    const alreadyInFile = existing.split('\n').some(l => l.startsWith(`${key}=`));
    if (!alreadyInFile) {
      lines.push(`${key}=${value}`);
      console.log(`[write-env-defaults] Writing default for ${key}`);
    }
  }
}

if (lines.length > 0) {
  fs.writeFileSync(envPath, existing + lines.join('\n') + '\n');
  console.log('[write-env-defaults] .env updated with defaults.');
} else {
  console.log('[write-env-defaults] No defaults needed.');
}
